import { and, asc, eq } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';

import type { Database } from '@/db/client';
import {
  classStudents,
  studentProfiles,
  users,
  type ClassRoom,
  type ClassStudent,
  type User,
} from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { ApiError } from '@/lib/envelope';
import { baseUsername, parseName, resolveUsername } from '@/lib/slugify';
import { revokeAllTokensForUser } from '@/lib/tokens';
import type { ConfirmRosterInput, PreviewRosterInput } from '@/modules/classes/schemas';
import { AuditService } from '@/modules/platform/audit-service';
import type { ClassService } from '@/modules/classes/class-service';

/**
 * Bulk roster provisioning (FULLPLAN §16, §20, §57) — the "Tinkercad way".
 *
 * Two requests on purpose: `previewUsernames()` proposes and **persists nothing**, the
 * counselor edits the list, then `confirmEnrollment()` creates the accounts. There is no
 * student self-registration anywhere in this system, so this service is the *only* thing
 * that ever creates a student.
 */

const MODULE = 'Class';

export interface PreviewedStudent {
  name: string;
  first_name: string;
  last_name: string | null;
  username: string;
}

/** A roster row joined to the student's profile — what `RosterEntry` is on the frontend. */
export interface RosterEntry {
  id: string;
  class_id: string;
  student_id: string;
  username: string;
  status: string;
  joined_at: string | null;
  removed_at: string | null;
  first_name: string | null;
  last_name: string | null;
}

export class ClassEnrollmentService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: Database,
    private readonly classes: ClassService,
  ) {
    this.audit = new AuditService(db);
  }

  /**
   * Propose a username per pasted name. Writes nothing.
   *
   * Collisions are checked against **this class only** (§13.2, §16) — usernames are unique
   * per class, not globally, so the generator never has to consult another class's roster.
   */
  async previewUsernames(
    user: User,
    classId: string,
    input: PreviewRosterInput,
  ): Promise<PreviewedStudent[]> {
    const classRoom = await this.classes.find(user, classId);
    const taken = await this.usernamesTakenIn(classRoom.id);

    return input.names.map((line) => {
      const parsed = parseName(line);

      return {
        name: parsed.name,
        first_name: parsed.firstName,
        last_name: parsed.lastName,
        // Reserves each proposal inside `taken`, so two identical names in one paste come
        // back as `juan.delacruz` and `juan.delacruz2` rather than as the same handle twice.
        username: resolveUsername(baseUsername(parsed), taken),
      };
    });
  }

  /**
   * Create the accounts.
   *
   * The counselor may have edited any username since preview, so every one is re-checked
   * here against the database. **A single collision rejects the whole batch** (§13.2): there
   * is no such thing as a half-provisioned roster, and a partial success would leave the
   * counselor reconciling which of 40 names actually landed.
   */
  async confirmEnrollment(
    user: User,
    classId: string,
    input: ConfirmRosterInput,
    ipAddress: string | null,
  ): Promise<RosterEntry[]> {
    const classRoom = await this.classes.find(user, classId);

    this.rejectDuplicatesWithin(input);
    await this.rejectCollisionsAgainstClass(classRoom, input);

    const timestamp = now();
    const statements: BatchItem<'sqlite'>[] = [];

    for (const student of input.students) {
      const userId = uuid();
      // An empty last name is normalised to NULL rather than stored: `""` and "this person
      // has one name" are not the same claim, and only one of them is true (§13.1).
      const lastName = student.last_name?.trim() ? student.last_name.trim() : null;

      statements.push(
        this.db.insert(users).values({
          id: userId,
          name: [student.first_name, lastName].filter(Boolean).join(' '),
          // Permanently NULL for a student: passwordless by design, and no email either —
          // there is no channel and nothing to send (§38).
          email: null,
          password: null,
          role: 'student',
          status: 'active',
          mustChangePassword: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
        this.db.insert(studentProfiles).values({
          id: uuid(),
          userId,
          firstName: student.first_name,
          lastName,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
        this.db.insert(classStudents).values({
          id: uuid(),
          classId: classRoom.id,
          studentId: userId,
          username: student.username,
          status: 'active',
          joinedAt: timestamp,
          removedAt: null,
        }),
      );
    }

    // D1 has no interactive transactions, so `batch()` is what atomicity looks like here: the
    // statements run in one implicit transaction and roll back together. The unique index on
    // (class_id, username) is the backstop under the checks above — a racing second confirm
    // fails the whole batch rather than half-provisioning the class.
    await this.db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);

    await this.audit.write({
      action: 'ROSTER_STUDENTS_ENROLLED',
      module: MODULE,
      userId: user.id,
      targetType: 'class',
      targetId: classRoom.id,
      newValues: { count: input.students.length },
      ipAddress,
    });

    return this.roster(user, classRoom.id);
  }

  /**
   * A student's **live** enrollment in one class, or `undefined`.
   *
   * The Assessment module authorizes `start` against this rather than against the token (§13.2,
   * `docs/api`): a token is a *session*, an enrollment is a *fact*, and the fact is what decides
   * whether someone may keep working through a class's assessments. Removal revokes their tokens
   * too, but a session that somehow outlived the removal must still not get them in.
   */
  async activeEnrollment(studentId: string, classId: string): Promise<ClassStudent | undefined> {
    const [enrollment] = await this.db
      .select()
      .from(classStudents)
      .where(
        and(
          eq(classStudents.studentId, studentId),
          eq(classStudents.classId, classId),
          eq(classStudents.status, 'active'),
        ),
      )
      .limit(1);

    return enrollment;
  }

  /** Every class a student is currently enrolled in — the scope of "my assignments". */
  async activeClassIdsFor(studentId: string): Promise<string[]> {
    const rows = await this.db
      .select({ classId: classStudents.classId })
      .from(classStudents)
      .where(and(eq(classStudents.studentId, studentId), eq(classStudents.status, 'active')));

    return rows.map((row) => row.classId);
  }

  /** The current roster, ordered by username. Removed students are excluded. */
  async roster(user: User, classId: string): Promise<RosterEntry[]> {
    const classRoom = await this.classes.find(user, classId);

    const rows = await this.db
      .select({
        id: classStudents.id,
        classId: classStudents.classId,
        studentId: classStudents.studentId,
        username: classStudents.username,
        status: classStudents.status,
        joinedAt: classStudents.joinedAt,
        removedAt: classStudents.removedAt,
        firstName: studentProfiles.firstName,
        lastName: studentProfiles.lastName,
      })
      .from(classStudents)
      .leftJoin(studentProfiles, eq(studentProfiles.userId, classStudents.studentId))
      .where(and(eq(classStudents.classId, classRoom.id), eq(classStudents.status, 'active')))
      .orderBy(asc(classStudents.username));

    return rows.map((row) => ({
      id: row.id,
      class_id: row.classId,
      student_id: row.studentId,
      username: row.username,
      status: row.status,
      joined_at: row.joinedAt,
      removed_at: row.removedAt,
      first_name: row.firstName,
      last_name: row.lastName,
    }));
  }

  /**
   * Remove a student from a class. `studentId` is the student's **user id** (§20).
   *
   * The enrollment row is marked `removed` and kept — `class_students` *is* the enrollment
   * history (§13.2) — and the user account is untouched, since the student may be enrolled
   * elsewhere.
   *
   * **Their tokens are revoked in the same batch** (§38, v1.2, audit F-H3). Marking the row
   * removed only closes the front door: a student already signed in holds a bearer token that
   * a roster row's status is never re-consulted by. Removal has to mean removal *now*, not
   * whenever they next happen to sign out. Revoking *every* token rather than one is
   * deliberate — a join already replaces all of a student's tokens, so the two sets are the
   * same set.
   */
  async removeStudent(
    user: User,
    classId: string,
    studentId: string,
    ipAddress: string | null,
  ): Promise<void> {
    const classRoom = await this.classes.find(user, classId);

    const enrollment = await this.db.query.classStudents.findFirst({
      where: and(
        eq(classStudents.classId, classRoom.id),
        eq(classStudents.studentId, studentId),
        eq(classStudents.status, 'active'),
      ),
    });

    // A student id that is not enrolled *here* is a 404 rather than a 403 — the alternative
    // confirms the account exists to a counselor who has no business knowing that.
    if (!enrollment) {
      throw ApiError.notFound('Student not found in this class.');
    }

    await this.db
      .update(classStudents)
      .set({ status: 'removed', removedAt: now() })
      .where(eq(classStudents.id, enrollment.id));

    await revokeAllTokensForUser(this.db, studentId);

    await this.audit.write({
      action: 'ROSTER_STUDENT_REMOVED',
      module: MODULE,
      userId: user.id,
      targetType: 'class',
      targetId: classRoom.id,
      newValues: { student_id: studentId, username: enrollment.username },
      ipAddress,
    });
  }

  // --- internals ---------------------------------------------------------------------

  /** Every username ever used in this class, including removed students' (§13.2). */
  private async usernamesTakenIn(classId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ username: classStudents.username })
      .from(classStudents)
      .where(eq(classStudents.classId, classId));

    return new Set(rows.map((row) => row.username));
  }

  /** Two rows in one payload claiming the same handle is the counselor's own typo. */
  private rejectDuplicatesWithin(input: ConfirmRosterInput): void {
    const seen = new Set<string>();
    const errors: Record<string, string[]> = {};

    input.students.forEach((student, index) => {
      if (seen.has(student.username)) {
        errors[`students.${index}.username`] = [
          `The username "${student.username}" appears more than once in this list.`,
        ];
      }

      seen.add(student.username);
    });

    if (Object.keys(errors).length > 0) {
      throw ApiError.validation(errors);
    }
  }

  private async rejectCollisionsAgainstClass(
    classRoom: ClassRoom,
    input: ConfirmRosterInput,
  ): Promise<void> {
    const taken = await this.usernamesTakenIn(classRoom.id);
    const errors: Record<string, string[]> = {};

    input.students.forEach((student, index) => {
      if (taken.has(student.username)) {
        errors[`students.${index}.username`] = [
          `The username "${student.username}" is already taken in this class.`,
        ];
      }
    });

    if (Object.keys(errors).length > 0) {
      throw ApiError.validation(errors);
    }
  }
}

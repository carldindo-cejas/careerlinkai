import { and, desc, eq, inArray } from 'drizzle-orm';

import type { Database } from '@/db/client';
import {
  classStudents,
  classes,
  gradeLevels,
  shsStrands,
  studentProfiles,
  type GradeLevel,
  type ShsStrand,
  type StudentProfile,
  type User,
} from '@/db/schema';
import { now } from '@/lib/datetime';
import { ApiError } from '@/lib/envelope';
import type { UpdateStudentProfileInput } from '@/modules/assessment/schemas';

/**
 * The student profile (FULLPLAN §13.1, §37) — **the input to Part VII.**
 *
 * It lives in Phase 3 because §27's engine consumes `strand` and the academic signal and no earlier
 * phase owned them (§57, v1.2). That is the whole reason this exists: it is not a settings screen,
 * it is the other half of the recommendation engine's inputs.
 *
 * `first_name` / `last_name` are **not editable here.** They belong to the counselor's roster
 * (§16) — a student renaming themselves would break the roster the counselor confirmed, and the
 * username derived from it. The Zod schema does not accept them; this is not enforced by
 * omission alone.
 *
 * ## Grade level and strand are derived, not entered (migration 0017)
 *
 * They used to be a free-text field and a two-value select the student filled in. They are now FKs
 * into `grade_levels` / `shs_strands`, and their value comes from **the class the counselor
 * enrolled the student in**. A student in Grade 11 – Academic is in that class because a counselor
 * put them there; asking them to also type it is asking for a second, unverified copy of a fact the
 * school already holds.
 *
 * Three rules make that work, and all three live in this file:
 *
 *   1. `syncFromClass` copies the class's two ids onto the profile. It runs at enrollment and
 *      whenever a class is edited, so the two cannot drift.
 *   2. `update` **refuses** — 422, not a silent no-op — an edit to a field the class supplies.
 *      Discarding an edit a student watched themselves make is the data-loss bug the profile
 *      screen's own comments warn about, and a silent discard is the version of it that nobody
 *      reports.
 *   3. Everything writes the text mirror (`grade_level` / `strand`) in the same statement as the
 *      id. §27 and the `programs.recommended_strand` comparison read those columns, and they stay
 *      correct precisely because this class is their only writer.
 *
 * A student in **no** class with a value set keeps both fields editable — that is what makes this a
 * derivation rather than a lockout, and it is what a student joining before their counselor has
 * finished setting the class up actually needs.
 */
export class StudentProfileService {
  constructor(private readonly db: Database) {}

  async forStudent(student: User): Promise<StudentProfile> {
    const [profile] = await this.db
      .select()
      .from(studentProfiles)
      .where(eq(studentProfiles.userId, student.id))
      .limit(1);

    if (profile === undefined) {
      // Roster provisioning is the only thing that creates a student (§16), and it always writes
      // the profile row in the same batch — so a student without one is a broken invariant, not a
      // first-time visitor to be lazily initialized.
      throw ApiError.notFound('Student profile not found.');
    }

    return profile;
  }

  /**
   * The profile plus everything the serializer needs to render it: the two resolved lookup rows,
   * and which fields the student's class is supplying.
   *
   * One method rather than three calls from the route, because "what does this student's profile
   * look like" is one question and answering it in pieces is how a screen ends up rendering a
   * locked field with no explanation of what locked it.
   */
  async viewFor(student: User): Promise<{
    profile: StudentProfile;
    gradeLevel: GradeLevel | null;
    strand: ShsStrand | null;
    derivedFrom: { className: string; gradeLevel: boolean; strand: boolean } | null;
  }> {
    const profile = await this.forStudent(student);
    const source = await this.derivationSourceFor(student.id);
    const [gradeLevel, strand] = await Promise.all([
      this.gradeLevelById(profile.gradeLevelId),
      this.strandById(profile.shsStrandId),
    ]);

    return {
      profile,
      gradeLevel,
      strand,
      derivedFrom:
        source === null
          ? null
          : {
              className: source.className,
              gradeLevel: source.gradeLevelId !== null,
              strand: source.shsStrandId !== null,
            },
    };
  }

  /** Partial. Every field is optional; an explicit `null` clears it. */
  async update(student: User, input: UpdateStudentProfileInput): Promise<StudentProfile> {
    const profile = await this.forStudent(student);
    const source = await this.derivationSourceFor(student.id);

    // Rule 2. Checked before anything is written, and reported per field, so a payload that
    // touches one locked field and three free ones is refused as a whole rather than half-applied.
    const refused: Record<string, string[]> = {};

    if (input.grade_level_id !== undefined && source?.gradeLevelId != null) {
      refused.grade_level_id = [
        `Your grade level is set by your class (${source.className}) and cannot be changed here. Ask your counselor if it is wrong.`,
      ];
    }

    if (input.shs_strand_id !== undefined && source?.shsStrandId != null) {
      refused.shs_strand_id = [
        `Your strand is set by your class (${source.className}) and cannot be changed here. Ask your counselor if it is wrong.`,
      ];
    }

    if (Object.keys(refused).length > 0) {
      throw ApiError.validation(refused, 'Some fields on your profile are set by your class.');
    }

    const patch: Partial<StudentProfile> = { updatedAt: now() };

    // Written out rather than spread, so a field can only be updated if it is *named here*. A
    // blanket spread of the parsed body would silently start accepting any field a future schema
    // change added — including `first_name`, which must never be student-editable.
    if (input.birthdate !== undefined) patch.birthdate = input.birthdate;
    if (input.gender !== undefined) patch.gender = input.gender;
    if (input.math_grade !== undefined) patch.mathGrade = input.math_grade;
    if (input.science_grade !== undefined) patch.scienceGrade = input.science_grade;
    if (input.english_grade !== undefined) patch.englishGrade = input.english_grade;
    if (input.guardian_name !== undefined) patch.guardianName = input.guardian_name;
    if (input.guardian_contact !== undefined) patch.guardianContact = input.guardian_contact;

    // Rule 3: the id and its mirror move together, always. Resolving the row first also validates
    // the id — a uuid that names no lookup row is a 422, not a dangling FK.
    if (input.grade_level_id !== undefined) {
      const row = await this.requireGradeLevel(input.grade_level_id);

      patch.gradeLevelId = row?.id ?? null;
      patch.gradeLevel = row?.name ?? null;
    }

    if (input.shs_strand_id !== undefined) {
      const row = await this.requireStrand(input.shs_strand_id);

      patch.shsStrandId = row?.id ?? null;
      patch.strand = row?.name ?? null;
    }

    await this.db.update(studentProfiles).set(patch).where(eq(studentProfiles.id, profile.id));

    return this.forStudent(student);
  }

  /**
   * Rule 1 — push a class's grade level and strand onto its students' profiles.
   *
   * Called on enrollment (one student) and on class edit (all of them). Both ids are copied
   * together with their mirrors, and a NULL on the class side clears the profile side: a counselor
   * who removes a class's strand is stating that the class no longer has one, and leaving the last
   * value behind on sixty profiles would make that statement quietly false.
   *
   * `studentIds` scopes the write. Passing a single id is the enrollment path; passing none means
   * "every active student in this class" and is the class-edit path.
   */
  async syncFromClass(classId: string, studentIds?: string[]): Promise<number> {
    const [classRoom] = await this.db
      .select({
        gradeLevelId: classes.gradeLevelId,
        shsStrandId: classes.shsStrandId,
      })
      .from(classes)
      .where(eq(classes.id, classId))
      .limit(1);

    if (classRoom === undefined) {
      return 0;
    }

    const [gradeLevel, strand] = await Promise.all([
      this.gradeLevelById(classRoom.gradeLevelId),
      this.strandById(classRoom.shsStrandId),
    ]);

    const targets =
      studentIds ??
      (
        await this.db
          .select({ studentId: classStudents.studentId })
          .from(classStudents)
          .where(and(eq(classStudents.classId, classId), eq(classStudents.status, 'active')))
      ).map((row) => row.studentId);

    if (targets.length === 0) {
      return 0;
    }

    // One statement, not one per student. §45's subrequest budget counts every D1 call, and a
    // class-edit sync over a 60-student roster would be 60 of the 50 a Free-plan request gets.
    // `inArray` with 60 ids is well inside D1's 100-bound-parameter cap (D18); a roster larger
    // than that is chunked by the caller, which is where the batch size is already known.
    await this.db
      .update(studentProfiles)
      .set({
        gradeLevelId: classRoom.gradeLevelId,
        gradeLevel: gradeLevel?.name ?? null,
        shsStrandId: classRoom.shsStrandId,
        strand: strand?.name ?? null,
        updatedAt: now(),
      })
      .where(inArray(studentProfiles.userId, targets));

    return targets.length;
  }

  // --- internals -----------------------------------------------------------------------

  /**
   * The class a student's grade level and strand come from: their **most recent active
   * enrollment** that actually carries one of the two.
   *
   * Most recent rather than first, because a student promoted from Grade 11 to Grade 12 is
   * enrolled in the newer class and the newer class is the true one. A class carrying neither
   * value is skipped rather than returned as an empty source — otherwise joining a class whose
   * counselor has not filled it in yet would lock both fields to blank.
   */
  private async derivationSourceFor(studentId: string): Promise<{
    className: string;
    gradeLevelId: string | null;
    shsStrandId: string | null;
  } | null> {
    const rows = await this.db
      .select({
        className: classes.name,
        gradeLevelId: classes.gradeLevelId,
        shsStrandId: classes.shsStrandId,
      })
      .from(classStudents)
      .innerJoin(classes, eq(classStudents.classId, classes.id))
      .where(
        and(
          eq(classStudents.studentId, studentId),
          eq(classStudents.status, 'active'),
          eq(classes.status, 'active'),
        ),
      )
      .orderBy(desc(classStudents.joinedAt))
      .limit(5);

    return rows.find((row) => row.gradeLevelId !== null || row.shsStrandId !== null) ?? null;
  }

  private async gradeLevelById(id: string | null): Promise<GradeLevel | null> {
    if (id === null) return null;

    const [row] = await this.db.select().from(gradeLevels).where(eq(gradeLevels.id, id)).limit(1);

    return row ?? null;
  }

  private async strandById(id: string | null): Promise<ShsStrand | null> {
    if (id === null) return null;

    const [row] = await this.db.select().from(shsStrands).where(eq(shsStrands.id, id)).limit(1);

    return row ?? null;
  }

  /** NULL clears the field; a non-null id must name a real row or it is a 422. */
  private async requireGradeLevel(id: string | null): Promise<GradeLevel | null> {
    if (id === null) return null;

    const row = await this.gradeLevelById(id);

    if (row === null) {
      throw ApiError.validation({ grade_level_id: ['That grade level does not exist.'] });
    }

    return row;
  }

  private async requireStrand(id: string | null): Promise<ShsStrand | null> {
    if (id === null) return null;

    const row = await this.strandById(id);

    if (row === null) {
      throw ApiError.validation({ shs_strand_id: ['That strand does not exist.'] });
    }

    return row;
  }
}

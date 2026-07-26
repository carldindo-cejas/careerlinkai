import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm';

import type { Database } from '@/db/client';
import { classes, type ClassRoom, type User } from '@/db/schema';
import { applyGlobalAssignments } from '@/events/apply-global-assignments';
import { dispatch } from '@/events/dispatcher';
import { studentJoinCodeTtlDays } from '@/lib/config';
import { uuid } from '@/lib/crypto';
import { daysFromNow, now } from '@/lib/datetime';
import { ApiError, paginate, type PaginatedData } from '@/lib/envelope';
import type { Env } from '@/env';
import { generateJoinCode } from '@/modules/classes/join-code';
import type { CreateClassInput, UpdateClassInput } from '@/modules/classes/schemas';
import { AuditService } from '@/modules/platform/audit-service';
import { authorizeClass } from '@/policies/class';

/**
 * Class CRUD and the join-code lifecycle (FULLPLAN §13.2, §20).
 *
 * The join code is generated **at creation**, before any roster exists (§57), and is never
 * accepted as input on any endpoint — a client that could choose its own code could choose a
 * guessable one, and the code is the entire security boundary for student access (§38).
 */

const MODULE = 'Class';

/**
 * How many times to retry on a join-code collision before giving up.
 *
 * With a 1.36-billion keyspace a collision is already vanishingly unlikely; retrying is what
 * makes it *impossible* to surface as a 500 rather than merely improbable. Five is far past
 * the point where the loop would ever run twice.
 */
const JOIN_CODE_ATTEMPTS = 5;

export class ClassService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: Database,
    private readonly env: Env,
  ) {
    this.audit = new AuditService(db);
  }

  /** The caller's classes; an admin sees every class (§39). */
  async list(user: User, page: number, perPage: number): Promise<PaginatedData<ClassRoom>> {
    const scope =
      user.role === 'admin'
        ? isNull(classes.deletedAt)
        : and(eq(classes.counselorId, user.id), isNull(classes.deletedAt));

    const [total] = await this.db.select({ value: count() }).from(classes).where(scope);

    const items = await this.db
      .select()
      .from(classes)
      .where(scope)
      .orderBy(desc(classes.createdAt))
      .limit(perPage)
      .offset((page - 1) * perPage);

    return paginate(items, total?.value ?? 0, page, perPage);
  }

  /** One class the caller is entitled to. 404 when it is not theirs (§19). */
  async find(user: User, id: string): Promise<ClassRoom> {
    const classRoom = await this.db.query.classes.findFirst({ where: eq(classes.id, id) });

    return authorizeClass(user, classRoom);
  }

  /**
   * Every `active` class in the system, **unauthorized** — the caller must authorize the act.
   *
   * This exists for the Assessment module's global assignment (§11: a module may not query another
   * module's tables, so it goes through this Service). It deliberately returns only `active`
   * classes: `draft` classes accept no joins and `archived` ones are finished, so fanning an
   * assessment out to either would create assignments nobody can ever start.
   *
   * Unpaginated on purpose — the caller needs the whole set to write one row per class, and a page
   * of it would silently assign an assessment to the first twenty classes and call that "global".
   */
  async listActive(): Promise<ClassRoom[]> {
    return this.db
      .select()
      .from(classes)
      .where(and(eq(classes.status, 'active'), isNull(classes.deletedAt)))
      .orderBy(desc(classes.createdAt));
  }

  /**
   * Several class rows by id, **unauthorized** — as `findById`, in bulk, so a caller that must
   * authorize twenty classes reads them in one query rather than twenty.
   */
  async findManyByIds(ids: string[]): Promise<ClassRoom[]> {
    if (ids.length === 0) {
      return [];
    }

    return this.db
      .select()
      .from(classes)
      .where(and(inArray(classes.id, ids), isNull(classes.deletedAt)));
  }

  /**
   * The raw class row, **unauthorized** — the caller must authorize it themselves.
   *
   * This exists for the Assessment module (§11: a module may not query another module's tables,
   * so it goes through this Service instead). It cannot use `find()` above, because `find()` runs
   * `ClassPolicy` — which is a *counselor ownership* rule, and would 404 a student asking about
   * the class their own attempt belongs to. The Assessment module needs the class row in order to
   * run `AssessmentPolicy` against it, which is a different question from "do you own this class".
   *
   * Deliberately not exported through any route. If you are calling this, you are responsible for
   * the authorization that `find()` would otherwise have done for you.
   */
  async findById(id: string): Promise<ClassRoom | undefined> {
    return this.db.query.classes.findFirst({ where: eq(classes.id, id) });
  }

  async create(user: User, input: CreateClassInput, ipAddress: string | null): Promise<ClassRoom> {
    const timestamp = now();

    const classRoom: ClassRoom = {
      id: uuid(),
      counselorId: user.id,
      name: input.name,
      academicYear: input.academic_year,
      gradeLevel: input.grade_level ?? null,
      joinCode: await this.uniqueJoinCode(),
      joinCodeExpiresAt: daysFromNow(studentJoinCodeTtlDays(this.env)),
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    };

    await this.db.insert(classes).values(classRoom);

    await this.audit.write({
      action: 'CLASS_CREATED',
      module: MODULE,
      userId: user.id,
      targetType: 'class',
      targetId: classRoom.id,
      newValues: { name: classRoom.name, academic_year: classRoom.academicYear },
      ipAddress,
    });

    /**
     * **A class created after a global assignment still gets it** (v1.5, migration 0014).
     *
     * Through an event rather than a direct call, for two reasons that both matter: the Class module
     * may not query the Assessment module's tables (§11), and this must not be able to fail class
     * creation — `dispatch()` logs and absorbs a throwing listener, so the counselor gets the class
     * they asked for either way, and an administrator re-running "Assign globally" is the recovery.
     *
     * There is no notification fan-out here, and none is missing: a class has no roster at creation.
     * Students join afterwards and see the assignment on their dashboard the moment they do.
     */
    await dispatch(
      { type: 'ClassCreated', classId: classRoom.id, counselorId: user.id },
      [applyGlobalAssignments(this.db)],
    );

    return classRoom;
  }

  /**
   * Update a class. `join_code` is deliberately not updatable here — rotating it is its own
   * endpoint, because it is a revocation, not an edit.
   */
  async update(
    user: User,
    id: string,
    input: UpdateClassInput,
    ipAddress: string | null,
  ): Promise<ClassRoom> {
    const existing = await this.find(user, id);

    const changes = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.academic_year !== undefined ? { academicYear: input.academic_year } : {}),
      ...(input.grade_level !== undefined ? { gradeLevel: input.grade_level } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedAt: now(),
    };

    await this.db.update(classes).set(changes).where(eq(classes.id, existing.id));

    await this.audit.write({
      action: 'CLASS_UPDATED',
      module: MODULE,
      userId: user.id,
      targetType: 'class',
      targetId: existing.id,
      oldValues: { name: existing.name, status: existing.status },
      newValues: { ...input },
      ipAddress,
    });

    return { ...existing, ...changes };
  }

  /** Soft delete (§12). To end a class but keep it visible, PATCH its status to `archived`. */
  async remove(user: User, id: string, ipAddress: string | null): Promise<void> {
    const existing = await this.find(user, id);
    const timestamp = now();

    await this.db
      .update(classes)
      .set({ deletedAt: timestamp, updatedAt: timestamp })
      .where(eq(classes.id, existing.id));

    await this.audit.write({
      action: 'CLASS_DELETED',
      module: MODULE,
      userId: user.id,
      targetType: 'class',
      targetId: existing.id,
      ipAddress,
    });
  }

  /**
   * Issue a fresh code and a fresh expiry. **The previous code stops working immediately** —
   * this is the counselor's revocation mechanism when a code leaks (§38), so it must not be
   * a soft rotation that leaves the old one alive for a grace period.
   */
  async regenerateCode(user: User, id: string, ipAddress: string | null): Promise<ClassRoom> {
    const existing = await this.find(user, id);

    const changes = {
      joinCode: await this.uniqueJoinCode(),
      joinCodeExpiresAt: daysFromNow(studentJoinCodeTtlDays(this.env)),
      updatedAt: now(),
    };

    await this.db.update(classes).set(changes).where(eq(classes.id, existing.id));

    await this.audit.write({
      action: 'CLASS_CODE_REGENERATED',
      module: MODULE,
      userId: user.id,
      targetType: 'class',
      targetId: existing.id,
      // The codes themselves are not recorded: the audit log is read by more people than
      // hold the code, and a rotated-away code is still a code that once opened this class.
      ipAddress,
    });

    return { ...existing, ...changes };
  }

  // --- internals ---------------------------------------------------------------------

  private async uniqueJoinCode(): Promise<string> {
    for (let attempt = 0; attempt < JOIN_CODE_ATTEMPTS; attempt += 1) {
      const code = generateJoinCode();

      const clash = await this.db.query.classes.findFirst({
        where: eq(classes.joinCode, code),
      });

      if (!clash) {
        return code;
      }
    }

    throw new ApiError(500, 'Could not allocate a unique join code.');
  }
}

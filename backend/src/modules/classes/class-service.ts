import { and, count, desc, eq, isNull } from 'drizzle-orm';

import type { Database } from '@/db/client';
import { classes, type ClassRoom, type User } from '@/db/schema';
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

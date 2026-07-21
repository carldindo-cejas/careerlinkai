import { and, count, desc, eq, inArray, isNull, like, or } from 'drizzle-orm';

import type { Database } from '@/db/client';
import type { UserStatus } from '@/db/enums';
import {
  classStudents,
  classes,
  counselorProfiles,
  users,
  type CounselorProfile,
  type User,
} from '@/db/schema';
import type { Env } from '@/env';
import { staffAuthGuard } from '@/lib/auth-guard';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { translateUniqueViolation } from '@/lib/db-errors';
import { ApiError, paginate, type PaginatedData } from '@/lib/envelope';
import { revokeAllTokensForUser } from '@/lib/tokens';
import type { CreateCounselorInput, UpdateCounselorInput } from '@/modules/identity/schemas';
import { AuditService } from '@/modules/platform/audit-service';

/**
 * Counselor management (FULLPLAN §20 "Counselor management", Phase 6) — the admin's four
 * endpoints over the one role that can read every enrolled student's results.
 *
 * Account creation follows the seeder's §38 shape exactly: the service **generates** the
 * temporary password (an admin-typed one would end up in chat logs and sticky notes), hands
 * the plaintext back exactly once in the creation response, stores only the `AuthGuardDO`
 * hash, and sets `must_change_password` — so the first login forces a rotation and the
 * admin-known credential dies at activation (§13.1).
 */

const MODULE = 'Identity';

/**
 * The generated temporary password: 12 characters from an alphabet without I/O/0/1/l, with
 * every §38 character class guaranteed by construction. Same rejection-sampling rule as the
 * join-code generator — `byte % length` would skew toward the alphabet's first letters.
 */
const UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const LOWER = 'abcdefghjkmnpqrstuvwxyz';
const DIGITS = '23456789';
const TEMP_PASSWORD_LENGTH = 12;

function randomIndex(bound: number): number {
  const cap = Math.floor(256 / bound) * bound;
  const byte = new Uint8Array(1);

  for (;;) {
    crypto.getRandomValues(byte);

    if (byte[0]! < cap) {
      return byte[0]! % bound;
    }
  }
}

function pick(alphabet: string): string {
  return alphabet[randomIndex(alphabet.length)]!;
}

export function generateTemporaryPassword(): string {
  const all = UPPER + LOWER + DIGITS;
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS)];

  while (chars.length < TEMP_PASSWORD_LENGTH) {
    chars.push(pick(all));
  }

  // Fisher–Yates, so the guaranteed classes are not always the first three characters.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }

  return chars.join('');
}

export interface CounselorView {
  user: User;
  profile: CounselorProfile;
  classesCount: number;
  studentsCount: number;
}

export interface CounselorListFilters {
  page: number;
  perPage: number;
  search?: string;
  status?: UserStatus;
}

export class CounselorManagementService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: Database,
    private readonly env: Env,
  ) {
    this.audit = new AuditService(db);
  }

  /** Live counselors, newest first, with their class/student footprint for the admin list. */
  async list(filters: CounselorListFilters): Promise<PaginatedData<CounselorView>> {
    const conditions = [eq(users.role, 'counselor' as const), isNull(users.deletedAt)];

    if (filters.status !== undefined) {
      conditions.push(eq(users.status, filters.status));
    }

    if (filters.search !== undefined && filters.search !== '') {
      // `LIKE` is case-insensitive for ASCII in SQLite, which is the behaviour wanted here.
      const term = `%${filters.search}%`;
      conditions.push(or(like(users.name, term), like(users.email, term))!);
    }

    const where = and(...conditions);

    const [rows, [total]] = await Promise.all([
      this.db
        .select()
        .from(users)
        .innerJoin(counselorProfiles, eq(counselorProfiles.userId, users.id))
        .where(where)
        .orderBy(desc(users.createdAt), desc(users.id))
        .limit(filters.perPage)
        .offset((filters.page - 1) * filters.perPage),
      this.db
        .select({ value: count() })
        .from(users)
        .innerJoin(counselorProfiles, eq(counselorProfiles.userId, users.id))
        .where(where),
    ]);

    const counselorIds = rows.map((row) => row.users.id);
    const footprints = await this.footprintsFor(counselorIds);

    return paginate(
      rows.map((row) => ({
        user: row.users,
        profile: row.counselor_profiles,
        classesCount: footprints.get(row.users.id)?.classes ?? 0,
        studentsCount: footprints.get(row.users.id)?.students ?? 0,
      })),
      total?.value ?? 0,
      filters.page,
      filters.perPage,
    );
  }

  /**
   * Create a counselor account with a generated temporary password. The plaintext is
   * returned to the caller exactly once and never persisted or logged.
   */
  async create(
    admin: User,
    input: CreateCounselorInput,
    ipAddress: string | null,
  ): Promise<{ view: CounselorView; temporaryPassword: string }> {
    const email = input.email.trim().toLowerCase();

    // The DB unique index on email covers soft-deleted rows too, so the check must as well:
    // a 500 from the index would tell the admin nothing actionable, and a "deleted" user's
    // email genuinely is still taken (their audit history references the account).
    const existing = await this.db.query.users.findFirst({ where: eq(users.email, email) });

    if (existing !== undefined) {
      throw ApiError.validation({ email: ['This email address is already in use.'] });
    }

    const temporaryPassword = generateTemporaryPassword();
    // The counselor's own per-email DO instance derives the hash, same as every §38 path.
    const passwordHash = await staffAuthGuard(this.env, email).hash(temporaryPassword);

    const timestamp = now();
    const user: User = {
      id: uuid(),
      name: input.name?.trim() ?? `${input.first_name} ${input.last_name}`.trim(),
      email,
      password: passwordHash,
      role: 'counselor',
      status: 'active',
      mustChangePassword: true,
      emailVerifiedAt: null,
      lastLoginAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    };

    const profile: CounselorProfile = {
      id: uuid(),
      userId: user.id,
      firstName: input.first_name,
      lastName: input.last_name,
      phone: input.phone ?? null,
      employeeNumber: input.employee_number ?? null,
      specialization: input.specialization ?? null,
      bio: input.bio ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    // One transaction: a user without their profile is a row the rest of the system
    // (login's profile join, the roster views) does not expect to encounter.
    try {
      await this.db.batch([
        this.db.insert(users).values(user),
        this.db.insert(counselorProfiles).values(profile),
      ]);
    } catch (error) {
      // The email pre-check above and the derivation below open a wide race window (M8): the
      // hash is derived *before* the write, so two admins creating the same email can both pass
      // the pre-check. `users_email_unique` is what actually holds the invariant; the loser must
      // get the same 422 the pre-check gives, not a raw 500 (H4).
      translateUniqueViolation(error, 'email', 'This email address is already in use.');
    }

    await this.audit.write({
      action: 'COUNSELOR_CREATED',
      module: MODULE,
      userId: admin.id,
      targetType: 'user',
      targetId: user.id,
      newValues: { email, name: user.name },
      ipAddress,
    });

    return {
      view: { user, profile, classesCount: 0, studentsCount: 0 },
      temporaryPassword,
    };
  }

  /** Update account fields and/or profile fields. A non-counselor id 404s (see `find`). */
  async update(
    admin: User,
    counselorId: string,
    input: UpdateCounselorInput,
    ipAddress: string | null,
  ): Promise<CounselorView> {
    const { user, profile } = await this.find(counselorId);
    const timestamp = now();

    const nextUser: User = {
      ...user,
      name: input.name?.trim() ?? user.name,
      status: input.status ?? user.status,
      updatedAt: timestamp,
    };

    const nextProfile: CounselorProfile = {
      ...profile,
      firstName: input.first_name ?? profile.firstName,
      lastName: input.last_name ?? profile.lastName,
      phone: input.phone !== undefined ? input.phone : profile.phone,
      employeeNumber:
        input.employee_number !== undefined ? input.employee_number : profile.employeeNumber,
      specialization:
        input.specialization !== undefined ? input.specialization : profile.specialization,
      bio: input.bio !== undefined ? input.bio : profile.bio,
      updatedAt: timestamp,
    };

    await this.db.batch([
      this.db
        .update(users)
        .set({ name: nextUser.name, status: nextUser.status, updatedAt: timestamp })
        .where(eq(users.id, user.id)),
      this.db
        .update(counselorProfiles)
        .set({
          firstName: nextProfile.firstName,
          lastName: nextProfile.lastName,
          phone: nextProfile.phone,
          employeeNumber: nextProfile.employeeNumber,
          specialization: nextProfile.specialization,
          bio: nextProfile.bio,
          updatedAt: timestamp,
        })
        .where(eq(counselorProfiles.id, profile.id)),
    ]);

    // Suspension needs no explicit revocation: `authenticate` rejects any live token the
    // moment its user leaves `active` (§38, verified since Step 1). The audit row records
    // the status transition because that is the part someone will ask about.
    await this.audit.write({
      action: 'COUNSELOR_UPDATED',
      module: MODULE,
      userId: admin.id,
      targetType: 'user',
      targetId: user.id,
      oldValues: { status: user.status },
      newValues: { status: nextUser.status },
      ipAddress,
    });

    const footprints = await this.footprintsFor([user.id]);

    return {
      user: nextUser,
      profile: nextProfile,
      classesCount: footprints.get(user.id)?.classes ?? 0,
      studentsCount: footprints.get(user.id)?.students ?? 0,
    };
  }

  /**
   * Soft delete (§12) + immediate token revocation. The counselor's classes and their
   * students' history stay — removing an account is not shredding the records it produced.
   * An admin cannot arrive here for themselves: `find` only resolves counselors.
   */
  async remove(admin: User, counselorId: string, ipAddress: string | null): Promise<void> {
    const { user } = await this.find(counselorId);
    const timestamp = now();

    await this.db
      .update(users)
      .set({ deletedAt: timestamp, status: 'inactive', updatedAt: timestamp })
      .where(eq(users.id, user.id));

    await revokeAllTokensForUser(this.db, user.id);

    await this.audit.write({
      action: 'COUNSELOR_DELETED',
      module: MODULE,
      userId: admin.id,
      targetType: 'user',
      targetId: user.id,
      oldValues: { email: user.email, name: user.name },
      ipAddress,
    });
  }

  // --- internals ---------------------------------------------------------------------

  /** A live counselor or a 404 — an admin or student id is "not found", not "forbidden". */
  private async find(counselorId: string): Promise<{ user: User; profile: CounselorProfile }> {
    const [row] = await this.db
      .select()
      .from(users)
      .innerJoin(counselorProfiles, eq(counselorProfiles.userId, users.id))
      .where(
        and(eq(users.id, counselorId), eq(users.role, 'counselor'), isNull(users.deletedAt)),
      )
      .limit(1);

    if (row === undefined) {
      throw ApiError.notFound('Counselor not found.');
    }

    return { user: row.users, profile: row.counselor_profiles };
  }

  /** Live classes and active enrollments per counselor, in two grouped queries (no N+1). */
  private async footprintsFor(
    counselorIds: string[],
  ): Promise<Map<string, { classes: number; students: number }>> {
    const footprints = new Map<string, { classes: number; students: number }>();

    if (counselorIds.length === 0) {
      return footprints;
    }

    const classCounts = await this.db
      .select({ counselorId: classes.counselorId, value: count() })
      .from(classes)
      .where(and(inArray(classes.counselorId, counselorIds), isNull(classes.deletedAt)))
      .groupBy(classes.counselorId);

    const studentCounts = await this.db
      .select({ counselorId: classes.counselorId, value: count() })
      .from(classStudents)
      .innerJoin(classes, eq(classStudents.classId, classes.id))
      .where(
        and(
          inArray(classes.counselorId, counselorIds),
          isNull(classes.deletedAt),
          eq(classStudents.status, 'active'),
        ),
      )
      .groupBy(classes.counselorId);

    for (const id of counselorIds) {
      footprints.set(id, { classes: 0, students: 0 });
    }

    for (const row of classCounts) {
      footprints.get(row.counselorId)!.classes = row.value;
    }

    for (const row of studentCounts) {
      footprints.get(row.counselorId)!.students = row.value;
    }

    return footprints;
  }
}

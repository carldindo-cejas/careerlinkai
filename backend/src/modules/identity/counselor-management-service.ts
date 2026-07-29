import { and, count, desc, eq, inArray, isNull, like, or } from 'drizzle-orm';

import type { Database } from '@/db/client';
import type { UserStatus } from '@/db/enums';
import {
  classStudents,
  classes,
  counselorProfiles,
  passwordResetTokens,
  studentProfiles,
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
import {
  RecommendationService,
  type RecommendationSet,
} from '@/modules/recommendation/recommendation-service';

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

/**
 * One row of the counselor students table (§20, prompt-driven): a student assigned to the
 * counselor, their profile signals, their latest RIASEC Holland Code, and their current
 * recommendation set (hydrated — the table shows the top of each and expands to the top five).
 */
export interface CounselorStudentView {
  id: string;
  name: string;
  gradeLevel: string | null;
  strand: string | null;
  hollandCode: string | null;
  recommendations: RecommendationSet | null;
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
   * The counselor's assigned students, each with their profile signals, latest Holland Code, and
   * hydrated recommendation set (§20 "Counselor management", prompt-driven students view).
   *
   * "Assigned" means enrolled (active) in one of the counselor's live classes — the same
   * relationship §4 grants a counselor read access over. A student in two of the counselor's
   * classes appears once (`selectDistinct`). The roster is bounded (a counselor's classes hold
   * tens of students, not thousands), so it is returned whole and the table search/sort/paginate
   * happens client-side; the expensive part — hydrating every student's recommendations — is done
   * in a fixed handful of queries here (`setsForStudents`, `hollandCodesForStudents`), never per
   * student.
   */
  async studentsFor(
    counselorId: string,
  ): Promise<{ user: User; profile: CounselorProfile; students: CounselorStudentView[] }> {
    const { user, profile } = await this.find(counselorId);

    const enrolled = await this.db
      .selectDistinct({ studentId: classStudents.studentId })
      .from(classStudents)
      .innerJoin(classes, eq(classStudents.classId, classes.id))
      .where(
        and(
          eq(classes.counselorId, user.id),
          isNull(classes.deletedAt),
          eq(classStudents.status, 'active'),
        ),
      );

    const studentIds = enrolled.map((row) => row.studentId);

    if (studentIds.length === 0) {
      return { user, profile, students: [] };
    }

    const profileRows = await this.db
      .select({
        id: users.id,
        name: users.name,
        firstName: studentProfiles.firstName,
        lastName: studentProfiles.lastName,
        gradeLevel: studentProfiles.gradeLevel,
        strand: studentProfiles.strand,
      })
      .from(users)
      .leftJoin(studentProfiles, eq(studentProfiles.userId, users.id))
      .where(and(inArray(users.id, studentIds), isNull(users.deletedAt)));

    const recommendation = new RecommendationService(this.db);
    const [hollandCodes, sets] = await Promise.all([
      recommendation.hollandCodesForStudents(studentIds),
      recommendation.setsForStudents(studentIds),
    ]);

    const students = profileRows
      .map((row): CounselorStudentView => {
        // Prefer the profile's own name; fall back to the account name (a student who joined with a
        // username but has not completed their profile).
        const profileName = [row.firstName, row.lastName].filter(Boolean).join(' ').trim();

        return {
          id: row.id,
          name: profileName.length > 0 ? profileName : row.name,
          gradeLevel: row.gradeLevel,
          strand: row.strand,
          hollandCode: hollandCodes.get(row.id) ?? null,
          recommendations: sets.get(row.id) ?? null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return { user, profile, students };
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
  /**
   * Reset a counselor's password to a fresh generated temporary one (audit C2).
   *
   * ## Why this endpoint has to exist
   *
   * Before it, a counselor who forgot their password was **permanently locked out**, and the three
   * facts that composed into that dead end were each individually reasonable:
   *
   *   1. `POST /auth/forgot-password` returns the reset token only when `APP_ENV === 'local'`.
   *   2. `password_reset_tokens` stores only the SHA-256 *hash* — the plaintext is unrecoverable
   *      by anyone, an administrator included.
   *   3. v1 has no email channel at all (§5 defers email/SMS/push; deviation D7), so there is
   *      nothing to deliver a link with.
   *
   * The forgot-password screen told the user "an administrator completes the reset and gives you
   * the reset code", and no mechanism existed by which an administrator could obtain that code.
   * The only real recovery was hand-written SQL against production D1.
   *
   * ## Why it mirrors `create` rather than the reset-token flow
   *
   * This deliberately reuses the §13.1 activation shape that already works: the service
   * **generates** the password (an admin-typed one ends up in chat logs and sticky notes), returns
   * the plaintext exactly once, persists only the `AuthGuardDO` hash, and sets
   * `must_change_password` — so the admin-known credential dies the moment the counselor uses it.
   * Reviving the token flow instead would have meant building an out-of-band delivery channel for
   * a token, which is the same problem one layer removed.
   *
   * Every session is revoked, and both guards are cleared: a locked-out counselor whose lockout
   * window is still open must not be handed a working password they then cannot use, and a stale
   * forgot-password throttle must not outlive the credential it was throttling.
   */
  async resetPassword(
    admin: User,
    counselorId: string,
    ipAddress: string | null,
  ): Promise<{ view: CounselorView; temporaryPassword: string }> {
    const { user, profile } = await this.find(counselorId);

    const temporaryPassword = generateTemporaryPassword();
    const guard = staffAuthGuard(this.env, user.email ?? user.id);
    const passwordHash = await guard.hash(temporaryPassword);
    const timestamp = now();

    await this.db
      .update(users)
      .set({ password: passwordHash, mustChangePassword: true, updatedAt: timestamp })
      .where(eq(users.id, user.id));

    // A rotated credential must not leave old sessions alive (§38) — the same rule the
    // self-service change-password path follows.
    await revokeAllTokensForUser(this.db, user.id);

    // Clear the login lockout: the whole point of this act is to give the counselor a way back in,
    // and leaving a 15-minute lockout standing would defeat it for no security gain — the
    // credential the lockout was protecting no longer exists.
    await guard.clear();

    // Any pending reset token for this email is now meaningless and must not remain usable.
    if (user.email !== null) {
      await this.db
        .delete(passwordResetTokens)
        .where(eq(passwordResetTokens.email, user.email.toLowerCase()));
    }

    // The plaintext is **never** written here — not in `newValues`, not in a log line. The audit
    // row records that a reset happened and who did it, which is the part someone will ask about.
    await this.audit.write({
      action: 'COUNSELOR_PASSWORD_RESET',
      module: MODULE,
      userId: admin.id,
      targetType: 'user',
      targetId: user.id,
      newValues: { must_change_password: true },
      ipAddress,
    });

    const footprints = await this.footprintsFor([user.id]);

    return {
      view: {
        user: { ...user, mustChangePassword: true, updatedAt: timestamp },
        profile,
        classesCount: footprints.get(user.id)?.classes ?? 0,
        studentsCount: footprints.get(user.id)?.students ?? 0,
      },
      temporaryPassword,
    };
  }

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

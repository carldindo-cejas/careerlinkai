import { and, eq, isNull } from 'drizzle-orm';

import type { Database } from '@/db/client';
import {
  counselorProfiles,
  passwordResetTokens,
  users,
  type CounselorProfile,
  type User,
} from '@/db/schema';
import type { AuthGuardDO } from '@/do/auth-guard';
import type { Env } from '@/env';
import {
  LOGIN_LOCKOUT_LIMIT,
  LOGIN_LOCKOUT_WINDOW_SECONDS,
  staffAuthGuard,
} from '@/lib/auth-guard';
import { STAFF_TOKEN_TTL_HOURS } from '@/lib/config';
import { generateToken, hashToken } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { ApiError } from '@/lib/envelope';
import { issueToken, revokeAllTokensForUser, revokeToken } from '@/lib/tokens';
import type { ChangePasswordInput, LoginInput, ResetPasswordInput } from '@/modules/identity/schemas';
import { AuditService } from '@/modules/platform/audit-service';

/**
 * Staff authentication — email + password (FULLPLAN §38).
 *
 * Deliberately separate from `StudentAccessService` (Step 2): the two flows never share a
 * code path, only the token *mechanism* they both end at. §38 calls this split
 * architectural, and the surest way to keep it that way is that neither service imports
 * the other.
 *
 * v1.5 (Phase 4.5): every password derivation and every lockout count goes through the
 * per-email `AuthGuardDO` instance — the same object does both, which is what makes the
 * count exact and brute force per-account serialized (§38). KV is off this path entirely
 * (deviation D19, closed).
 */

const MODULE = 'Identity';

/** A password reset link is short-lived — an hour is long enough to read an email. */
const RESET_TOKEN_TTL_MINUTES = 60;

export interface LoginResult {
  user: User;
  counselorProfile: CounselorProfile | null;
  token: string;
}

export class StaffAuthenticationService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: Database,
    private readonly env: Env,
  ) {
    this.audit = new AuditService(db);
  }

  /**
   * Verify credentials and issue a bearer token.
   *
   * Order matters: the lockout is checked *before* the password is verified, so a locked
   * account cannot be probed at all, and only failures are charged (§38) — a user who
   * mistypes twice then succeeds walks away with a clean counter. Check, derivation and
   * charge all land on the same per-email DO instance.
   */
  async login(input: LoginInput, ipAddress: string | null): Promise<LoginResult> {
    const email = input.email.trim().toLowerCase();
    const guard = staffAuthGuard(this.env, email);

    const lockout = await guard.check(LOGIN_LOCKOUT_LIMIT);

    if (lockout.locked) {
      throw this.lockoutError(lockout.retryAfterSeconds);
    }

    const user = await this.db.query.users.findFirst({
      where: and(eq(users.email, email), isNull(users.deletedAt)),
    });

    // Students have `password IS NULL` permanently (§38), so they can never satisfy
    // the verification — but the role check makes the intent explicit rather than relying
    // on that as a happy accident.
    const isStaff = user?.role === 'admin' || user?.role === 'counselor';
    const passwordMatches = isStaff && (await guard.verify(input.password, user.password));

    if (!user || !isStaff || !passwordMatches) {
      return this.rejectLogin(email, guard, user?.id ?? null, ipAddress);
    }

    // The credentials were right, so saying *why* access is refused leaks nothing the
    // caller has not already proven they are entitled to know — and a silent generic 401
    // here would send a suspended counselor to their IT department for the wrong reason.
    if (user.status !== 'active') {
      throw ApiError.forbidden('Your account is not active. Contact an administrator.');
    }

    await guard.clear();

    const timestamp = now();
    await this.db
      .update(users)
      .set({ lastLoginAt: timestamp, updatedAt: timestamp })
      .where(eq(users.id, user.id));

    const { plaintext } = await issueToken(this.db, user.id, STAFF_TOKEN_TTL_HOURS);

    await this.audit.write({
      action: 'STAFF_LOGIN_SUCCESS',
      module: MODULE,
      userId: user.id,
      targetType: 'user',
      targetId: user.id,
      ipAddress,
    });

    return {
      user: { ...user, lastLoginAt: timestamp },
      counselorProfile: await this.counselorProfileFor(user),
      token: plaintext,
    };
  }

  /** The current user, with a counselor's profile attached when there is one. */
  async me(user: User): Promise<{ user: User; counselorProfile: CounselorProfile | null }> {
    return { user, counselorProfile: await this.counselorProfileFor(user) };
  }

  /** Revoke exactly the token this request authenticated with — not the user's other sessions. */
  async logout(user: User, tokenId: string, ipAddress: string | null): Promise<void> {
    await revokeToken(this.db, tokenId);

    await this.audit.write({
      action: 'STAFF_LOGOUT',
      module: MODULE,
      userId: user.id,
      targetType: 'user',
      targetId: user.id,
      ipAddress,
    });
  }

  /**
   * Change a password, clearing `must_change_password` — this *is* the activation step for
   * an admin-issued temporary password (§13.1).
   *
   * Every token the user holds is revoked, including the one making this request: a
   * rotated credential must not leave old sessions alive, which is why the frontend signs
   * itself out and re-authenticates afterwards.
   */
  async changePassword(
    user: User,
    input: ChangePasswordInput,
    ipAddress: string | null,
  ): Promise<void> {
    // The double-derivation endpoint — verify the current password, hash the new one — is
    // the exact call pattern that died with error 1102 on the free Worker's 10 ms budget
    // (D14). Both derivations now run on the DO's 30-second budget.
    const guard = this.guardFor(user);

    if (!(await guard.verify(input.current_password, user.password))) {
      throw ApiError.validation({
        current_password: ['Your current password is incorrect.'],
      });
    }

    await this.setPassword(guard, user.id, input.password);
    await revokeAllTokensForUser(this.db, user.id);

    await this.audit.write({
      action: 'STAFF_PASSWORD_CHANGED',
      module: MODULE,
      userId: user.id,
      targetType: 'user',
      targetId: user.id,
      ipAddress,
    });
  }

  /**
   * Begin a password reset.
   *
   * Returns the plaintext token so the caller can decide whether it may ever be shown —
   * v1 has no email channel at all (§5 defers email/SMS/push), so there is nothing to
   * deliver a link *with*. The route exposes the token only when `APP_ENV === 'local'`;
   * everywhere else the response is the same generic acknowledgement whether or not the
   * email exists, and the reset is completed out of band by an admin. This is the honest
   * shape of the feature until a mail provider exists (deviation D7).
   */
  async forgotPassword(email: string, ipAddress: string | null): Promise<string | null> {
    const normalized = email.trim().toLowerCase();

    const user = await this.db.query.users.findFirst({
      where: and(eq(users.email, normalized), isNull(users.deletedAt)),
    });

    if (!user || (user.role !== 'admin' && user.role !== 'counselor')) {
      // Do not record, do not signal. An unknown email and a known one are indistinguishable.
      return null;
    }

    const { plaintext, hash } = await generateToken();

    // One live reset per email: requesting a second link invalidates the first.
    await this.db
      .insert(passwordResetTokens)
      .values({ email: normalized, tokenHash: hash, createdAt: now() })
      .onConflictDoUpdate({
        target: passwordResetTokens.email,
        set: { tokenHash: hash, createdAt: now() },
      });

    await this.audit.write({
      action: 'STAFF_PASSWORD_RESET_REQUESTED',
      module: MODULE,
      userId: user.id,
      targetType: 'user',
      targetId: user.id,
      ipAddress,
    });

    return plaintext;
  }

  /** Complete a password reset. The token is single-use and every session is revoked. */
  async resetPassword(input: ResetPasswordInput, ipAddress: string | null): Promise<void> {
    const email = input.email.trim().toLowerCase();

    const record = await this.db.query.passwordResetTokens.findFirst({
      where: eq(passwordResetTokens.email, email),
    });

    const invalid = ApiError.validation({
      token: ['This password reset link is invalid or has expired.'],
    });

    // Hash unconditionally, before the record is known to exist: doing it inside the
    // comparison would skip the derivation entirely for an unknown email, and the resulting
    // timing difference is an account-enumeration oracle — the exact thing the generic
    // acknowledgement in `forgotPassword` exists to prevent.
    const presentedHash = await hashToken(input.token);

    if (record?.tokenHash !== presentedHash) {
      throw invalid;
    }

    const ageMinutes = (Date.now() - new Date(record.createdAt).getTime()) / 60_000;

    if (ageMinutes > RESET_TOKEN_TTL_MINUTES) {
      await this.db.delete(passwordResetTokens).where(eq(passwordResetTokens.email, email));

      throw invalid;
    }

    const user = await this.db.query.users.findFirst({
      where: and(eq(users.email, email), isNull(users.deletedAt)),
    });

    if (!user) {
      throw invalid;
    }

    const guard = staffAuthGuard(this.env, email);

    await this.setPassword(guard, user.id, input.password);
    await this.db.delete(passwordResetTokens).where(eq(passwordResetTokens.email, email));
    await revokeAllTokensForUser(this.db, user.id);
    await guard.clear();

    await this.audit.write({
      action: 'STAFF_PASSWORD_RESET_COMPLETED',
      module: MODULE,
      userId: user.id,
      targetType: 'user',
      targetId: user.id,
      ipAddress,
    });
  }

  // --- internals ---------------------------------------------------------------------

  /**
   * The user's own guard instance. Staff always have an email; the id fallback exists so a
   * hypothetical email-less row still resolves to *some* stable instance rather than
   * crashing the derivation.
   */
  private guardFor(user: User): DurableObjectStub<AuthGuardDO> {
    return staffAuthGuard(this.env, user.email ?? user.id);
  }

  private async setPassword(
    guard: DurableObjectStub<AuthGuardDO>,
    userId: string,
    password: string,
  ): Promise<void> {
    await this.db
      .update(users)
      .set({
        password: await guard.hash(password),
        mustChangePassword: false,
        updatedAt: now(),
      })
      .where(eq(users.id, userId));
  }

  private async counselorProfileFor(user: User): Promise<CounselorProfile | null> {
    if (user.role !== 'counselor') {
      return null;
    }

    const profile = await this.db.query.counselorProfiles.findFirst({
      where: eq(counselorProfiles.userId, user.id),
    });

    return profile ?? null;
  }

  /**
   * Every failed login ends here: charge the counter, audit it, and return the same 401
   * regardless of whether the email was unknown, the password wrong, or the account a
   * student's. The 429 replaces the 401 only once the counter trips.
   */
  private async rejectLogin(
    email: string,
    guard: DurableObjectStub<AuthGuardDO>,
    userId: string | null,
    ipAddress: string | null,
  ): Promise<never> {
    const failure = await guard.recordFailure(
      LOGIN_LOCKOUT_LIMIT,
      LOGIN_LOCKOUT_WINDOW_SECONDS,
    );

    await this.audit.write({
      action: 'STAFF_LOGIN_FAILED',
      module: MODULE,
      userId,
      targetType: 'user',
      targetId: userId,
      newValues: { email, attempts: failure.attempts },
      ipAddress,
    });

    if (failure.locked) {
      throw this.lockoutError(failure.retryAfterSeconds);
    }

    throw ApiError.unauthenticated('Invalid credentials.');
  }

  /**
   * The lockout response the frontend's LoginPage test pins: a 429 whose message is the
   * generic "Validation failed." with the human-readable detail under `errors.email`.
   */
  private lockoutError(retryAfterSeconds: number): ApiError {
    return ApiError.tooManyRequests({
      email: [`Too many failed login attempts. Try again in ${retryAfterSeconds} seconds.`],
    });
  }
}


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
  FORGOT_PASSWORD_LIMIT,
  FORGOT_PASSWORD_WINDOW_SECONDS,
  forgotPasswordGuard,
  LOGIN_LOCKOUT_LIMIT,
  LOGIN_LOCKOUT_WINDOW_SECONDS,
  staffAuthGuard,
} from '@/lib/auth-guard';
import { staffTokenTtlHours } from '@/lib/config';
import { generateToken, hashToken, timingSafeEqualString } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { ApiError } from '@/lib/envelope';
import { translateUniqueViolation } from '@/lib/db-errors';
import { issueToken, revokeAllTokensForUser, revokeToken } from '@/lib/tokens';
import type {
  ChangeEmailInput,
  ChangePasswordInput,
  LoginInput,
  ResetPasswordInput,
  UpdateAccountInput,
} from '@/modules/identity/schemas';
import { AuditService } from '@/modules/platform/audit-service';
import { sendPasswordResetEmail } from '@/modules/platform/email-service';

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

/**
 * A constant, real 600,000-iteration PBKDF2 hash (of a throwaway password no account uses),
 * verified against when a login resolves no staff account (H3). It exists only to make an
 * unknown-email login pay the **same derivation cost** as a real one, so the two are
 * indistinguishable by stopwatch. It is never a valid credential: the `!isStaff` check rejects
 * the login regardless of the verify result, and no user row carries this hash. Generated once
 * with `hashPassword` (which only runs in workerd); regenerate the same way if ever rotated.
 */
const DUMMY_PASSWORD_HASH =
  'pbkdf2$600000$dZreIrS9fIjHOYU91CWU6g==$EDb7oRae4IDjyuI3UNA93ZRoclko0iNFhyAbwQJhdfI=';

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

    // H3: verify **unconditionally** — against the account's hash when it is staff, else the
    // constant dummy hash — so an unknown or non-staff email pays the same ~600k-iteration
    // derivation as a real login. The old `isStaff && verify(...)` short-circuited the derivation
    // away for a missing user, so an unknown email answered in milliseconds while a real one paid
    // hundreds: account enumeration by stopwatch, on the very endpoint whose siblings
    // (`forgotPassword`, the reset-token compare) already pay to erase exactly this signal. The
    // `!isStaff` guard still rejects a student or unknown even though the dummy verify returns
    // false — it is there for correctness, not timing.
    const passwordMatches = await guard.verify(
      input.password,
      user?.password ?? DUMMY_PASSWORD_HASH,
    );

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

    const { plaintext } = await issueToken(this.db, user.id, staffTokenTtlHours(this.env));

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
   * Edit your own account — the name side of `/counselor/profile` (prompt-driven, 2026-09-20).
   *
   * No password is asked for here, and that is the deliberate line this service draws: a display
   * name, a phone number and a one-line bio are labels on an account, not ways into it. The two
   * things that *are* ways in — the email and the password — each have their own method that
   * re-proves the current password first.
   *
   * **A counselor's `users.name` is derived, never typed.** It is `first_name last_name`, written
   * in the same batch as the profile, because those two fields sit side by side on this very form
   * and a counselor who corrects one and not the other would otherwise be left with a roster
   * saying one thing and a sidebar saying another. An administrator has no counselor profile for
   * the parts to live in, so their `name` is the field they edit directly.
   */
  async updateAccount(
    user: User,
    input: UpdateAccountInput,
    ipAddress: string | null,
  ): Promise<{ user: User; counselorProfile: CounselorProfile | null }> {
    const profile = await this.counselorProfileFor(user);
    const timestamp = now();

    if (profile === null) {
      // An administrator (or a counselor whose profile row is missing): only the display name is
      // editable, and it has to be given — a request that changes nothing is a 422, not a no-op
      // reported as success.
      if (input.name === undefined) {
        throw ApiError.validation({ name: ['A name is required.'] });
      }

      const nextUser: User = { ...user, name: input.name, updatedAt: timestamp };

      await this.db
        .update(users)
        .set({ name: nextUser.name, updatedAt: timestamp })
        .where(eq(users.id, user.id));

      await this.audit.write({
        action: 'STAFF_PROFILE_UPDATED',
        module: MODULE,
        userId: user.id,
        targetType: 'user',
        targetId: user.id,
        oldValues: { name: user.name },
        newValues: { name: nextUser.name },
        ipAddress,
      });

      return { user: nextUser, counselorProfile: null };
    }

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

    const nextUser: User = {
      ...user,
      name: `${nextProfile.firstName} ${nextProfile.lastName}`.trim(),
      updatedAt: timestamp,
    };

    await this.db.batch([
      this.db
        .update(users)
        .set({ name: nextUser.name, updatedAt: timestamp })
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

    await this.audit.write({
      action: 'STAFF_PROFILE_UPDATED',
      module: MODULE,
      userId: user.id,
      targetType: 'user',
      targetId: user.id,
      oldValues: { name: user.name },
      newValues: { name: nextUser.name },
      ipAddress,
    });

    return { user: nextUser, counselorProfile: nextProfile };
  }

  /**
   * Change the address this account signs in with.
   *
   * Four things happen, and each one closes something the others would leave open:
   *
   *   1. **The current password is verified**, on the DO, exactly as `changePassword` does — the
   *      email is the login identifier *and* the reset destination, so changing it is a credential
   *      change wearing a settings-field costume. An unattended session on a staffroom machine is
   *      otherwise one form submission away from becoming somebody else's account.
   *   2. **The new address is checked against every row, soft-deleted ones included**, because
   *      `users_email_unique` covers them and a pre-check that did not would report success and
   *      then 500. The index is still what actually holds the invariant — two requests can both
   *      pass the pre-check — so the write is translated on the way out too.
   *   3. **`email_verified_at` is cleared.** Nothing in this deployment gates on it, but it is the
   *      record of an address having been proven, and this one has not been.
   *   4. **Any pending reset token for the old address is deleted.** A link already mailed to the
   *      mailbox this account just stopped using must not still open it.
   *
   * What deliberately does *not* happen is a session revocation. Nothing the caller holds became
   * less trustworthy — they proved the password a line ago — and signing them out of the tab they
   * are reading the confirmation in is a punishment, not a protection.
   *
   * One consequence is worth naming: the §38 lockout counter is a Durable Object named after the
   * email (`staffAuthGuard`), so the failed-login count starts fresh under the new address. That
   * is the honest behaviour — the counter belongs to the address being attacked, not to the
   * account — and every hash carries its own salt and iteration count, so nothing about
   * verification depends on which instance derived it.
   */
  async changeEmail(
    user: User,
    input: ChangeEmailInput,
    ipAddress: string | null,
  ): Promise<{ user: User; counselorProfile: CounselorProfile | null }> {
    const guard = this.guardFor(user);

    if (!(await guard.verify(input.current_password, user.password))) {
      throw ApiError.validation({
        current_password: ['Your current password is incorrect.'],
      });
    }

    const email = input.email.trim().toLowerCase();

    if (email === (user.email ?? '').toLowerCase()) {
      throw ApiError.validation({
        email: ['That is already the address on this account.'],
      });
    }

    const taken = await this.db.query.users.findFirst({ where: eq(users.email, email) });

    if (taken) {
      throw ApiError.validation({ email: ['This email address is already in use.'] });
    }

    const timestamp = now();
    const nextUser: User = { ...user, email, emailVerifiedAt: null, updatedAt: timestamp };

    try {
      await this.db
        .update(users)
        .set({ email, emailVerifiedAt: null, updatedAt: timestamp })
        .where(eq(users.id, user.id));
    } catch (error) {
      translateUniqueViolation(error, 'email', 'This email address is already in use.');
    }

    if (user.email !== null) {
      await this.db
        .delete(passwordResetTokens)
        .where(eq(passwordResetTokens.email, user.email.toLowerCase()));
    }

    await this.audit.write({
      action: 'STAFF_EMAIL_CHANGED',
      module: MODULE,
      userId: user.id,
      targetType: 'user',
      targetId: user.id,
      oldValues: { email: user.email },
      newValues: { email },
      ipAddress,
    });

    return { user: nextUser, counselorProfile: await this.counselorProfileFor(user) };
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
   * Returns the plaintext token so the caller can decide whether it may ever be shown. The route
   * exposes it only when `APP_ENV === 'local'`; everywhere else the response is the same generic
   * acknowledgement whether or not the email exists.
   *
   * **P4-2 gave this flow a delivery channel, and deliberately did not give it a guarantee.** The
   * reset link is now emailed where the platform can deliver it — but the Free plan (a ratified
   * requirement, FULLPLAN §45) reaches only *verified destination addresses*, so for any staff
   * mailbox that has not been through that one-time step the send is refused and the admin-relay
   * path (C2) remains the route. Both states are normal; see `sendPasswordResetEmail`.
   *
   * What must not change is the **response**. This method's return value is identical whether the
   * mail was delivered, refused, or never attempted, because `/auth/forgot-password` answers a
   * registered and an unregistered address identically by design (§38) — and a delivery failure
   * that altered the response would rebuild the enumeration oracle that design exists to prevent.
   * That is why the outcome below is logged and then dropped on the floor.
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

    // M2: throttle to FORGOT_PASSWORD_LIMIT per window per email, on a DO counter dedicated to this
    // flow (never the login lockout). A throttled request returns the same generic acknowledgement
    // as an unknown email — no enumeration signal — and issues nothing: it does not overwrite the
    // pending token, write an audit row, or mint a new token. This caps the reset-flow DoS and the
    // unauthenticated D1 write amplification that made this the weakest credential endpoint.
    const throttle = await forgotPasswordGuard(this.env, normalized).charge(
      FORGOT_PASSWORD_LIMIT,
      FORGOT_PASSWORD_WINDOW_SECONDS,
    );

    if (throttle.locked) {
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

    // Awaited, not fired into `waitUntil`: the outcome is worth a log line in the same invocation
    // that minted the token, and this call cannot reject (see the function's contract). The
    // returned value is intentionally unused — see this method's doc comment for why branching on
    // it would be a security defect rather than a feature.
    await sendPasswordResetEmail(this.env, {
      to: normalized,
      token: plaintext,
      userId: user.id,
      expiresInMinutes: RESET_TOKEN_TTL_MINUTES,
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

    // M9: constant-time compare of the two hex digests, not `!==` — see `timingSafeEqualString`.
    if (record === undefined || !timingSafeEqualString(record.tokenHash, presentedHash)) {
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

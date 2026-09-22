import { and, eq, isNull } from 'drizzle-orm';

import type { Database } from '@/db/client';
import {
  counselorProfiles,
  passwordResetTokens,
  staffEmailChangeRequests,
  users,
  type CounselorProfile,
  type User,
} from '@/db/schema';
import type { AuthGuardDO } from '@/do/auth-guard';
import type { Env } from '@/env';
import {
  EMAIL_CHANGE_LIMIT,
  EMAIL_CHANGE_VERIFY_LIMIT,
  EMAIL_CHANGE_VERIFY_WINDOW_SECONDS,
  EMAIL_CHANGE_WINDOW_SECONDS,
  emailChangeGuard,
  emailChangeVerifyGuard,
  FORGOT_PASSWORD_LIMIT,
  FORGOT_PASSWORD_WINDOW_SECONDS,
  forgotPasswordGuard,
  LOGIN_LOCKOUT_LIMIT,
  LOGIN_LOCKOUT_WINDOW_SECONDS,
  staffAuthGuard,
} from '@/lib/auth-guard';
import { staffTokenTtlHours } from '@/lib/config';
import {
  generateNumericCode,
  generateToken,
  hashToken,
  timingSafeEqualString,
} from '@/lib/crypto';
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
import {
  sendEmailChangeCodeEmail,
  sendPasswordResetEmail,
} from '@/modules/platform/email-service';
import { NotificationService } from '@/modules/platform/notification-service';

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

/**
 * An email-change code is short-lived for the same reason the signup code is: long enough to
 * switch to a mail app and back, short enough that a code read over somebody's shoulder or left on
 * a shared screen is not a standing key to their login identifier. The same number reaches the
 * email copy and the UI, so neither can drift from the check that enforces it.
 */
export const EMAIL_CHANGE_CODE_TTL_MINUTES = 15;

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

/**
 * A code was issued and mailed. Nothing here is a secret except `code`, which exists **only so
 * the route can decide whether it may ever be shown** — it does so exclusively when
 * `APP_ENV === 'local'`, exactly as `forgotPassword` treats its reset token, which is what lets
 * the flow be exercised end to end in development and by the suite with no mail channel.
 */
export interface EmailChangeCodeIssued {
  /** The address the code went to — echoed back so the UI can name it without trusting its own. */
  email: string;
  code: string;
  expiresInMinutes: number;
}

/** A staged change, as the account page needs it after a reload. Never carries the code. */
export interface PendingEmailChange {
  email: string;
  expiresInMinutes: number;
}

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
   * **Step one of two.** Ask to change the address this account signs in with: prove the password,
   * stage the change, and mail a six-digit code to the **new** address. Nothing about the account
   * moves here.
   *
   * ## Why this is two steps (migration 0039)
   *
   * It used to be one, and the one it was did everything except the thing that matters. A password
   * check answers "is this the account holder"; it cannot answer "does this mailbox exist and does
   * this person read it". Since the address is the login identifier *and* the reset destination
   * (§38), a single mistyped character used to cost the login, the recovery path and the account —
   * irreversibly, since the old address stops working the moment the new one is written. Now a
   * typo costs a code that never arrives, and the account stays exactly where it was.
   *
   * ## The checks, in the order they run and why that order
   *
   *   1. **The password, first.** Everything after it costs mail, database writes, or both, and
   *      none of it should be reachable by somebody sitting at an unattended session.
   *   2. **The throttle, before anything is mailed.** Five codes an hour per account, charged
   *      whether or not the request succeeds — the Resend free tier is a hundred messages a day
   *      shared with password resets, and this endpoint is authenticated but not therefore trusted.
   *   3. **The address is not the current one**, which would otherwise mail a code to confirm a
   *      change to nothing.
   *   4. **The address is free**, soft-deleted rows included, because `users_email_unique` covers
   *      them. Re-checked at commit: this is a courtesy so somebody is not told at step two that
   *      the code they just fetched was pointless, not the thing that holds the invariant.
   *
   * What deliberately does *not* happen: no session is revoked (nothing the caller holds became
   * less trustworthy) and `users.email` is not touched. The account signs in with its old address
   * for as long as this stays unverified, which is what makes abandoning the flow free.
   */
  async requestEmailChange(
    user: User,
    input: ChangeEmailInput,
    ipAddress: string | null,
  ): Promise<EmailChangeCodeIssued> {
    const guard = this.guardFor(user);

    if (!(await guard.verify(input.current_password, user.password))) {
      throw ApiError.validation({
        current_password: ['Your current password is incorrect.'],
      });
    }

    const email = input.email.trim().toLowerCase();

    await this.chargeEmailChangeThrottle(user);

    if (email === (user.email ?? '').toLowerCase()) {
      throw ApiError.validation({
        email: ['That is already the address on this account.'],
      });
    }

    await this.assertEmailFree(email);

    const code = await this.stageEmailChange(user, email);

    await this.audit.write({
      action: 'STAFF_EMAIL_CHANGE_REQUESTED',
      module: MODULE,
      userId: user.id,
      targetType: 'user',
      targetId: user.id,
      oldValues: { email: user.email },
      newValues: { email },
      ipAddress,
    });

    await this.mailEmailChangeCode(user, email, code);

    return { email, code, expiresInMinutes: EMAIL_CHANGE_CODE_TTL_MINUTES };
  }

  /**
   * Issue a **new** code for a change already staged, leaving the destination alone.
   *
   * New rather than re-mailed, because the stored code is a hash and cannot be read back — which
   * is the right property and not an inconvenience. The password is not asked for again: it was
   * proven when the row was staged, the destination cannot be changed here, and re-asking would
   * mean the one action that recovers "the mail never arrived" is also the one that needs the
   * password typed into a page somebody may have walked away from.
   *
   * Returns `null` when nothing is staged (or what is staged has expired), so the route can say so
   * instead of pretending a code is on its way. There is no enumeration concern to balance here:
   * the caller is authenticated and the only account they can ask about is their own.
   */
  async resendEmailChangeCode(
    user: User,
    ipAddress: string | null,
  ): Promise<EmailChangeCodeIssued | null> {
    const staged = await this.liveEmailChange(user);

    if (staged === null) {
      return null;
    }

    await this.chargeEmailChangeThrottle(user);

    // Re-checked, because the address may have been taken by somebody else between the two steps.
    // Better to say so now than to have them fetch a code that cannot be spent.
    await this.assertEmailFree(staged.newEmail);

    const code = await this.stageEmailChange(user, staged.newEmail);

    await this.audit.write({
      action: 'STAFF_EMAIL_CHANGE_REQUESTED',
      module: MODULE,
      userId: user.id,
      targetType: 'user',
      targetId: user.id,
      oldValues: { email: user.email },
      newValues: { email: staged.newEmail, resend: true },
      ipAddress,
    });

    await this.mailEmailChangeCode(user, staged.newEmail, code);

    return {
      email: staged.newEmail,
      code,
      expiresInMinutes: EMAIL_CHANGE_CODE_TTL_MINUTES,
    };
  }

  /**
   * What is waiting on a code, if anything — so the account page can come back to the code step
   * after a reload rather than silently forgetting a change that is still live.
   *
   * That reload is the normal case, not an edge one: the code arrives in a mail client, often on a
   * different device, and coming back to the tab is how people read it.
   *
   * Expired rows are deleted here rather than reported. A code past its TTL is not a pending
   * change, and leaving the row would make the page offer a resend for something the verify step
   * would refuse anyway.
   */
  async pendingEmailChange(user: User): Promise<PendingEmailChange | null> {
    const staged = await this.liveEmailChange(user);

    if (staged === null) {
      return null;
    }

    const elapsed = (Date.now() - new Date(staged.createdAt).getTime()) / 60_000;

    return {
      email: staged.newEmail,
      // Rounded up, so "expires in 1 minute" is never shown for something with seconds left.
      expiresInMinutes: Math.max(1, Math.ceil(EMAIL_CHANGE_CODE_TTL_MINUTES - elapsed)),
    };
  }

  /**
   * Abandon a staged change — the "wrong address, start again" path.
   *
   * Idempotent, and deliberately not an error when there is nothing staged: the button that calls
   * this exists to make the page stop asking for a code, and a 404 in that situation would leave it
   * asking. The failed-guess counter is cleared with the row, because it counted guesses against a
   * code that no longer exists.
   */
  async cancelEmailChange(user: User, ipAddress: string | null): Promise<void> {
    const staged = await this.db.query.staffEmailChangeRequests.findFirst({
      where: eq(staffEmailChangeRequests.userId, user.id),
    });

    if (staged === undefined) {
      return;
    }

    await this.db
      .delete(staffEmailChangeRequests)
      .where(eq(staffEmailChangeRequests.userId, user.id));
    await emailChangeVerifyGuard(this.env, user.id).clear();

    await this.audit.write({
      action: 'STAFF_EMAIL_CHANGE_CANCELLED',
      module: MODULE,
      userId: user.id,
      targetType: 'user',
      targetId: user.id,
      oldValues: { email: staged.newEmail },
      ipAddress,
    });
  }

  /**
   * **Step two of two.** Spend the code and move the address.
   *
   * Four things happen here, and each one closes something the others would leave open:
   *
   *   1. **The guess is capped before the code is compared** (`emailChangeVerifyGuard`, five
   *      failures then fifteen minutes), because six digits is 10^6 and that is not a credential
   *      without a lockout. Checked *before* the comparison, so a locked account cannot be probed
   *      at all — the same ordering as the staff login lockout.
   *   2. **The new address is re-checked against every row, soft-deleted ones included.** The
   *      pre-check at step one can be minutes old and `users_email_unique` covers deleted rows, so
   *      the write is translated on the way out too — the index is what actually holds this.
   *   3. **`email_verified_at` is set**, and this is the one line where the whole feature pays off.
   *      The old single-step flow cleared it, honestly, because nothing had proven the address. A
   *      code that came back from that mailbox is exactly that proof.
   *   4. **Any pending reset token for the old address is deleted.** A link already mailed to the
   *      mailbox this account just stopped using must not still open it.
   *
   * No session is revoked, for the same reason step one revokes none: the caller proved their
   * password at step one and their mailbox at step two, so nothing they hold became less
   * trustworthy, and signing them out of the tab showing the confirmation is a punishment rather
   * than a protection.
   *
   * One consequence is worth naming: the §38 lockout counter is a Durable Object named after the
   * email (`staffAuthGuard`), so the failed-login count starts fresh under the new address. That is
   * the honest behaviour — the counter belongs to the address being attacked, not to the account —
   * and every hash carries its own salt and iteration count, so nothing about verification depends
   * on which instance derived it.
   */
  async verifyEmailChange(
    user: User,
    code: string,
    ipAddress: string | null,
  ): Promise<{ user: User; counselorProfile: CounselorProfile | null }> {
    const guard = emailChangeVerifyGuard(this.env, user.id);
    const lockout = await guard.check(EMAIL_CHANGE_VERIFY_LIMIT);

    if (lockout.locked) {
      throw this.codeLockoutError(lockout.retryAfterSeconds);
    }

    const staged = await this.db.query.staffEmailChangeRequests.findFirst({
      where: eq(staffEmailChangeRequests.userId, user.id),
    });

    const invalid = ApiError.validation({
      code: ['That code is invalid or has expired. Ask for a new one.'],
    });

    // Hashed unconditionally, before the row is known to exist: doing it inside the comparison
    // would skip the derivation when nothing is staged, and the resulting timing difference is a
    // (small) oracle for free — the same reasoning as `resetPassword`.
    const presentedHash = await hashToken(code.trim());

    if (
      staged === undefined ||
      // Constant-time over two hex digests, never `!==`.
      !timingSafeEqualString(staged.codeHash, presentedHash)
    ) {
      return this.rejectEmailChangeCode(guard, invalid);
    }

    const ageMinutes = (Date.now() - new Date(staged.createdAt).getTime()) / 60_000;

    if (ageMinutes > EMAIL_CHANGE_CODE_TTL_MINUTES) {
      await this.db
        .delete(staffEmailChangeRequests)
        .where(eq(staffEmailChangeRequests.userId, user.id));

      // Not charged against the guard: an expired code is the clock's doing, not a guess, and
      // charging it would let somebody lock themselves out by leaving the tab open over lunch.
      throw invalid;
    }

    const email = staged.newEmail;

    await this.assertEmailFree(email);

    const timestamp = now();
    const nextUser: User = { ...user, email, emailVerifiedAt: timestamp, updatedAt: timestamp };

    try {
      await this.db
        .update(users)
        .set({ email, emailVerifiedAt: timestamp, updatedAt: timestamp })
        .where(eq(users.id, user.id));
    } catch (error) {
      translateUniqueViolation(error, 'email', 'This email address is already in use.');
    }

    await this.db
      .delete(staffEmailChangeRequests)
      .where(eq(staffEmailChangeRequests.userId, user.id));
    await guard.clear();

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

    await this.notifyAdministratorsOfEmailChange(user, email);

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
  /**
   * Charge one email-change request against the account's hourly allowance.
   *
   * A **usage** limiter, charged whether or not the request goes on to succeed, because what it
   * protects is the shared mail allowance rather than a secret — a caller who spends five attempts
   * on refused addresses has still spent them. Unlike a wrong password, being told "too many
   * attempts" here reveals nothing: it is a fact about the caller's own recent requests, on their
   * own authenticated account.
   */
  private async chargeEmailChangeThrottle(user: User): Promise<void> {
    const throttle = await emailChangeGuard(this.env, user.id).charge(
      EMAIL_CHANGE_LIMIT,
      EMAIL_CHANGE_WINDOW_SECONDS,
    );

    if (throttle.locked) {
      throw ApiError.tooManyRequests({
        email: [
          `Too many email change requests. Try again in ${throttle.retryAfterSeconds} seconds.`,
        ],
      });
    }
  }

  /**
   * Soft-deleted rows count. `users_email_unique` covers them, so an address belonging to a deleted
   * account is genuinely still taken, and a pre-check that ignored them would report success and
   * then fail on the write.
   */
  private async assertEmailFree(email: string): Promise<void> {
    const taken = await this.db.query.users.findFirst({ where: eq(users.email, email) });

    if (taken) {
      throw ApiError.validation({ email: ['This email address is already in use.'] });
    }
  }

  /**
   * Write (or replace) the staged change and return the plaintext code.
   *
   * One row per user, upserted: a second request replaces the first, so there is never a question
   * of which of two codes is live. `createdAt` moves with the code because the TTL belongs to the
   * code — leaving it would hand out a code that expires in whatever was left of the last one.
   *
   * The failed-guess counter is cleared alongside, for the reason `resend` exists at all: a fresh
   * code deserves a fresh allowance, and carrying a previous code's failures onto it would let a
   * resend inherit a lockout that no longer refers to anything.
   */
  private async stageEmailChange(user: User, email: string): Promise<string> {
    // Six digits — only safe because `emailChangeVerifyGuard` stops at five wrong guesses.
    const code = generateNumericCode(6);
    const codeHash = await hashToken(code);
    const createdAt = now();

    await this.db
      .insert(staffEmailChangeRequests)
      .values({ userId: user.id, newEmail: email, codeHash, createdAt })
      .onConflictDoUpdate({
        target: staffEmailChangeRequests.userId,
        set: { newEmail: email, codeHash, createdAt },
      });

    await emailChangeVerifyGuard(this.env, user.id).clear();

    return code;
  }

  /**
   * The staged change, if there is one that has not expired — and the expired one deleted on the
   * way past, so a dead row cannot make the page offer a resend for something verify would refuse.
   */
  private async liveEmailChange(user: User) {
    const staged = await this.db.query.staffEmailChangeRequests.findFirst({
      where: eq(staffEmailChangeRequests.userId, user.id),
    });

    if (staged === undefined) {
      return null;
    }

    const ageMinutes = (Date.now() - new Date(staged.createdAt).getTime()) / 60_000;

    if (ageMinutes > EMAIL_CHANGE_CODE_TTL_MINUTES) {
      await this.db
        .delete(staffEmailChangeRequests)
        .where(eq(staffEmailChangeRequests.userId, user.id));

      return null;
    }

    return staged;
  }

  /**
   * Awaited rather than fired into `waitUntil`, and its outcome deliberately unused: the sender
   * cannot reject (see its contract in `email-service.ts`), and branching the response on whether
   * the mail was delivered would tell the caller whether an address accepted mail, which is not
   * theirs to learn from an endpoint they can aim anywhere.
   */
  private async mailEmailChangeCode(user: User, email: string, code: string): Promise<void> {
    await sendEmailChangeCodeEmail(this.env, {
      to: email,
      code,
      userId: user.id,
      expiresInMinutes: EMAIL_CHANGE_CODE_TTL_MINUTES,
    });
  }

  /** Charge one wrong guess and throw — the 429 replaces the 422 once the counter trips. */
  private async rejectEmailChangeCode(
    guard: DurableObjectStub<AuthGuardDO>,
    invalid: ApiError,
  ): Promise<never> {
    const failure = await guard.recordFailure(
      EMAIL_CHANGE_VERIFY_LIMIT,
      EMAIL_CHANGE_VERIFY_WINDOW_SECONDS,
    );

    if (failure.locked) {
      throw this.codeLockoutError(failure.retryAfterSeconds);
    }

    throw invalid;
  }

  private codeLockoutError(retryAfterSeconds: number): ApiError {
    return ApiError.tooManyRequests({
      code: [`Too many incorrect codes. Try again in ${retryAfterSeconds} seconds.`],
    });
  }

  /**
   * Tell every administrator that a staff account now answers to a different address (§44's
   * in-app channel, category `ACCOUNT`).
   *
   * **Why this notification exists.** An administrator's picture of who works at the school is the
   * counselor list, and that list is keyed by a name while the thing that actually identifies the
   * account is the email. Before this, a counselor could change theirs and the only trace was an
   * audit row nobody reads until something has already gone wrong. Both addresses are in the
   * message because the old one is what an administrator recognises and the new one is what they
   * will see from now on — a message carrying only the new address would be unreadable to the
   * person it is for.
   *
   * It is sent **after** the commit and its failure cannot undo one. `NotificationService.send`
   * inserts a row and nothing more, but a notification that threw here would roll a completed,
   * audited identity change back into a 500 for the counselor — the same rule §11 applies to every
   * listener, applied by hand because this is a direct call rather than an event.
   */
  private async notifyAdministratorsOfEmailChange(user: User, email: string): Promise<void> {
    try {
      const admins = await this.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, 'admin'), eq(users.status, 'active'), isNull(users.deletedAt)));

      if (admins.length === 0) {
        return;
      }

      await new NotificationService(this.db).sendToMany(
        admins.map((admin) => admin.id),
        {
          title: 'A staff sign-in email changed',
          message: `${user.name} now signs in as ${email}${
            user.email === null ? '' : ` (previously ${user.email})`
          }. They confirmed the new address with a code sent to it.`,
          category: 'ACCOUNT',
        },
      );
    } catch {
      // Swallowed on purpose — see the doc above. The audit row is the durable record of the
      // change; this is the courtesy that rides on top of it.
    }
  }

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

import { eq } from 'drizzle-orm';

import type { Database } from '@/db/client';
import {
  counselorProfiles,
  counselorSignupRequests,
  users,
  type CounselorProfile,
  type User,
} from '@/db/schema';
import type { Env } from '@/env';
import {
  SIGNUP_LIMIT,
  SIGNUP_VERIFY_LIMIT,
  SIGNUP_VERIFY_WINDOW_SECONDS,
  SIGNUP_WINDOW_SECONDS,
  signupThrottleGuard,
  signupVerifyGuard,
  staffAuthGuard,
} from '@/lib/auth-guard';
import { hashToken, timingSafeEqualString, uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { translateUniqueViolation } from '@/lib/db-errors';
import { ApiError } from '@/lib/envelope';
import type { CounselorSignupInput } from '@/modules/identity/schemas';
import { AuditService } from '@/modules/platform/audit-service';
import {
  sendAccountExistsEmail,
  sendCounselorSignupCodeEmail,
} from '@/modules/platform/email-service';
import { SettingsService } from '@/modules/platform/settings-service';

/**
 * Counselor self-signup (migration 0034) — the only way an account is created in this system by
 * somebody who is not already an administrator.
 *
 * ## The shape, and the two things holding it up
 *
 * Step 1 validates, derives the password hash, stages the whole signup in
 * `counselor_signup_requests`, and mails a six-digit code. **No `users` row exists yet** — see the
 * migration for why an unverified signup must not be a `pending` account. Step 2 checks the code
 * and creates the user and their profile in one batch.
 *
 * Two controls make an unauthenticated write endpoint acceptable here, and they are independent on
 * purpose:
 *
 *   1. **The switch.** `counselor_signup_enabled` is off unless an administrator turned it on, and
 *      every entry point re-reads it rather than trusting a value the client was handed earlier.
 *   2. **The throttles.** A per-IP usage limiter charged *before* any work is done, and a
 *      failures-only counter per email that caps code guesses at five. See `lib/auth-guard.ts` for
 *      why each is keyed the way it is.
 *
 * ## What this service refuses to tell the caller
 *
 * Whether the email is already registered. `signup()` returns the same acknowledgement either way
 * (§38's anti-enumeration rule, held everywhere else in this module) — and because that would
 * otherwise strand the real owner of the address in front of a code form forever, the registered
 * case sends *a different email* saying so. Neither branch writes a staged row for an address that
 * is taken, and neither issues a code.
 */

const MODULE = 'Identity';

/**
 * Long enough to switch to a mail app and back, short enough that a code read off a shared screen
 * is not a standing key. The same number reaches the email copy, so the two cannot drift.
 */
export const SIGNUP_CODE_TTL_MINUTES = 15;

const CODE_DIGITS = 6;

/**
 * A uniformly random six-digit code.
 *
 * Rejection sampling, the same rule as the temporary-password and join-code generators: `byte % 10`
 * would make 0–5 more likely than 6–9, which costs roughly a third of a digit of entropy per
 * position. It is a small loss and an entirely free one to avoid.
 *
 * Six digits is 10^6, which is only safe because `signupVerifyGuard` stops at five wrong guesses.
 * Neither number means much without the other.
 */
function generateCode(): string {
  const digits: string[] = [];
  const byte = new Uint8Array(1);
  // 250 = floor(256/10)*10. Bytes at or above it are discarded rather than folded.
  const cap = 250;

  while (digits.length < CODE_DIGITS) {
    crypto.getRandomValues(byte);

    if (byte[0]! < cap) {
      digits.push(String(byte[0]! % 10));
    }
  }

  return digits.join('');
}

export interface SignupResult {
  /**
   * The code, returned **only so the route can decide whether it may ever be shown** — it does so
   * exclusively when `APP_ENV === 'local'`, exactly as `forgotPassword` treats its reset token, so
   * the flow is exercisable end to end in development and by the suite. Null whenever no code was
   * issued (a taken address, or a throttled request), which the route must not distinguish.
   */
  code: string | null;
}

export class CounselorSignupService {
  private readonly audit: AuditService;
  private readonly settings: SettingsService;

  constructor(
    private readonly db: Database,
    private readonly env: Env,
  ) {
    this.audit = new AuditService(db);
    this.settings = new SettingsService(db);
  }

  /** Whether the public form should render at all. Read fresh on every call — see `assertOpen`. */
  async isOpen(): Promise<boolean> {
    return this.settings.get('counselor_signup_enabled');
  }

  /**
   * Begin a signup: validate, derive, stage, and mail a code.
   *
   * The order of the first three steps is the security-relevant part. The throttle is charged
   * before the address is looked up, before the 600,000-iteration derivation, and before anything
   * is mailed — so the expensive half of this method is unreachable without spending one of three
   * hourly attempts.
   */
  async signup(input: CounselorSignupInput, ipAddress: string | null): Promise<SignupResult> {
    await this.assertOpen();

    const email = input.email.trim().toLowerCase();

    // Charged first and unconditionally (see the method doc). A throttled caller gets a 429 rather
    // than the generic acknowledgement: unlike `forgotPassword`, being told "too many attempts"
    // reveals nothing about whether *this* address exists — it is a fact about the caller's own
    // recent requests — and silently accepting a submission that was never processed would leave
    // somebody waiting for an email that is not coming.
    const throttle = await signupThrottleGuard(this.env, ipAddress).charge(
      SIGNUP_LIMIT,
      SIGNUP_WINDOW_SECONDS,
    );

    if (throttle.locked) {
      throw ApiError.tooManyRequests({
        email: [
          `Too many sign-up attempts from this connection. Try again in ${throttle.retryAfterSeconds} seconds.`,
        ],
      });
    }

    // Soft-deleted rows count: `users_email_unique` covers them, so an address belonging to a
    // deleted account is genuinely still taken and staging a signup for it would only produce a
    // failure at verification, after the person had already been mailed a code.
    const existing = await this.db.query.users.findFirst({ where: eq(users.email, email) });

    if (existing !== undefined) {
      // No staged row, no code, no audit row naming this address — and the same return value the
      // success path produces. The mail is what keeps this from being a dead end; its outcome is
      // deliberately dropped, for the reason `forgotPassword` drops its own.
      await sendAccountExistsEmail(this.env, email);

      return { code: null };
    }

    const code = generateCode();
    const [codeHash, passwordHash] = await Promise.all([
      hashToken(code),
      // The account's own per-email DO instance, at the full §38 work factor — the same instance
      // that will later count its login failures. See the migration for why this cannot wait.
      staffAuthGuard(this.env, email).hash(input.password),
    ]);

    // One live signup per address. A second submission replaces the first, so there is never a
    // question of which of two codes is the live one — the same upsert rule as a reset token.
    await this.db
      .insert(counselorSignupRequests)
      .values({
        email,
        codeHash,
        passwordHash,
        firstName: input.first_name,
        lastName: input.last_name,
        phone: input.phone ?? null,
        employeeNumber: input.employee_number ?? null,
        specialization: input.specialization ?? null,
        bio: input.bio ?? null,
        createdAt: now(),
      })
      .onConflictDoUpdate({
        target: counselorSignupRequests.email,
        set: {
          codeHash,
          passwordHash,
          firstName: input.first_name,
          lastName: input.last_name,
          phone: input.phone ?? null,
          employeeNumber: input.employee_number ?? null,
          specialization: input.specialization ?? null,
          bio: input.bio ?? null,
          createdAt: now(),
        },
      });

    // A fresh code deserves a fresh allowance: the five-guess counter is about one code's
    // guessability, and carrying a previous code's failures onto it would let a resend inherit a
    // lockout that no longer refers to anything.
    await signupVerifyGuard(this.env, email).clear();

    await this.audit.write({
      action: 'COUNSELOR_SIGNUP_REQUESTED',
      module: MODULE,
      // NULL: there is no account to attribute this to, and there may never be one.
      userId: null,
      targetType: 'counselor_signup_request',
      targetId: email,
      newValues: { email },
      ipAddress,
    });

    await this.sendCode(email, code);

    return { code };
  }

  /**
   * Re-send the code for a signup already in flight.
   *
   * Issues a **new** code rather than re-mailing the stored one, because the stored one is a hash
   * and cannot be read back — which is the right property and not an inconvenience. Everything else
   * is the staging path over again, minus the derivation: the password the person already chose is
   * kept as-is.
   *
   * The response is identical whether or not a staged signup exists, for the usual reason.
   */
  async resend(email: string, ipAddress: string | null): Promise<SignupResult> {
    await this.assertOpen();

    const normalized = email.trim().toLowerCase();

    const throttle = await signupThrottleGuard(this.env, ipAddress).charge(
      SIGNUP_LIMIT,
      SIGNUP_WINDOW_SECONDS,
    );

    if (throttle.locked) {
      throw ApiError.tooManyRequests({
        email: [
          `Too many sign-up attempts from this connection. Try again in ${throttle.retryAfterSeconds} seconds.`,
        ],
      });
    }

    const staged = await this.db.query.counselorSignupRequests.findFirst({
      where: eq(counselorSignupRequests.email, normalized),
    });

    if (staged === undefined) {
      return { code: null };
    }

    const code = generateCode();

    await this.db
      .update(counselorSignupRequests)
      // `createdAt` moves with the code: the TTL belongs to the code, not to the submission, and
      // leaving it would hand out a code that expires in whatever is left of the original window.
      .set({ codeHash: await hashToken(code), createdAt: now() })
      .where(eq(counselorSignupRequests.email, normalized));

    await signupVerifyGuard(this.env, normalized).clear();
    await this.sendCode(normalized, code);

    return { code };
  }

  /**
   * Complete a signup: check the code, then create the counselor.
   *
   * The account is `active` and `email_verified_at` is set, so the counselor signs in immediately
   * with the password they chose. `must_change_password` is **false**, unlike the admin-created
   * path — there is no admin-known credential here to force out of existence; forcing a rotation
   * would mean asking somebody to change a password they chose thirty seconds ago.
   */
  async verify(email: string, code: string, ipAddress: string | null): Promise<User> {
    await this.assertOpen();

    const normalized = email.trim().toLowerCase();
    const guard = signupVerifyGuard(this.env, normalized);

    // Checked before the code is compared, so a locked signup cannot be probed at all — the same
    // ordering as the staff login lockout.
    const lockout = await guard.check(SIGNUP_VERIFY_LIMIT);

    if (lockout.locked) {
      throw this.lockoutError(lockout.retryAfterSeconds);
    }

    const staged = await this.db.query.counselorSignupRequests.findFirst({
      where: eq(counselorSignupRequests.email, normalized),
    });

    const invalid = ApiError.validation({
      code: ['That code is invalid or has expired. Ask for a new one.'],
    });

    // Hashed unconditionally, before the row is known to exist: doing it inside the comparison
    // would skip the derivation for an unknown email, and the resulting timing difference is an
    // enumeration oracle — the same reasoning as `resetPassword`.
    const presentedHash = await hashToken(code.trim());

    if (
      staged === undefined ||
      // Constant-time over the two hex digests, never `!==`.
      !timingSafeEqualString(staged.codeHash, presentedHash)
    ) {
      return this.rejectCode(guard, invalid);
    }

    const ageMinutes = (Date.now() - new Date(staged.createdAt).getTime()) / 60_000;

    if (ageMinutes > SIGNUP_CODE_TTL_MINUTES) {
      await this.db
        .delete(counselorSignupRequests)
        .where(eq(counselorSignupRequests.email, normalized));

      // Not charged against the guard: an expired code is the clock's doing, not a guess, and
      // charging it would let somebody lock a stranger's signup out by waiting.
      throw invalid;
    }

    const timestamp = now();

    const user: User = {
      id: uuid(),
      name: `${staged.firstName} ${staged.lastName}`.trim(),
      email: normalized,
      password: staged.passwordHash,
      // Every one of these is set here and never read from client input — the `.strict()` schema
      // is the first line of that guarantee and this is the second.
      role: 'counselor',
      status: 'active',
      mustChangePassword: false,
      emailVerifiedAt: timestamp,
      lastLoginAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    };

    const profile: CounselorProfile = {
      id: uuid(),
      userId: user.id,
      firstName: staged.firstName,
      lastName: staged.lastName,
      phone: staged.phone,
      employeeNumber: staged.employeeNumber,
      specialization: staged.specialization,
      bio: staged.bio,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    // One batch, same as admin creation: a user without their profile is a row the login join and
    // every roster view does not expect to meet.
    try {
      await this.db.batch([
        this.db.insert(users).values(user),
        this.db.insert(counselorProfiles).values(profile),
      ]);
    } catch (error) {
      // The address was free when the signup was staged and is not free now — an admin created it
      // in the meantime, or two staged signups for the same address raced to verify. The unique
      // index is what actually holds the invariant; this turns its raw failure into the 422 the
      // pre-check would have given.
      translateUniqueViolation(error, 'email', 'This email address is already in use.');
    }

    await this.db
      .delete(counselorSignupRequests)
      .where(eq(counselorSignupRequests.email, normalized));
    await guard.clear();

    await this.audit.write({
      action: 'COUNSELOR_SIGNUP_COMPLETED',
      module: MODULE,
      userId: user.id,
      targetType: 'user',
      targetId: user.id,
      newValues: { email: normalized, name: user.name },
      ipAddress,
    });

    return user;
  }

  // --- internals ---------------------------------------------------------------------

  /**
   * Re-read the switch on **every** entry point, including the two that follow a step which
   * already checked it.
   *
   * A signup started while registration was open must not be completable after an administrator
   * has closed it: they closed it because something was wrong, and "requests already in flight
   * continue" is exactly the loophole an abuse run would sit in.
   */
  private async assertOpen(): Promise<void> {
    if (!(await this.isOpen())) {
      throw ApiError.forbidden(
        'Counselor sign-up is closed. Ask an administrator to create your account.',
      );
    }
  }

  /**
   * Awaited rather than fired into `waitUntil`, and its outcome deliberately unused: the sender
   * cannot reject (see its contract), and branching the response on whether the mail was delivered
   * would rebuild the enumeration oracle the generic acknowledgement exists to prevent.
   */
  private async sendCode(email: string, code: string): Promise<void> {
    await sendCounselorSignupCodeEmail(this.env, {
      to: email,
      code,
      expiresInMinutes: SIGNUP_CODE_TTL_MINUTES,
    });
  }

  /** Charge one wrong guess and throw — the 429 replaces the 422 once the counter trips. */
  private async rejectCode(
    guard: ReturnType<typeof signupVerifyGuard>,
    invalid: ApiError,
  ): Promise<never> {
    const failure = await guard.recordFailure(
      SIGNUP_VERIFY_LIMIT,
      SIGNUP_VERIFY_WINDOW_SECONDS,
    );

    if (failure.locked) {
      throw this.lockoutError(failure.retryAfterSeconds);
    }

    throw invalid;
  }

  private lockoutError(retryAfterSeconds: number): ApiError {
    return ApiError.tooManyRequests({
      code: [`Too many incorrect codes. Try again in ${retryAfterSeconds} seconds.`],
    });
  }
}

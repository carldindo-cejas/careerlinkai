import { Hono } from 'hono';

import { createDatabase } from '@/db/client';
import type { AppEnv } from '@/env';
import { ApiError, successEnvelope } from '@/lib/envelope';
import { clientIp, parseBody } from '@/lib/validation';
import { authenticate, requireUser } from '@/middleware/authenticate';
import { ensurePasswordChanged } from '@/middleware/ensure-password-changed';
import { CounselorSignupService } from '@/modules/identity/counselor-signup-service';
import {
  changeEmailSchema,
  changePasswordSchema,
  counselorSignupSchema,
  forgotPasswordSchema,
  loginSchema,
  resendSignupCodeSchema,
  resetPasswordSchema,
  updateAccountSchema,
  verifyEmailChangeSchema,
  verifySignupCodeSchema,
} from '@/modules/identity/schemas';
import { serializeUser } from '@/modules/identity/serializers';
import { StaffAuthenticationService } from '@/modules/identity/staff-authentication-service';

/**
 * Staff auth routes (FULLPLAN §20) — thin handlers: parse the body against the endpoint's
 * Zod schema, call one Service method, return a serialized envelope (§17).
 *
 * `/student-access/join` deliberately lives in its own router, not here (§38) — the split
 * is architectural, and these two flows should never grow a shared branch.
 */
export const authRoutes = new Hono<AppEnv>();

function service(c: { env: AppEnv['Bindings'] }): StaffAuthenticationService {
  return new StaffAuthenticationService(createDatabase(c.env.DB), c.env);
}

authRoutes.post('/login', async (c) => {
  const input = await parseBody(c, loginSchema);
  const { user, counselorProfile, token } = await service(c).login(input, clientIp(c));

  return c.json(
    successEnvelope(
      { user: serializeUser(user, counselorProfile), token },
      'Signed in successfully.',
    ),
  );
});

/**
 * Counselor self-signup (migration 0034) — the four public endpoints, mounted **above** the
 * `authenticate()` lines below because none of them has a caller to authenticate.
 *
 * Every one of them re-reads the `counselor_signup_enabled` switch through the service rather than
 * trusting the status the client was handed earlier; see `assertOpen` for why a signup already in
 * flight must not survive an administrator closing the door.
 */
function signupService(c: { env: AppEnv['Bindings'] }): CounselorSignupService {
  return new CounselorSignupService(createDatabase(c.env.DB), c.env);
}

/**
 * Whether the sign-up form should render at all.
 *
 * Public and unauthenticated, and it discloses nothing an attempted submission would not: a closed
 * deployment answers `false` here and 403s the POST either way. The point is that the counselor
 * login screen can decide whether to offer a link, rather than sending people to a form that
 * refuses them.
 */
authRoutes.get('/signup-status', async (c) => {
  const open = await signupService(c).isOpen();

  return c.json(successEnvelope({ counselor_signup_open: open }, 'Sign-up status retrieved.'));
});

/**
 * Begin a signup. **The response is identical whether or not the email is already registered**
 * (§38) — a registered address is mailed "you already have an account" instead of a code, which is
 * what keeps that silence from being a dead end.
 *
 * The code is echoed in the body **only** when `APP_ENV === 'local'`, exactly as
 * `/auth/forgot-password` treats its reset token, so the flow is exercisable end to end in
 * development and by the suite without a mail channel.
 */
authRoutes.post('/counselor-signup', async (c) => {
  const input = await parseBody(c, counselorSignupSchema);
  const { code } = await signupService(c).signup(input, clientIp(c));

  const data = c.env.APP_ENV === 'local' && code !== null ? { verification_code: code } : null;

  return c.json(
    successEnvelope(
      data,
      'Check your email. If that address can be registered, a six-digit code is on its way.',
    ),
    202,
  );
});

authRoutes.post('/counselor-signup/resend', async (c) => {
  const input = await parseBody(c, resendSignupCodeSchema);
  const { code } = await signupService(c).resend(input.email, clientIp(c));

  const data = c.env.APP_ENV === 'local' && code !== null ? { verification_code: code } : null;

  return c.json(
    successEnvelope(data, 'If a sign-up is waiting for that address, a new code is on its way.'),
    202,
  );
});

/**
 * Complete a signup. Unlike the two above, this one **does** answer specifically — a wrong or
 * expired code is told so — because the caller has already proven they hold the address by having
 * a staged signup, and "your code is wrong" is the only useful thing to say to somebody typing one.
 *
 * No token is issued here. The counselor signs in through `/auth/login` like anybody else, which
 * keeps session issuance on exactly one path.
 */
authRoutes.post('/counselor-signup/verify', async (c) => {
  const input = await parseBody(c, verifySignupCodeSchema);

  await signupService(c).verify(input.email, input.code, clientIp(c));

  return c.json(
    successEnvelope(null, 'Your account is ready. Sign in with the password you chose.'),
    201,
  );
});

// The three endpoints below are reachable with `must_change_password` still set — they are
// exactly what a flagged user needs to get out of that state (see ensure-password-changed).
authRoutes.use('/me', authenticate());
authRoutes.use('/logout', authenticate());
authRoutes.use('/change-password', authenticate());
/*
  The two self-service account endpoints (prompt-driven, 2026-09-20). These are the only routes in
  this router that carry `ensurePasswordChanged`, and that is the point of listing them separately
  from the three above: renaming yourself or moving your email is not part of getting out of a
  temporary password, so a flagged account is refused here exactly as it is everywhere else. The
  three above are the whole of what such an account is allowed to do.
*/
authRoutes.use('/profile', authenticate(), ensurePasswordChanged());
authRoutes.use('/change-email', authenticate(), ensurePasswordChanged());
// `use('/change-email')` matches that path and nothing below it, so the three steps that hang off
// it need their own mount. Written as a wildcard rather than three lines so that a fourth step
// cannot be added later without the guard — an unauthenticated `/change-email/verify` would be a
// code-guessing endpoint against every account at once.
authRoutes.use('/change-email/*', authenticate(), ensurePasswordChanged());

authRoutes.get('/me', async (c) => {
  const { user, counselorProfile } = await service(c).me(requireUser(c));

  return c.json(
    successEnvelope(serializeUser(user, counselorProfile), 'User retrieved successfully.'),
  );
});

authRoutes.post('/logout', async (c) => {
  const user = requireUser(c);
  // Always set by `authenticate()`, which this route is mounted behind.
  const tokenId = c.get('tokenId')!;

  await service(c).logout(user, tokenId, clientIp(c));

  return c.json(successEnvelope(null, 'Signed out successfully.'));
});

/**
 * Edit your own account — the name, and for a counselor the profile fields beside it.
 *
 * It answers with the same `serializeUser` envelope `/auth/me` does, so the client replaces its
 * cached user from the response rather than refetching: the name is in the sidebar, the top bar
 * and the breadcrumb of the very screen that submitted this.
 */
authRoutes.patch('/profile', async (c) => {
  const input = await parseBody(c, updateAccountSchema);
  const { user, counselorProfile } = await service(c).updateAccount(
    requireUser(c),
    input,
    clientIp(c),
  );

  return c.json(successEnvelope(serializeUser(user, counselorProfile), 'Profile updated.'));
});

/**
 * **Step one.** Ask to move the address this account signs in with: the current password proves
 * who is asking, and a six-digit code goes to the address being asked for.
 *
 * `202`, not `200`, and the difference is the honest one: nothing has changed yet. The account
 * still signs in with its old address, and will keep doing so until the code comes back — see
 * `StaffAuthenticationService.requestEmailChange` for why that is worth two round trips.
 *
 * The code is echoed in the body **only** when `APP_ENV === 'local'`, exactly as
 * `/auth/forgot-password` treats its reset token and `/auth/counselor-signup` its own code, so the
 * flow is exercisable end to end in development and by the suite with no mail channel.
 */
authRoutes.post('/change-email', async (c) => {
  const input = await parseBody(c, changeEmailSchema);
  const issued = await service(c).requestEmailChange(requireUser(c), input, clientIp(c));

  return c.json(
    successEnvelope(
      {
        pending_email: issued.email,
        expires_in_minutes: issued.expiresInMinutes,
        ...(c.env.APP_ENV === 'local' ? { verification_code: issued.code } : {}),
      },
      `Enter the six-digit code sent to ${issued.email} to finish moving your account.`,
    ),
    202,
  );
});

/**
 * What is waiting on a code, if anything.
 *
 * The account page calls this on mount, and that is not a nicety: the code arrives in a mail
 * client, usually on a different device, and the tab gets reloaded on the way back. Without this
 * the page would forget a change that is still live and offer to start it again — spending a
 * second code to reach a state it was already in.
 */
authRoutes.get('/change-email', async (c) => {
  const pending = await service(c).pendingEmailChange(requireUser(c));

  return c.json(
    successEnvelope(
      pending === null
        ? null
        : { pending_email: pending.email, expires_in_minutes: pending.expiresInMinutes },
      pending === null ? 'No email change is pending.' : 'An email change is waiting for a code.',
    ),
  );
});

/**
 * A new code for the change already staged. The destination cannot be changed here — that is what
 * cancelling and starting again is for, and it is why this endpoint needs no password.
 *
 * `404` when nothing is staged, rather than a cheerful 202: the one thing this must not do is tell
 * somebody a code is on its way to an address no longer being changed to.
 */
authRoutes.post('/change-email/resend', async (c) => {
  const issued = await service(c).resendEmailChangeCode(requireUser(c), clientIp(c));

  if (issued === null) {
    throw ApiError.notFound('No email change is waiting for a code. Start again.');
  }

  return c.json(
    successEnvelope(
      {
        pending_email: issued.email,
        expires_in_minutes: issued.expiresInMinutes,
        ...(c.env.APP_ENV === 'local' ? { verification_code: issued.code } : {}),
      },
      `A new code is on its way to ${issued.email}.`,
    ),
    202,
  );
});

/**
 * Abandon a staged change. Idempotent, and a success even when there was nothing staged: the
 * button exists to make the page stop asking for a code, and a 404 would leave it asking.
 */
authRoutes.delete('/change-email', async (c) => {
  await service(c).cancelEmailChange(requireUser(c), clientIp(c));

  return c.json(successEnvelope(null, 'The email change was cancelled.'));
});

/**
 * **Step two.** Spend the code, and the address moves.
 *
 * Answers with the updated user in the same shape `/auth/me` does, so the client replaces its
 * cached user from the response rather than refetching. No session is revoked, unlike
 * `/auth/change-password` — the caller proved their password at step one and their mailbox here.
 */
authRoutes.post('/change-email/verify', async (c) => {
  const input = await parseBody(c, verifyEmailChangeSchema);
  const { user, counselorProfile } = await service(c).verifyEmailChange(
    requireUser(c),
    input.code,
    clientIp(c),
  );

  return c.json(
    successEnvelope(
      serializeUser(user, counselorProfile),
      'Email updated. Use your new address the next time you sign in.',
    ),
  );
});

authRoutes.post('/change-password', async (c) => {
  const input = await parseBody(c, changePasswordSchema);

  await service(c).changePassword(requireUser(c), input, clientIp(c));

  return c.json(
    successEnvelope(
      null,
      'Password updated successfully. Sign in again with your new password.',
    ),
  );
});

/**
 * Always the same acknowledgement, whether or not the email exists — an endpoint that
 * distinguishes them is an account-enumeration oracle.
 *
 * v1 has no email channel (§5), so there is nothing to deliver the link with. The token is
 * returned in the response body **only** when `APP_ENV === 'local'`, so the flow is
 * exercisable end to end in development and by the test suite; in staging and production
 * the reset is completed out of band by an admin. Deviation D7 tracks the missing UI.
 */
authRoutes.post('/forgot-password', async (c) => {
  const input = await parseBody(c, forgotPasswordSchema);
  const token = await service(c).forgotPassword(input.email, clientIp(c));

  const data = c.env.APP_ENV === 'local' && token ? { reset_token: token } : null;

  return c.json(
    successEnvelope(
      data,
      'If that email is registered, a password reset has been prepared for it.',
    ),
  );
});

authRoutes.post('/reset-password', async (c) => {
  const input = await parseBody(c, resetPasswordSchema);

  await service(c).resetPassword(input, clientIp(c));

  return c.json(successEnvelope(null, 'Password reset successfully. You can now sign in.'));
});

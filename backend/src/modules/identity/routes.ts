import { Hono } from 'hono';

import { createDatabase } from '@/db/client';
import type { AppEnv } from '@/env';
import { successEnvelope } from '@/lib/envelope';
import { clientIp, parseBody } from '@/lib/validation';
import { authenticate, requireUser } from '@/middleware/authenticate';
import { CounselorSignupService } from '@/modules/identity/counselor-signup-service';
import {
  changePasswordSchema,
  counselorSignupSchema,
  forgotPasswordSchema,
  loginSchema,
  resendSignupCodeSchema,
  resetPasswordSchema,
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

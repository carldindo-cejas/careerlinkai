import { Hono } from 'hono';

import { createDatabase } from '@/db/client';
import type { AppEnv } from '@/env';
import { successEnvelope } from '@/lib/envelope';
import { clientIp, parseBody } from '@/lib/validation';
import { authenticate, requireUser } from '@/middleware/authenticate';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
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
  return new StaffAuthenticationService(createDatabase(c.env.DB), c.env.KV);
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
  const tokenId = c.get('tokenId') as string;

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

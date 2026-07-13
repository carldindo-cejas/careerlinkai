import { createMiddleware } from 'hono/factory';

import type { AppEnv } from '@/env';
import { ApiError } from '@/lib/envelope';
import { requireUser } from '@/middleware/authenticate';

/**
 * Server-side enforcement of `must_change_password` (FULLPLAN §38).
 *
 * The frontend routes a flagged user straight to the forced password-change screen, but
 * that is a redirect, not a control: a temporary password is a credential an admin handed
 * over out of band, and until it is rotated the token it bought must not open anything
 * else.
 *
 * Mounted on every authenticated route group *except* the three self-service auth
 * endpoints the flagged user still needs — `/auth/me`, `/auth/change-password`,
 * `/auth/logout` — which is exactly the set required to get themselves out of this state.
 */
export function ensurePasswordChanged() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = requireUser(c);

    if (user.mustChangePassword) {
      throw ApiError.forbidden('You must change your password before continuing.');
    }

    await next();
  });
}

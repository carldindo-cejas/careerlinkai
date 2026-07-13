import { createMiddleware } from 'hono/factory';

import type { UserRole } from '@/db/enums';
import type { AppEnv } from '@/env';
import { ApiError } from '@/lib/envelope';
import { requireUser } from '@/middleware/authenticate';

/**
 * The coarse gate of the two-layer authorization model (FULLPLAN §39): role first, then
 * ownership via a policy function in `src/policies/`. This middleware never looks at a
 * record — "is this counselor allowed to touch *this* class" is a policy's job, not a
 * middleware's.
 *
 * Must be mounted behind `authenticate()`.
 */
export function ensureRole(...roles: UserRole[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = requireUser(c);

    if (!roles.includes(user.role)) {
      throw ApiError.forbidden();
    }

    await next();
  });
}

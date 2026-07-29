import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';

import { createDatabase } from '@/db/client';
import { users, type User } from '@/db/schema';
import type { AppEnv } from '@/env';
import { isExpired } from '@/lib/datetime';
import { ApiError } from '@/lib/envelope';
import { findTokenByPlaintext, revokeToken } from '@/lib/tokens';
import { enforceApiRateLimit } from '@/middleware/rate-limit';

/**
 * Bearer token → `api_tokens` lookup (FULLPLAN §38).
 *
 * Three rejections, all returning the same 401 so the endpoint reveals nothing about
 * *why* a token failed:
 *
 *   1. The token hash is not in `api_tokens` (never issued, or already revoked).
 *   2. The token has expired — and the row is deleted on the way out, so an expired token
 *      cannot be replayed and cannot accumulate.
 *   3. The user is soft-deleted or not `active`. This check is the point of the middleware
 *      layer (§38, v1.2): a student suspended or removed mid-session holds a live token
 *      until it expires, and without this they would keep working with it.
 *
 * …and, since P3-4, one 429: the general per-user API budget (audit S2). It is charged **here**
 * because this is the single point in the system where a token becomes a user — see
 * `middleware/rate-limit.ts` for why that beats both a global middleware (which cannot see the
 * user) and twelve per-router mounts (of which the thirteenth is forgotten silently).
 */
export function authenticate() {
  return createMiddleware<AppEnv>(async (c, next) => {
    /**
     * **Already authenticated: do it once per request, not once per router.**
     *
     * §10 gives every module its own routes file, and several of them mount on the same prefix —
     * six routers share `/admin`, four share `/counselor`. Hono merges a sub-app's `use('*')` into
     * the parent as `/{prefix}/*`, so **every** router's middleware chain matches, and the composed
     * chain runs each of them in registration order until it reaches the handler. A path whose
     * handler lives in the last-registered router therefore ran this middleware once per router in
     * front of it.
     *
     * That was not a theoretical inefficiency. Measured through the P3-4 counter, which charges
     * exactly once per execution of this function: `/counselor/dashboard` ran it **4** times,
     * `/admin/counselors` **5**, and `/admin/dashboard` — the admin's landing screen — **6**, at
     * two D1 reads each. Twelve reads to answer "who is this", before the handler ran a single
     * query of its own, against a free Worker's 50-subrequest ceiling (§45). Nothing was wrong in
     * any response, which is why 877 green tests had nothing to say about it; it is the same shape
     * as audit C1 and H5, one layer lower down.
     *
     * A token cannot change mid-request, so the second and later runs could only ever re-derive the
     * same answer. Returning early is the whole fix, and it keeps the §10 router layout — the
     * alternative was one god-router importing every service in the system.
     */
    if (c.get('user') !== undefined) {
      await next();

      return;
    }

    const header = c.req.header('Authorization');
    const plaintext = header?.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : null;

    if (!plaintext) {
      throw ApiError.unauthenticated();
    }

    const db = createDatabase(c.env.DB);
    const token = await findTokenByPlaintext(db, plaintext);

    if (!token) {
      throw ApiError.unauthenticated();
    }

    if (isExpired(token.expiresAt)) {
      await revokeToken(db, token.id);

      throw ApiError.unauthenticated();
    }

    const user = await db.query.users.findFirst({ where: eq(users.id, token.userId) });

    if (user?.status !== 'active' || user.deletedAt !== null) {
      throw ApiError.unauthenticated();
    }

    /**
     * S2: charge the general request budget — **after** the three rejections above, so an
     * attacker holding no valid token can never spend a real user's allowance, and a request
     * that was going to 401 anyway is not counted against the person whose token it forged.
     */
    await enforceApiRateLimit(c.env, user);

    // H2: no `touchToken` write here. It stamped `last_used_at`, a column nothing in the system
    // reads (verified by grep) — so every authenticated request paid one D1 **write** (a
    // daily-quota hit; a lab of 40 taking an assessment burned thousands) and one of the 50
    // subrequests, for data no code path consumes. Dropping it makes the hot path two reads and
    // no write. The column stays (a D1 column drop is a table rebuild, not worth it); if a
    // "last seen" feature is ever wanted, reintroduce the write throttled to ~once/hour per token.

    c.set('user', user);
    c.set('tokenId', token.id);

    await next();
  });
}

/**
 * The authenticated user, for handlers mounted behind `authenticate()`.
 *
 * The middleware always sets it, so a handler that reaches this cannot legitimately see
 * `undefined` — throwing rather than returning a nullable type keeps every handler free of
 * a null check that can never fire.
 */
export function requireUser(c: Context<AppEnv>): User {
  const user = c.get('user');

  if (!user) {
    throw ApiError.unauthenticated();
  }

  return user;
}

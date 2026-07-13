import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';

import { createDatabase } from '@/db/client';
import { users, type User } from '@/db/schema';
import type { AppEnv } from '@/env';
import { isExpired } from '@/lib/datetime';
import { ApiError } from '@/lib/envelope';
import { findTokenByPlaintext, revokeToken, touchToken } from '@/lib/tokens';

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
 */
export function authenticate() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header('Authorization');
    const plaintext = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;

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

    if (!user || user.deletedAt !== null || user.status !== 'active') {
      throw ApiError.unauthenticated();
    }

    await touchToken(db, token.id);

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

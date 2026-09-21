import { and, eq, gt, isNull, or } from 'drizzle-orm';

import type { Database } from '@/db/client';
import { apiTokens } from '@/db/schema';
import { generateToken, hashToken, uuid } from '@/lib/crypto';
import { hoursFromNow, isExpired, now } from '@/lib/datetime';

/**
 * The first-party token service (FULLPLAN §38) — the replacement for Sanctum, with the
 * same semantics: hashed opaque bearer tokens, an explicit expiry, and immediate
 * server-side revocation by row deletion.
 *
 * Both auth flows issue the same kind of token; only how the identity was claimed differs
 * (staff: email + password; student: class code + username). Everything downstream —
 * `authenticate`, the policies — cannot tell them apart, which is exactly the intent.
 */

export interface IssuedToken {
  plaintext: string;
  expiresAt: string;
}

/** Issue a token for a user, valid for `ttlHours`. The plaintext is returned once. */
export async function issueToken(
  db: Database,
  userId: string,
  ttlHours: number,
): Promise<IssuedToken> {
  const { plaintext, hash } = await generateToken();
  const expiresAt = hoursFromNow(ttlHours);

  await db.insert(apiTokens).values({
    id: uuid(),
    userId,
    tokenHash: hash,
    expiresAt,
    createdAt: now(),
  });

  return { plaintext, expiresAt };
}

/** Look a presented bearer token up by its hash. Expiry is checked by the caller. */
export async function findTokenByPlaintext(db: Database, plaintext: string) {
  const hash = await hashToken(plaintext);

  return db.query.apiTokens.findFirst({ where: eq(apiTokens.tokenHash, hash) });
}

/** Revoke a single token (logout). */
export async function revokeToken(db: Database, tokenId: string): Promise<void> {
  await db.delete(apiTokens).where(eq(apiTokens.id, tokenId));
}

/**
 * Does this user have a session that is still good right now?
 *
 * Read-only, and it exists for one caller: `/student-access/join`'s confirmation step, which has
 * to warn a student that continuing will sign another device out **before** it does it. Expired
 * rows are excluded rather than trusted — `authenticate()` deletes those on presentation and the
 * nightly sweep collects the rest, so a row can outlive its own expiry by up to a day and must
 * not be reported as a live session on the strength of merely existing.
 */
export async function hasActiveToken(db: Database, userId: string): Promise<boolean> {
  const live = await db.query.apiTokens.findFirst({
    columns: { id: true },
    where: and(
      eq(apiTokens.userId, userId),
      // A NULL expiry means "never expires" (see `isExpired`), so it counts as live.
      or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now())),
    ),
  });

  return live !== undefined;
}

/**
 * Revoke every token a user holds, and report **how many of them were still live**.
 *
 * Used by: a password change (§38 — a rotated credential must not leave old sessions
 * alive), a password reset, a student re-joining a class (one active session, ratified
 * v1.2), and removal from a class (Phase 3.5 Step 2 — audit F-H3).
 *
 * The count comes back from the `DELETE` itself rather than from a second query, and exists so
 * the join path can record in the audit trail that a sign-in **displaced somebody** — the fact
 * that made the September 2026 "students keep getting logged out" incident take a database dig
 * to explain, because the trail recorded the arrival and not the eviction. Every other caller
 * ignores it.
 */
export async function revokeAllTokensForUser(db: Database, userId: string): Promise<number> {
  const revoked = await db
    .delete(apiTokens)
    .where(eq(apiTokens.userId, userId))
    .returning({ expiresAt: apiTokens.expiresAt });

  return revoked.filter((token) => !isExpired(token.expiresAt)).length;
}

// H2 (removed): `touchToken` stamped `api_tokens.last_used_at` on every authenticated request —
// one D1 write per request feeding a column nothing in the system reads. It was the only write on
// the hot auth path; removing it saves a daily-quota write and a subrequest on every request. The
// column remains in the schema (dropping it is a table rebuild); a throttled "last seen" write
// could be reintroduced here if the feature is ever actually wanted.

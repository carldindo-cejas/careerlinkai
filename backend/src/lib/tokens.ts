import { eq } from 'drizzle-orm';

import type { Database } from '@/db/client';
import { apiTokens } from '@/db/schema';
import { generateToken, hashToken, uuid } from '@/lib/crypto';
import { hoursFromNow, now } from '@/lib/datetime';

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
 * Revoke every token a user holds.
 *
 * Used by: a password change (§38 — a rotated credential must not leave old sessions
 * alive), a password reset, a student re-joining a class (one active session, ratified
 * v1.2), and removal from a class (Phase 3.5 Step 2 — audit F-H3).
 */
export async function revokeAllTokensForUser(db: Database, userId: string): Promise<void> {
  await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
}

/** Record that a token was just used — the only write on the hot auth path. */
export async function touchToken(db: Database, tokenId: string): Promise<void> {
  await db.update(apiTokens).set({ lastUsedAt: now() }).where(eq(apiTokens.id, tokenId));
}

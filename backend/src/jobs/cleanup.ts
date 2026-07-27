import { lt } from 'drizzle-orm';

import { createDatabase } from '@/db/client';
import { apiTokens, passwordResetTokens } from '@/db/schema';
import type { Env } from '@/env';
import { now } from '@/lib/datetime';
import { reapStaleAiRequests } from '@/modules/ai/assessment-generation-service';

/**
 * Nightly housekeeping (FULLPLAN §45 enhancement, audit M11) — run by the Cron Trigger in
 * `index.ts`'s `scheduled` handler.
 *
 * Two tables accumulate rows that nothing else ever removes:
 *
 *   * **`api_tokens`** are deleted on presentation when expired (`authenticate`), and revoked
 *     wholesale on logout / password change / re-join — but a token whose owner simply never
 *     returns is never presented again, so its row lingers past expiry forever.
 *   * **`password_reset_tokens`** are single-use and TTL-checked on redemption, but a request
 *     that is never redeemed leaves its row behind.
 *
 * Both are pure garbage once past their expiry, and both are cheap to sweep. The sweep is a plain
 * `DELETE ... WHERE <expiry> < now` — idempotent, and safe to run as often as the trigger fires.
 *
 * A third sweep joined them with migration 0015, and it is not garbage collection: **stale
 * `ai_requests`**. A queued generation reserves its row as PENDING, and if the message is never
 * delivered — no consumer subscribed, retention expired, dead-lettered — nothing else in the
 * system will ever move that row. `statusFor` reaps the ones somebody is actively polling, at the
 * moment they notice; this reaps the rest, so a reviewer who closed the tab does not leave a row
 * that reads as still-running forever, and the admin AI list never shows phantom work in flight.
 *
 * Deliberately **not** here: purging "recommendation sets superseded by a newer result" (the third
 * M11 candidate). Phase C's M4 fix already makes `generateFor` delete every prior set for the
 * student before writing the new one, so an active student never accumulates superseded sets — a
 * correlated cross-table delete on the cron would be complexity guarding against only pre-M4
 * historical rows.
 */

/** The password-reset TTL, mirrored from `staff-authentication-service.ts` (60 minutes). */
const RESET_TOKEN_TTL_MINUTES = 60;

export interface CleanupResult {
  expiredTokens: number;
  staleResetTokens: number;
  stalledAiRequests: number;
}

export async function runNightlyCleanup(env: Env): Promise<CleanupResult> {
  const db = createDatabase(env.DB);
  const currentTime = now();
  const resetCutoff = new Date(Date.now() - RESET_TOKEN_TTL_MINUTES * 60_000).toISOString();

  // `.returning()` gives an exact deleted-row count for the structured log, in one statement each.
  const expired = await db
    .delete(apiTokens)
    .where(lt(apiTokens.expiresAt, currentTime))
    .returning({ id: apiTokens.id });

  const stale = await db
    .delete(passwordResetTokens)
    .where(lt(passwordResetTokens.createdAt, resetCutoff))
    .returning({ email: passwordResetTokens.email });

  // An UPDATE, not a DELETE: a stalled request is evidence, not litter. It is the only record that
  // a reviewer asked for something and the system never answered, and §13.7's audit trail is worth
  // more than the row is expensive.
  const stalled = await reapStaleAiRequests(db);

  return {
    expiredTokens: expired.length,
    staleResetTokens: stale.length,
    stalledAiRequests: stalled,
  };
}

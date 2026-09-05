import { lt } from 'drizzle-orm';

import { createDatabase } from '@/db/client';
import { apiTokens, passwordResetTokens } from '@/db/schema';
import type { Env } from '@/env';
import { queueCatalogSyncContinuation } from '@/jobs/ai-jobs';
import { now } from '@/lib/datetime';
import { log } from '@/lib/logger';
import { reapStaleAiRequests } from '@/modules/ai/assessment-generation-service';
import { syncCatalogKnowledge } from '@/modules/ai/catalog-knowledge-service';

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
  /** Catalog knowledge entries rewritten and re-queued this run (AiNormalisation Phase 1). */
  catalogEntriesSynced: number;
  /** Entries archived because their career or program left the catalog. */
  catalogEntriesRetired: number;
  /**
   * Entries that still need rewriting but did not fit this invocation's subrequest budget (§45).
   * Non-zero means tomorrow's run continues — worth logging, because a number that never reaches
   * zero is the signal that the catalog is changing faster than one nightly batch can absorb.
   */
  catalogEntriesRemaining: number;
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

  /**
   * The one item here that is not a sweep (AiNormalisation Phase 1): regenerate the knowledge
   * entry for every career and program, so an edit to the catalog reaches the AI without anyone
   * remembering to press anything.
   *
   * It sits on this cron rather than on a second trigger because the Free plan's neuron budget
   * resets at 00:00 UTC and this runs at 03:00 — three hours into a fresh allocation, five hours
   * before a Manila school day. It is also nearly free in the normal case: an entry whose text is
   * unchanged is not rewritten, not queued, and not re-embedded, so a night with no catalog edits
   * costs zero model calls.
   *
   * Deliberately last, and deliberately swallowed. The token sweeps above are the reason this
   * trigger exists; a sync that fails must not take them with it.
   */
  let catalogEntriesSynced = 0;
  let catalogEntriesRetired = 0;
  let catalogEntriesRemaining = 0;

  try {
    const sync = await syncCatalogKnowledge(db, env);

    catalogEntriesSynced = sync.changed;
    catalogEntriesRetired = sync.retired;
    catalogEntriesRemaining = sync.remaining;

    /**
     * Finish the job instead of reporting that it is unfinished.
     *
     * `remaining` used to be recorded here and nowhere else, so a catalog larger than one 20-entry
     * batch caught up at 20 entries **per night** — four nights for the original 68-career
     * catalog, fifteen for the Region VII one. Retirement is not budget-capped, so night one
     * archives every stale entry and the corpus is nearly empty while it refills: a dead
     * "Explain more" for a fortnight, which is the exact symptom AiNormalisation existed to fix.
     *
     * The continuation runs on the queue rather than in a loop here, because the 20-entry cap is a
     * subrequest budget (§45) and a loop would spend the same invocation's. See `ai-jobs.ts`.
     */
    await queueCatalogSyncContinuation(env, sync, 1);
  } catch (error) {
    log('error', 'catalog_knowledge.sync_failed', {
      pipeline: 'knowledge_ingestion',
      stage: 'catalog_sync_failed',
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    expiredTokens: expired.length,
    staleResetTokens: stale.length,
    stalledAiRequests: stalled,
    catalogEntriesSynced,
    catalogEntriesRetired,
    catalogEntriesRemaining,
  };
}

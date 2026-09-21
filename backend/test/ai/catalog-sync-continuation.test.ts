import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { createDatabase } from '@/db/client';
import { continueCatalogSync, handleAiJob, queueCatalogSyncContinuation } from '@/jobs/ai-jobs';
import { runNightlyCleanup } from '@/jobs/cleanup';
import {
  CATALOG_SYNC_BATCH,
  syncCatalogKnowledge,
} from '@/modules/ai/catalog-knowledge-service';
import { createCareer, createStaffUser, db, login } from '../helpers';

/**
 * **The catalog sync has to finish by itself** — the other half of `CATALOG_SYNC_BATCH`.
 *
 * `syncCatalogKnowledge` rewrites at most 20 entries per invocation, because a rewrite costs two
 * subrequests against a free Worker's 50 (§45). That cap is right and is already tested
 * (`knowledge-entries.test.ts` — "stops at its subrequest budget and reports the backlog"). What
 * that test asserts is that *calling it again* drains the backlog. What nothing asserted is that
 * anything ever calls it again — and nothing did.
 *
 * The cost was invisible while the catalog was small. The Region VII reset made it 298 entries
 * (96 careers + 202 programme offerings), which at 20 a night is fifteen nights — and worse than
 * a slow fill, because retirement is deliberately *not* budget-capped: the first run archives
 * every stale entry at once. The corpus empties on night one and refills at 20 a night, which is
 * a dead "Explain more" for a fortnight. That is precisely the symptom AiNormalisation was written
 * to fix, re-created by an ordinary catalog change.
 *
 * These tests pin the continuation itself rather than the arithmetic underneath it, because the
 * arithmetic was never wrong.
 */

/** Capture what the code sends to `QUEUE_AI` without delivering it. */
function recordingQueue(): { env: typeof env; sent: { type: string; payload: any }[] } {
  const sent: { type: string; payload: any }[] = [];

  return {
    sent,
    env: {
      ...env,
      QUEUE_AI: {
        send: (message: { type: string; payload: any }) => {
          sent.push(message);

          return Promise.resolve();
        },
        sendBatch: () => Promise.resolve(),
      },
    } as unknown as typeof env,
  };
}

describe('catalog sync continuation', () => {
  it('queues the next page when a run stops at its budget', async () => {
    const { env: recorded, sent } = recordingQueue();

    await queueCatalogSyncContinuation(recorded, { changed: 20, remaining: 278 }, 1);

    expect(sent).toEqual([{ type: 'SyncCatalogKnowledge', payload: { page: 2 } }]);
  });

  it('queues nothing when the catalog is fully synced — the chain has to end', async () => {
    const { env: recorded, sent } = recordingQueue();

    await queueCatalogSyncContinuation(recorded, { changed: 5, remaining: 0 }, 1);

    expect(sent).toEqual([]);
  });

  it('queues nothing when a run made no progress, rather than arming an endless chain', async () => {
    // `remaining` is only incremented after a full batch, so this pair cannot happen today. The
    // guard exists for the change that breaks that invariant: the sync should stall visibly
    // instead of re-queueing a no-op message forever.
    const { env: recorded, sent } = recordingQueue();

    await queueCatalogSyncContinuation(recorded, { changed: 0, remaining: 42 }, 1);

    expect(sent).toEqual([]);
  });

  it('stops at the page cap instead of chaining without end', async () => {
    const { env: recorded, sent } = recordingQueue();

    await continueCatalogSync(recorded, createDatabase(recorded.DB), 201);

    expect(sent).toEqual([]);
  });

  it('is a job type the consumer recognises — an unhandled type is acked and dropped', async () => {
    const { env: recorded } = recordingQueue();

    // `handleAiJob` returning false is how `index.ts` decides a message has no handler: it warns
    // and acks, so a typo in the type name would make the continuation vanish silently rather
    // than fail. Asserting `true` is asserting the chain is actually connected.
    await expect(
      handleAiJob(recorded, { type: 'SyncCatalogKnowledge', payload: { page: 1 } }),
    ).resolves.toBe(true);
  });

  it('carries the page forward, so each hop advances', async () => {
    const { env: recorded, sent } = recordingQueue();

    await queueCatalogSyncContinuation(recorded, { changed: 20, remaining: 5 }, 7);

    expect(sent.map((message) => message.payload.page)).toEqual([8]);
  });

  it('the nightly cron starts the chain rather than reporting a backlog and stopping', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);

    await createCareer(token, { description: 'Cron fixture career.' });

    const { env: recorded, sent } = recordingQueue();
    const result = await runNightlyCleanup(recorded);

    // The cron's own report is unchanged — it still says how much it did.
    expect(result.catalogEntriesSynced).toBeGreaterThan(0);

    // What is new: if it left anything behind, it queued the rest. With a small fixture catalog
    // the batch does not fill, so the correct behaviour is an empty queue and no backlog.
    const catalogMessages = sent.filter((message) => message.type === 'SyncCatalogKnowledge');

    if (result.catalogEntriesRemaining > 0) {
      expect(catalogMessages).toEqual([{ type: 'SyncCatalogKnowledge', payload: { page: 2 } }]);
    } else {
      expect(catalogMessages).toEqual([]);
    }

    // The cron also asks for the Guidance corpus sync, on its own message (AI-COVERAGE-PLAN.md).
    expect(sent).toContainEqual({ type: 'SyncGuidanceKnowledge', payload: { page: 1 } });
  });

  it('drains a backlog larger than one batch end to end', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);

    // More careers than `CATALOG_SYNC_BATCH`, so the first hop genuinely fills its budget and
    // has to hand the rest on. A smaller fixture would pass without ever exercising a second hop
    // — which is exactly the hole this file exists to close.
    for (let index = 0; index < CATALOG_SYNC_BATCH + 4; index += 1) {
      await createCareer(token, { description: `Drain fixture career ${index}.` });
    }

    // Drive the chain the way the queue would: run a hop, deliver whatever it queued, repeat.
    // Before the fix the first hop queued nothing and the backlog sat there until somebody
    // pressed a button, so both halves matter — that it chains, and that it stops.
    const { env: recorded, sent } = recordingQueue();
    let hops = 0;
    let next: { type: string; payload: any } | undefined = {
      type: 'SyncCatalogKnowledge',
      payload: { page: 1 },
    };

    while (next !== undefined && hops < 25) {
      sent.length = 0;
      await handleAiJob(recorded, next);
      hops += 1;
      next = sent[0];
    }

    expect(hops).toBeGreaterThan(1); // it actually chained
    expect(hops).toBeLessThan(25); // and it terminated
    expect(sent).toEqual([]);

    // And the backlog is genuinely gone, not merely un-queued.
    const settled = await syncCatalogKnowledge(db(), env, admin.id);

    expect(settled.remaining).toBe(0);
  });
});

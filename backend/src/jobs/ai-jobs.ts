import { createDatabase } from '@/db/client';
import type { Env } from '@/env';
import { dispatch, type AssessmentDraftGeneratedEvent } from '@/events/dispatcher';
import { notifyAssessmentDraftGenerated } from '@/events/send-notifications';
import { assessmentGenerationMaxQuestions } from '@/lib/config';
import { log } from '@/lib/logger';
import { AiPolicyService } from '@/modules/ai/ai-policy-service';
import { syncCatalogKnowledge } from '@/modules/ai/catalog-knowledge-service';
import { syncGuidanceKnowledge } from '@/modules/ai/guidance-knowledge-service';
import { AssessmentGenerationService } from '@/modules/ai/assessment-generation-service';
import { ExplanationService } from '@/modules/ai/explanation-service';
import { aiGatewayFrom, ingestionFrom, retrievalFrom } from '@/modules/ai/factory';
import { RecommendationService } from '@/modules/recommendation/recommendation-service';

/**
 * The `ai` queue's job handlers (FULLPLAN §42, §43) — the queue's first real workload,
 * which is why the `queue()` entry point sat wired-and-idle from Phase 3.5 until now.
 *
 * §42 v1.5 discipline, restated where the work happens:
 *   * Consumers get **no extra CPU on the Free plan** — the same 10 ms as a request
 *     handler. Everything below is I/O-bound (AI calls, Vectorize ops, D1 batches — await
 *     time costs no CPU); the CPU-heavy work either lives in `AuthGuardDO` or left the
 *     Worker entirely (browser-side extraction, §33).
 *   * Free-plan queues retain messages for **24 hours**. Every handler is therefore
 *     idempotent *and* re-runnable from durable state: the ingestion jobs re-read the R2
 *     sidecar and skip already-embedded chunks; the explanation job resolves the student's
 *     *current* top matches and skips ones already explained.
 */

export interface AiJobMessage {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Handle one message. Returns false for a type this module does not know — the caller
 * acks those with a warning rather than burning retries on them.
 */
export async function handleAiJob(env: Env, message: AiJobMessage): Promise<boolean> {
  const db = createDatabase(env.DB);

  switch (message.type) {
    /** §43 `ProcessKnowledgeDocumentJob`: clean, chunk, fan out embedding batches. */
    case 'ProcessKnowledgeDocument': {
      await ingestionFrom(db, env).process(message.payload.documentId as string);

      return true;
    }

    /** §43 `GenerateEmbeddingJob`: one AI call + one Vectorize upsert per ≤100-chunk batch. */
    case 'GenerateEmbeddingBatch': {
      await ingestionFrom(db, env).embedBatch(
        message.payload.documentId as string,
        message.payload.chunkIds as string[],
      );

      return true;
    }

    /**
     * §43 `GenerateExplanationJob`, queued by the `RecommendationGenerated` listener: give
     * the student's rank-1 career and rank-1 program their AI paragraphs proactively, so
     * the screen is grounded on first open. Everything else generates on demand.
     */
    case 'GenerateStudentExplanations': {
      const studentId = message.payload.studentId as string;
      const recommendations = new RecommendationService(db);
      const policy = await new AiPolicyService(db).activeGlobal();
      const explanations = new ExplanationService(
        db,
        aiGatewayFrom(db, env),
        retrievalFrom(db, env),
        policy,
      );

      for (const recommendation of await recommendations.topRecommendationsFor(studentId)) {
        // System-triggered: the ai_requests row carries user_id = NULL (§13.7). A failure
        // (quota, no grounding) is already logged and fallen back from inside `explain` —
        // it must not fail the message, because a retry into a dead quota cannot succeed.
        await explanations.explain(recommendation, null);
      }

      return true;
    }

    /**
     * §43 `GenerateAssessmentDraftJob` (Phase 5b): run the §31 pipeline against a DRAFT
     * version. Every failure — model, quota, precondition, save — is logged-and-absorbed inside
     * the service as a terminal FAILED `ai_requests` row the status endpoint reports, and is
     * never rethrown, because none of them get better on a retry (§30 v1.5).
     */
    case 'GenerateAssessmentDraft': {
      const payload = message.payload;
      const service = new AssessmentGenerationService(
        db,
        aiGatewayFrom(db, env),
        await new AiPolicyService(db).activeGlobal(),
        assessmentGenerationMaxQuestions(env),
      );

      const result = await service.generateDraft({
        aiRequestId: payload.aiRequestId as string,
        versionId: payload.versionId as string,
        userId: payload.userId as string,
        mode: payload.mode as 'DOCUMENT' | 'DESCRIPTION',
        sourceText: payload.sourceText as string,
      });

      /**
       * §31: "AssessmentDraftGenerated event → notify the creator." Phase 6 plugged the §44
       * listener into the seam this event fired at empty since 5b.
       *
       * **Only when a draft actually landed.** This used to fire unconditionally, so a quota
       * failure or a rejected model response told the creator their draft was ready and sent them
       * to a review screen with nothing on it — the notification asserting the opposite of what
       * the poll was simultaneously reporting. A failure reaches them through the status endpoint,
       * which can say *why*.
       */
      if (result.outcome === 'DRAFTED') {
        await dispatch<AssessmentDraftGeneratedEvent>(
          {
            type: 'AssessmentDraftGenerated',
            aiRequestId: payload.aiRequestId as string,
            versionId: payload.versionId as string,
            creatorId: payload.userId as string,
          },
          [notifyAssessmentDraftGenerated(db)],
        );
      }

      return true;
    }

    /**
     * `SyncCatalogKnowledgeJob` — the continuation that `CATALOG_SYNC_BATCH` always promised.
     *
     * ## The defect this closes
     *
     * `syncCatalogKnowledge` rewrites at most `CATALOG_SYNC_BATCH` (20) entries per invocation,
     * because every rewrite costs two subrequests against a free Worker's 50 (§45). That cap is
     * correct. What was missing is the other half of it: the constant's own comment says "the run
     * reports `remaining` and **the caller queues the next page** — so the initial seed finishes
     * on its own, rather than needing somebody to press a button four times", and *neither caller
     * did*. The cron recorded `remaining` into its return value and stopped; the admin route told
     * the human "run this again".
     *
     * With the 68-career catalog that was a four-night lag nobody noticed. The Region VII reset
     * made it a 15-night one — 96 careers plus 202 programme offerings is 298 entries at 20 a
     * night — and it is worse than a lag, because retirement is deliberately *not* budget-capped:
     * the first run archives every stale entry at once. So the corpus goes to nearly empty on
     * night one and refills at 20 a night, which is exactly the dead **Explain more** that
     * AiNormalisation was written to fix, re-created by a catalog change.
     *
     * ## Why a queue message and not a loop
     *
     * Looping inside one invocation is the thing the budget forbids — that is what the cap is for.
     * A fresh message is a fresh invocation with a fresh 50, and the queue already exists for
     * precisely this shape of work.
     *
     * Progress is guaranteed rather than hoped for: `remaining` is only ever incremented after
     * `changed >= budget`, so a message that reports work left has necessarily done a full batch.
     * `page` is still carried and capped — a queue that can re-arm itself should not be able to do
     * so forever if some future edit breaks that invariant, and 200 pages is 4,000 entries, far
     * past any real catalog.
     */
    case 'SyncCatalogKnowledge': {
      const page = typeof message.payload.page === 'number' ? message.payload.page : 1;

      await continueCatalogSync(env, db, page);

      return true;
    }

    /**
     * `SyncGuidanceKnowledge` (AI-COVERAGE-PLAN.md Phase 3) — the Guidance corpus, on its own
     * message and its own 20-entry budget, chaining a continuation exactly like the catalog sync.
     */
    case 'SyncGuidanceKnowledge': {
      const page = typeof message.payload.page === 'number' ? message.payload.page : 1;

      await continueGuidanceSync(env, db, page);

      return true;
    }

    default:
      return false;
  }
}

/** The Guidance corpus is ~50 entries; 10 pages of 20 is a generous ceiling for a re-arming chain. */
const MAX_GUIDANCE_SYNC_PAGES = 10;

/** Run one guidance-sync page and queue the next if the batch filled up. */
export async function continueGuidanceSync(
  env: Env,
  db: ReturnType<typeof createDatabase>,
  page: number,
): Promise<void> {
  if (page > MAX_GUIDANCE_SYNC_PAGES) {
    log('error', 'guidance_knowledge.sync_page_cap', { pipeline: 'knowledge_ingestion', page });

    return;
  }

  const result = await syncGuidanceKnowledge(db, env);

  // Both, as with the catalog: a run that reports work left has necessarily done a full batch.
  if (result.remaining > 0 && result.changed > 0) {
    await env.QUEUE_AI.send({ type: 'SyncGuidanceKnowledge', payload: { page: page + 1 } });
  }
}

/**
 * Ask for a guidance sync. One subrequest; the consumer does the work with a fresh budget. Never
 * throws — the nightly cron asks again, so a dropped message is a delay, not a loss.
 */
export async function requestGuidanceSync(env: Env): Promise<void> {
  try {
    await env.QUEUE_AI.send({ type: 'SyncGuidanceKnowledge', payload: { page: 1 } });
  } catch (error) {
    log('error', 'guidance_knowledge.sync_request_failed', {
      pipeline: 'knowledge_ingestion',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** How many continuation messages one catalog sync may chain before it stops on principle. */
const MAX_CATALOG_SYNC_PAGES = 200;

/**
 * Run one catalog-sync page and queue the next if there is one.
 *
 * Shared by the queue handler above and by the two entry points that *start* a sync (the nightly
 * cron and the admin button), so "what happens when a batch fills up" is written once.
 */
export async function continueCatalogSync(
  env: Env,
  db: ReturnType<typeof createDatabase>,
  page: number,
): Promise<void> {
  if (page > MAX_CATALOG_SYNC_PAGES) {
    log('error', 'catalog_knowledge.sync_page_cap', {
      pipeline: 'knowledge_ingestion',
      stage: 'catalog_sync_page_cap',
      page,
    });

    return;
  }

  const result = await syncCatalogKnowledge(db, env);

  await queueCatalogSyncContinuation(env, result, page);
}

/**
 * Queue the next page, if the run that just finished left one.
 *
 * Exported so the cron and the admin route can call it with the result they already have, instead
 * of re-running a batch to discover the same `remaining` a second time.
 */
export async function queueCatalogSyncContinuation(
  env: Env,
  result: { changed: number; remaining: number },
  page: number,
): Promise<void> {
  // `changed > 0` as well as `remaining > 0`: the two always travel together today, and requiring
  // both means a future change that breaks that invariant stalls the sync instead of arming an
  // infinite chain of no-op messages.
  if (result.remaining <= 0 || result.changed <= 0) {
    return;
  }

  await env.QUEUE_AI.send({
    type: 'SyncCatalogKnowledge',
    payload: { page: page + 1 },
  });
}

/**
 * Ask for a catalog sync because the catalog just changed (2026-09-09).
 *
 * ## Why the admin's save has to do something
 *
 * The sync ran nightly and on a button, and nowhere else. So an admin who added a college at 2pm
 * and asked the assistant about it at 2:05 was told, correctly and uselessly, that nothing in the
 * school's materials covered it — for another thirteen hours. Every catalog write is a write to
 * something the assistant is supposed to know, and the gap between the two was a full day.
 *
 * ## Why a message rather than the sync itself
 *
 * A save should not pay for a sync. Running one inline would spend up to 40 of the invocation's
 * 50 subrequests (§45) on work the admin is not waiting for, on the request path of somebody who
 * just wanted to fix a typo in a description. One `send` is one subrequest, and the consumer picks
 * it up with a fresh budget and chains its own continuation — which is the machinery
 * `SyncCatalogKnowledge` already exists to provide.
 *
 * ## Never throws
 *
 * A queue that is unreachable must not turn a successful college edit into a 500. The write is
 * already committed and correct; the knowledge entry is a derived artifact, and the nightly cron
 * is the safety net that makes a dropped message a delay rather than a loss. The failure is
 * logged where an operator can see it.
 */
export async function requestCatalogResync(env: Env): Promise<void> {
  try {
    await env.QUEUE_AI.send({ type: 'SyncCatalogKnowledge', payload: { page: 1 } });
  } catch (error) {
    log('error', 'catalog_knowledge.resync_request_failed', {
      pipeline: 'knowledge_ingestion',
      stage: 'catalog_resync_request_failed',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Best-effort FAILED marker so a dead job is visible where a human looks (§53).
 *
 * Called from two places in `index.ts`: when a handler throws (so the admin list shows FAILED
 * while the retry that may still fix it is pending) and when a message is dead-lettered after
 * exhausting its retries (where it is the last word).
 *
 * **`GenerateAssessmentDraft` was missing from here**, which is one of the paths that produced the
 * permanently-PENDING poll this module's callers were built around: `index.ts` documents the DLQ
 * branch as the thing that stops "a `GenerateAssessmentDraft` gone silent" from leaving "its poll
 * PENDING forever", and then handed the message to a function that only ever looked for a
 * `documentId`. A dead-lettered generation flipped nothing at all.
 */
export async function markAiJobFailed(env: Env, message: AiJobMessage): Promise<void> {
  const db = createDatabase(env.DB);

  switch (message.type) {
    case 'ProcessKnowledgeDocument':
    case 'GenerateEmbeddingBatch': {
      const documentId = message.payload?.documentId;

      if (typeof documentId === 'string') {
        await ingestionFrom(db, env).markFailed(documentId);
      }

      return;
    }

    case 'GenerateAssessmentDraft': {
      const aiRequestId = message.payload?.aiRequestId;

      if (typeof aiRequestId === 'string') {
        await aiGatewayFrom(db, env).failReserved(
          aiRequestId,
          'JOB_FAILED: the generation job did not complete. If it was retried and dead-lettered, the reason for each attempt is in the Worker logs under pipeline="assessment_generation". Request a fresh generation.',
        );
      }

      return;
    }

    default:
      return;
  }
}

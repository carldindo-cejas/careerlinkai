import { createDatabase } from '@/db/client';
import type { Env } from '@/env';
import { dispatch, type AssessmentDraftGeneratedEvent } from '@/events/dispatcher';
import { notifyAssessmentDraftGenerated } from '@/events/send-notifications';
import { assessmentGenerationMaxQuestions } from '@/lib/config';
import { AiPolicyService } from '@/modules/ai/ai-policy-service';
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

    default:
      return false;
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

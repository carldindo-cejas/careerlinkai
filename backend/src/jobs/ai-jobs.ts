import { createDatabase } from '@/db/client';
import type { Env } from '@/env';
import { AiPolicyService } from '@/modules/ai/ai-policy-service';
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

    default:
      return false;
  }
}

/** Best-effort FAILED marker so a dead ingestion job is visible in the admin list (§53). */
export async function markAiJobFailed(env: Env, message: AiJobMessage): Promise<void> {
  const documentId = message.payload?.documentId;

  if (
    typeof documentId === 'string' &&
    (message.type === 'ProcessKnowledgeDocument' || message.type === 'GenerateEmbeddingBatch')
  ) {
    await ingestionFrom(createDatabase(env.DB), env).markFailed(documentId);
  }
}

import type { Database } from '@/db/client';
import type { Env } from '@/env';
import { notifyKnowledgeDocumentProcessed } from '@/events/send-notifications';
import {
  DAILY_GENERATION_BUDGET,
  generationBudgetGuard,
  GENERATION_BUDGET_DEGRADE_AT,
  secondsUntilUtcMidnight,
} from '@/lib/auth-guard';
import { retrievalSimilarityThreshold } from '@/lib/config';
import { AiGatewayService } from '@/modules/ai/ai-gateway-service';
import { KnowledgeIngestionService } from '@/modules/ai/knowledge-ingestion-service';
import { RetrievalService } from '@/modules/ai/retrieval-service';
import type { VectorStore } from '@/modules/ai/vector-store';

/**
 * Constructors for the AI stack as the *deployed* Worker wires it — real bindings in.
 *
 * The suite never calls these: Workers AI and Vectorize have no local emulation (the test
 * config deletes both bindings), so tests construct the services directly with stubs. These
 * factories are the one place the real bindings meet the service constructors, which keeps
 * "what production wires" reviewable in a single file.
 */

export function aiGatewayFrom(db: Database, env: Env): AiGatewayService {
  return new AiGatewayService(
    db,
    env.AI,
    {
      text: env.WORKERS_AI_TEXT_MODEL,
      embedding: env.WORKERS_AI_EMBEDDING_MODEL,
      rerank: env.WORKERS_AI_RERANK_MODEL,
      gatewayId: env.AI_GATEWAY_ID,
    },
    /**
     * The Phase 4 budget guard. One account-wide daily counter in `AuthGuardDO`, charged per
     * generation, degrading at 85% so the zero-cost gates and tomorrow's explanations keep a
     * reserve — see `DAILY_GENERATION_BUDGET`.
     *
     * Absent when `AUTH_DO` is not bound, which is the hermetic suite: a budget that had to be
     * stubbed in every test would be a budget people route around.
     */
    env.AUTH_DO === undefined
      ? undefined
      : async () => {
          const state = await generationBudgetGuard(env).charge(
            Math.floor(DAILY_GENERATION_BUDGET * GENERATION_BUDGET_DEGRADE_AT),
            secondsUntilUtcMidnight(),
          );

          return !state.locked;
        },
  );
}

/**
 * The `VECTORIZE` binding satisfies `VectorStore` structurally. When the binding is absent
 * (the hermetic test config), every operation throws — callers on the read path catch and
 * fall back deterministically (§30); callers on the ingestion path let the queue's retry
 * machinery handle it (§42).
 */
export function vectorStoreFrom(env: Env): VectorStore {
  if (env.VECTORIZE !== undefined) {
    return env.VECTORIZE;
  }

  const unavailable = () => {
    throw new Error('VECTORIZE binding is not configured.');
  };

  return { upsert: unavailable, query: unavailable, deleteByIds: unavailable };
}

export function retrievalFrom(db: Database, env: Env): RetrievalService {
  return new RetrievalService(
    db,
    aiGatewayFrom(db, env),
    vectorStoreFrom(env),
    retrievalSimilarityThreshold(env),
    // The §48 note on this binding says "caching only" — until now nothing read it at all. The
    // embedding cache is its first reader: a repeated question costs no model call.
    env.KV,
  );
}

export function ingestionFrom(db: Database, env: Env): KnowledgeIngestionService {
  return new KnowledgeIngestionService(
    db,
    env.STORAGE,
    aiGatewayFrom(db, env),
    vectorStoreFrom(env),
    env.QUEUE_AI,
    // Phase 6: §44's "{file_name} is now available to the AI assistant." notification.
    [notifyKnowledgeDocumentProcessed(db)],
  );
}

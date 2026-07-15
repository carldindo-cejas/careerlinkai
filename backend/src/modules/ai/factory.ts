import type { Database } from '@/db/client';
import type { Env } from '@/env';
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
  return new AiGatewayService(db, env.AI, {
    text: env.WORKERS_AI_TEXT_MODEL,
    embedding: env.WORKERS_AI_EMBEDDING_MODEL,
  });
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
  return new RetrievalService(db, aiGatewayFrom(db, env), vectorStoreFrom(env));
}

export function ingestionFrom(db: Database, env: Env): KnowledgeIngestionService {
  return new KnowledgeIngestionService(
    db,
    env.STORAGE,
    aiGatewayFrom(db, env),
    vectorStoreFrom(env),
    env.QUEUE_AI,
  );
}

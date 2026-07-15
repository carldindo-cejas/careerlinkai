import { inArray } from 'drizzle-orm';

import type { Database } from '@/db/client';
import { knowledgeChunks, type KnowledgeChunk } from '@/db/schema';
import type { AiGatewayService } from '@/modules/ai/ai-gateway-service';
import type { VectorStore } from '@/modules/ai/vector-store';

/**
 * `RetrievalService` — the R in the §30 RAG pipeline.
 *
 * Embed the query, ask Vectorize for the nearest chunks, keep the ones above the §30
 * similarity floor, and hydrate their content from D1. Three subrequests total (one AI
 * call, one Vectorize query, one D1 read), whatever the corpus size.
 *
 * **Vector ids ARE chunk ids** (set at ingestion), so a match maps straight back to its
 * `knowledge_chunks` row with no translation table.
 *
 * There is no visibility filtering here, deliberately (§30): v1 knowledge is GLOBAL-only
 * (v1.2), and archived documents are excluded *structurally* — archiving removes their
 * vectors from the index (§13.7), so they cannot match in the first place. An exclusion
 * that exists as a query-time WHERE clause is an exclusion someone can forget.
 */

/** §30: top-K = 6, similarity threshold ≥ 0.75. */
export const RETRIEVAL_TOP_K = 6;
export const RETRIEVAL_SIMILARITY_THRESHOLD = 0.75;

export interface RetrievedChunk {
  chunk: KnowledgeChunk;
  score: number;
}

export class RetrievalService {
  constructor(
    private readonly db: Database,
    private readonly gateway: AiGatewayService,
    private readonly vectors: VectorStore,
  ) {}

  async retrieve(query: string): Promise<RetrievedChunk[]> {
    const [embedding] = await this.gateway.embed([query]);

    if (embedding === undefined) {
      return [];
    }

    const { matches } = await this.vectors.query(embedding, { topK: RETRIEVAL_TOP_K });

    const relevant = matches.filter((match) => match.score >= RETRIEVAL_SIMILARITY_THRESHOLD);

    if (relevant.length === 0) {
      return [];
    }

    const rows = await this.db
      .select()
      .from(knowledgeChunks)
      .where(
        inArray(
          knowledgeChunks.id,
          relevant.map((match) => match.id),
        ),
      );

    const byId = new Map(rows.map((row) => [row.id, row]));

    // Preserve Vectorize's relevance order; drop matches whose chunk row is gone (a race
    // against an archive — rare, and a silently absent chunk beats a blank context block).
    return relevant.flatMap((match) => {
      const chunk = byId.get(match.id);

      return chunk === undefined ? [] : [{ chunk, score: match.score }];
    });
  }
}

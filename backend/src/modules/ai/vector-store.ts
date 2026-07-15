/**
 * The slice of Cloudflare Vectorize this system uses (FULLPLAN §33, §30) — kept as a
 * three-method interface so the suite can inject a stub: Vectorize has **no local emulation
 * at all** (the binding is deleted from `wrangler.test.toml`; it always dials Cloudflare),
 * so this seam is the only way the ingestion and retrieval pipelines are testable offline.
 *
 * Production passes `env.VECTORIZE` unchanged — the binding satisfies this structurally.
 *
 * Operational fact worth restating wherever this is used (§33 v1.5): Vectorize indexes
 * upserts **asynchronously**. An accepted upsert that an immediate query cannot see yet is
 * indexing lag, not a failed write — `processing_status = COMPLETED` means "vectors
 * accepted", never "vectors queryable".
 */

export interface VectorRecord {
  id: string;
  values: number[];
  metadata?: Record<string, string>;
}

export interface VectorMatch {
  id: string;
  score: number;
}

export interface VectorStore {
  upsert(vectors: VectorRecord[]): Promise<unknown>;
  query(
    vector: number[],
    options: { topK: number; returnMetadata?: boolean },
  ): Promise<{ matches: VectorMatch[] }>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

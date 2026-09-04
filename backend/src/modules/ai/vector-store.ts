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

/**
 * A Vectorize metadata filter (AiNormalisation Phase 2) — `{ entity_id: { $eq: '…' } }`, or the
 * shorthand `{ entity_id: '…' }`, both of which Vectorize accepts.
 *
 * **A filter only works if a metadata index for that property was created before the vectors were
 * upserted.** Vectors written earlier are not in the index and are not returned by a query
 * filtering on it — silently, with no error. That ordering is the single most dangerous thing
 * about this feature and is why it is stated here rather than in a runbook:
 * `wrangler vectorize create-metadata-index` first, reprocess second.
 */
export type VectorFilter = Record<string, string | { $eq?: string; $ne?: string }>;

export interface VectorStore {
  upsert(vectors: VectorRecord[]): Promise<unknown>;
  query(
    vector: number[],
    options: { topK: number; returnMetadata?: boolean; filter?: VectorFilter },
  ): Promise<{ matches: VectorMatch[] }>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

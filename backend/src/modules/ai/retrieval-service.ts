import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Database } from '@/db/client';
import type { KnowledgeEntityType } from '@/db/enums';
import { knowledgeChunks, knowledgeDocuments, type KnowledgeChunk } from '@/db/schema';
import { log } from '@/lib/logger';
import type { AiGatewayService } from '@/modules/ai/ai-gateway-service';
import type { VectorFilter, VectorStore } from '@/modules/ai/vector-store';

/**
 * `RetrievalService` — the R in the §30 RAG pipeline.
 *
 * **Vector ids ARE chunk ids** (set at ingestion), so a match maps straight back to its
 * `knowledge_chunks` row with no translation table.
 *
 * There is no visibility filtering here, deliberately (§30): v1 knowledge is GLOBAL-only (v1.2).
 *
 * Archived documents *were* excluded purely structurally — archiving removes their vectors from
 * the index (§13.7), so they could not match in the first place, and §30 preferred that precisely
 * because "an exclusion that exists as a query-time WHERE clause is an exclusion someone can
 * forget." Phase 2's keyword half reads D1 directly, where the chunk rows survive archiving on
 * purpose, so that guarantee is now half structural and half enforced in
 * `keywordCandidates` — see the note there.
 *
 * ## The pipeline, after AiNormalisation Phase 2
 *
 *   1. **Embed the query** — with the BGE instruction prefix (D3), through a KV cache keyed by
 *      query hash, so the second student to ask a question costs no model call at all.
 *   2. **Two searches, not one.** Vector similarity finds passages that *mean* the same thing;
 *      FTS5 keyword search finds passages containing the same *strings*. Embeddings are weak at
 *      exactly what a student's question often hinges on — a program code, a school's exact name,
 *      a figure — and the keyword half costs zero neurons.
 *   3. **Fuse by reciprocal rank.** Neither half's scores are comparable to the other's (cosine
 *      similarity against BM25), so they are combined by *rank*, which is the standard answer and
 *      the reason RRF exists: a chunk both halves like beats one that either half loves.
 *   4. **Rerank** the fused candidates with a cross-encoder and keep the §30 context size.
 *
 * A `filter` narrows step 2 to chunks about one career or program — which is what makes a growing
 * corpus improve answers rather than dilute them.
 */

/**
 * §30 asked for top-K = 6 at a 0.75 floor. Both numbers moved (AiNormalisation D2):
 *
 * BGE-base cosine similarity for a genuinely relevant short-query / long-passage pair lands in
 * **0.55–0.72**, so a 0.75 floor rejected correct matches as a matter of routine — which is why
 * `NO_GROUNDING` was the *normal* outcome rather than an exceptional one. The floor drops to 0.55
 * and retrieval casts a wide net (`RETRIEVAL_CANDIDATE_K` = 20); the reranker then cuts back to
 * the §30 context size, and *that* is what makes the lower floor safe. A cheap bi-encoder decides
 * what to consider; a cross-encoder decides what the student sees.
 */
export const RETRIEVAL_TOP_K = 6;
// 30 since 2026-09-13 (AI-COVERAGE-PLAN.md Phase 3): the corpus now mixes ~300 dense catalog
// passages with school guidance, and a guidance passage that ranks 25th by cosine similarity is
// often the one the cross-encoder puts first for a "why" or "how" question.
export const RETRIEVAL_CANDIDATE_K = 30;
export const RETRIEVAL_SIMILARITY_THRESHOLD = 0.55;

/** How many keyword hits join the vector candidates before fusion. */
export const KEYWORD_CANDIDATE_K = 10;

/**
 * Reciprocal-rank fusion's damping constant. 60 is the value from the original RRF paper and the
 * one every implementation uses; what it buys is that the gap between rank 1 and rank 2 is not so
 * large that a single list can dictate the outcome. Worth naming rather than inlining, because a
 * reader's first question about `1 / (60 + rank)` is "why 60".
 */
const RRF_K = 60;

/** Embedding cache lifetime in KV. Long, because a question's embedding never goes stale. */
const EMBEDDING_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface RetrievedChunk {
  chunk: KnowledgeChunk;
  score: number;
  /**
   * The title of the document this chunk came from — what a student is shown under the answer
   * (*"Based on: 2026 Admissions Handbook"*, Phase 3).
   *
   * Carried here rather than looked up later because this is the one place that already knows it:
   * hydrating the chunks is a join away from the document row, and re-reading it downstream would
   * be a second query for a string that was in hand.
   */
  documentTitle: string;
}

export interface RetrieveOptions {
  /** Restrict to chunks about one catalog row — the two-pass explanation path's first pass. */
  entity?: { type: KnowledgeEntityType; id: string };
  /** Override the context size; the default is §30's 6. */
  limit?: number;
}

export class RetrievalService {
  private readonly threshold: number;

  constructor(
    private readonly db: Database,
    private readonly gateway: AiGatewayService,
    private readonly vectors: VectorStore,
    /**
     * The similarity floor, overridable from a wrangler var so it is tunable against a live
     * corpus without a code deploy — the one number here that can only be set correctly by
     * measuring. Omitted or non-finite falls back to the constant above.
     */
    threshold?: number,
    /**
     * KV, for the embedding cache. Optional: an absent binding degrades to embedding every query,
     * which is the behaviour this had before the cache existed — a cache that can fail the request
     * it was meant to speed up is worse than no cache.
     */
    private readonly cache?: KVNamespace,
  ) {
    this.threshold =
      threshold !== undefined && Number.isFinite(threshold)
        ? threshold
        : RETRIEVAL_SIMILARITY_THRESHOLD;
  }

  async retrieve(query: string, options: RetrieveOptions = {}): Promise<RetrievedChunk[]> {
    const limit = options.limit ?? RETRIEVAL_TOP_K;

    // Both halves run before either is awaited: they share no state, and a Worker paying for two
    // round trips in series when it could pay for one is the cheapest latency there is to lose.
    const [vectorIds, keywordIds] = await Promise.all([
      this.vectorCandidates(query, options),
      this.keywordCandidates(query, options),
    ]);

    const fused = fuseByReciprocalRank(vectorIds, keywordIds);

    if (fused.length === 0) {
      return [];
    }

    const rows = await this.db
      .select({ chunk: knowledgeChunks, title: knowledgeDocuments.title })
      .from(knowledgeChunks)
      .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId))
      .where(and(inArray(knowledgeChunks.id, fused), isNull(knowledgeDocuments.archivedAt)));

    const byId = new Map(rows.map((row) => [row.chunk.id, row]));

    // Preserve fused order; drop matches whose chunk row is gone (a race against an archive —
    // rare, and a silently absent chunk beats a blank context block). The archive filter is
    // repeated here as well as in the keyword half, because a vector hit reaches this point too
    // and Vectorize's copy of the index lags an archive by however long the delete takes.
    const candidates = fused.flatMap((id) => {
      const row = byId.get(id);

      return row === undefined ? [] : [{ chunk: row.chunk, score: 0, documentTitle: row.title }];
    });

    return this.rerank(query, candidates, limit);
  }

  /**
   * The passages about one catalog row, read straight from D1 (AI-COVERAGE-PLAN.md Phase 5).
   *
   * When a student names a college, program or career in an open question — "is BS Nursing at
   * Holy Name good for me?" — the passage *about* that thing must be in the context, and similarity
   * search is not a guarantee of that. One indexed query, no embedding and no rerank: the caller
   * puts these first and lets ordinary retrieval fill the rest. Never throws.
   */
  async chunksForEntity(
    entity: { type: KnowledgeEntityType; id: string },
    limit = 2,
  ): Promise<RetrievedChunk[]> {
    try {
      const rows = await this.db
        .select({ chunk: knowledgeChunks, title: knowledgeDocuments.title })
        .from(knowledgeChunks)
        .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId))
        .where(
          and(
            eq(knowledgeChunks.entityType, entity.type),
            eq(knowledgeChunks.entityId, entity.id),
            isNull(knowledgeDocuments.archivedAt),
          ),
        )
        .orderBy(knowledgeChunks.chunkNumber)
        .limit(limit);

      return rows.map((row) => ({ chunk: row.chunk, score: 1, documentTitle: row.title }));
    } catch {
      return [];
    }
  }

  // --- the two halves --------------------------------------------------------------------

  /** Vector similarity, above the floor, optionally filtered to one catalog row. */
  private async vectorCandidates(query: string, options: RetrieveOptions): Promise<string[]> {
    const embedding = await this.embedQueryCached(query);

    if (embedding === undefined) {
      return [];
    }

    const filter: VectorFilter | undefined =
      options.entity === undefined
        ? undefined
        : { entity_type: options.entity.type, entity_id: options.entity.id };

    const { matches } = await this.vectors.query(embedding, {
      topK: RETRIEVAL_CANDIDATE_K,
      ...(filter === undefined ? {} : { filter }),
    });

    return matches.filter((match) => match.score >= this.threshold).map((match) => match.id);
  }

  /**
   * FTS5 keyword search — zero neurons, and it catches what embeddings miss: program codes,
   * school names, exact figures, and Filipino text the English-only embedder cannot represent
   * at all (D8).
   *
   * ## The archived-document join is load-bearing, not defensive
   *
   * §30 states that archived content is excluded **structurally**: archiving deletes the chunks'
   * vectors from Vectorize, so archived content cannot match — "an exclusion that exists as a
   * query-time WHERE clause is an exclusion someone can forget."
   *
   * That reasoning held while Vectorize was the only way in. This half reads `knowledge_chunks`
   * directly, and those rows deliberately **survive** archiving (`ai_requests.input_context`
   * references chunk ids for provenance, §13.7). So adding keyword search silently reopened every
   * archived document to retrieval — a withdrawn policy or a corrected fee could be quoted back
   * to a student — and the structural exclusion now covers only half the pipeline.
   *
   * Hence the join. It is exactly the kind of clause §30 warned about, which is why it is stated
   * here at length and pinned by its own test: the guarantee is no longer free, so it has to be
   * paid for explicitly.
   *
   * Never throws. Keyword search is an *addition* to vector retrieval; if the FTS table is
   * missing or a query is unparseable, retrieval must degrade to the vector half rather than
   * fail outright.
   */
  private async keywordCandidates(query: string, options: RetrieveOptions): Promise<string[]> {
    const match = toFtsQuery(query);

    if (match === null) {
      return [];
    }

    try {
      const rows = await this.db
        .select({ id: knowledgeChunks.id })
        .from(knowledgeChunks)
        .innerJoin(
          sql`knowledge_chunks_fts`,
          sql`knowledge_chunks_fts.rowid = ${knowledgeChunks}.rowid`,
        )
        .innerJoin(
          knowledgeDocuments,
          eq(knowledgeDocuments.id, knowledgeChunks.documentId),
        )
        .where(
          and(
            sql`knowledge_chunks_fts MATCH ${match}`,
            isNull(knowledgeDocuments.archivedAt),
            options.entity === undefined
              ? undefined
              : and(
                  eq(knowledgeChunks.entityType, options.entity.type),
                  eq(knowledgeChunks.entityId, options.entity.id),
                ),
          ),
        )
        .orderBy(sql`bm25(knowledge_chunks_fts)`)
        .limit(KEYWORD_CANDIDATE_K);

      return rows.map((row) => row.id);
    } catch (error) {
      log('error', 'retrieval.keyword_search_failed', {
        pipeline: 'retrieval',
        stage: 'keyword_search_failed',
        error: error instanceof Error ? error.message : String(error),
      });

      return [];
    }
  }

  // --- embedding cache -------------------------------------------------------------------

  /**
   * The query's embedding, from KV when it has been asked before.
   *
   * A class of forty students asking the same five questions is the normal load here, and an
   * embedding for a given string never changes — so the cache hit rate on a school day is high
   * and the answer is never stale. Every failure mode falls through to embedding the query: a KV
   * read that throws, a malformed entry, an absent binding. A cache is an optimisation, and an
   * optimisation that can break the thing it optimises is a bug.
   */
  private async embedQueryCached(query: string): Promise<number[] | undefined> {
    const key = this.cache === undefined ? null : `embed:v1:${await sha256(query)}`;

    if (this.cache !== undefined && key !== null) {
      try {
        const cached = await this.cache.get(key, 'json');

        if (Array.isArray(cached) && cached.every((value) => typeof value === 'number')) {
          return cached;
        }
      } catch {
        // Fall through and embed.
      }
    }

    const embedding = await this.gateway.embedQuery(query);

    if (embedding !== undefined && this.cache !== undefined && key !== null) {
      try {
        await this.cache.put(key, JSON.stringify(embedding), {
          expirationTtl: EMBEDDING_CACHE_TTL_SECONDS,
        });
      } catch {
        // A cache that cannot be written is still a retrieval that can succeed.
      }
    }

    return embedding;
  }

  // --- rerank ----------------------------------------------------------------------------

  /**
   * Cut the candidate set down to the context size, cross-encoder first.
   *
   * When the reranker is unavailable this returns the fused order truncated to the same size — a
   * worse ordering, never a failure. The alternative (passing every candidate into the prompt)
   * would spend context on passages the floor only admitted because it is deliberately generous.
   */
  private async rerank(
    query: string,
    candidates: RetrievedChunk[],
    limit: number,
  ): Promise<RetrievedChunk[]> {
    if (candidates.length <= 1) {
      return candidates;
    }

    const ranked = await this.gateway.rerank(
      query,
      candidates.map(({ chunk }) => chunk.content),
    );

    if (ranked === undefined || ranked.length === 0) {
      return candidates.slice(0, limit);
    }

    return ranked.slice(0, limit).flatMap(({ index, score }) => {
      const candidate = candidates[index];

      // The rerank score replaces the fusion score: it is the number that decided this chunk is
      // here, so it is the number the provenance trail should carry.
      return candidate === undefined ? [] : [{ ...candidate, score }];
    });
  }
}

/**
 * Reciprocal-rank fusion: `score(d) = Σ 1 / (k + rank(d))` over the lists that contain `d`.
 *
 * Rank, not score, because the two inputs are not on one scale — cosine similarity around 0.6 and
 * a BM25 score of -8 cannot be added, and normalising them would require knowing each list's
 * distribution, which changes with every corpus edit. RRF needs neither, and it has the property
 * this pipeline actually wants: a chunk both halves rank highly beats one that only a single half
 * loves.
 */
export function fuseByReciprocalRank(...lists: string[][]): string[] {
  const scores = new Map<string, number>();

  for (const list of lists) {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + index + 1));
    });
  }

  return [...scores.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([id]) => id)
    .slice(0, RETRIEVAL_CANDIDATE_K);
}

/**
 * Words that must never, on their own, make a chunk count as relevant.
 *
 * This list is not tidiness — it is what keeps **honest refusal reachable**. The keyword half
 * joins terms with `OR`, so without it a chunk sharing nothing with the question but the word
 * "the" enters the candidate set, and a pipeline that is supposed to say *"nothing here covers
 * that"* instead generates a paragraph grounded on a coincidence. Refusal is the most valuable
 * output this system has (it is what turns a gap into a backlog item), and a search that always
 * finds something quietly deletes it.
 *
 * Both languages, because students write in both: Taglish questions are the norm, and the English
 * embedder cannot represent the Filipino half at all (D8) — so for those questions the keyword
 * half is not a supplement, it is the only half that works.
 */
const STOPWORDS = new Set([
  // English
  'the', 'and', 'for', 'are', 'was', 'were', 'what', 'which', 'who', 'whom', 'this', 'that',
  'these', 'those', 'with', 'from', 'have', 'has', 'had', 'can', 'could', 'would', 'should',
  'about', 'into', 'than', 'then', 'they', 'them', 'their', 'there', 'here', 'been', 'being',
  'does', 'did', 'you', 'your', 'yours', 'our', 'ours', 'his', 'her', 'hers', 'its', 'not',
  'but', 'all', 'any', 'how', 'why', 'when', 'where', 'will', 'shall', 'may', 'might', 'must',
  'get', 'got', 'one', 'two', 'more', 'most', 'much', 'many', 'some', 'such', 'only', 'own',
  'same', 'very', 'just', 'also', 'like', 'want', 'need', 'good', 'best', 'take', 'make',
  // Filipino / Taglish
  'ang', 'ng', 'mga', 'sa', 'ay', 'na', 'at', 'ko', 'mo', 'niya', 'namin', 'natin', 'nila',
  'ako', 'ikaw', 'siya', 'kami', 'tayo', 'sila', 'ito', 'iyan', 'iyon', 'dito', 'diyan',
  'doon', 'kung', 'para', 'pero', 'kasi', 'yung', 'nung', 'ba', 'po', 'opo', 'hindi', 'oo',
  'may', 'meron', 'wala', 'ano', 'sino', 'saan', 'kailan', 'bakit', 'paano', 'pwede', 'puwede',
]);

/**
 * Turn a student's question into an FTS5 MATCH expression.
 *
 * Everything that is not a letter or a digit is dropped, and each surviving word is quoted, for
 * one reason: FTS5's query syntax treats `"`, `*`, `:`, `^`, `-`, `AND`, `OR` and `NEAR` as
 * operators, so a question containing an apostrophe or a stray quote is a **syntax error**, not a
 * search. Quoting each token turns the whole thing back into what it was meant to be — words to
 * look for.
 *
 * `OR` rather than `AND`: a question is not a boolean query, and requiring every word to appear
 * would make the keyword half return nothing for any sentence longer than a phrase. BM25 ranking
 * handles the ordering — a chunk matching five of the words outranks one matching two.
 *
 * What `OR` cannot do by itself is decide that a match is *worth* having, which is why stopwords
 * are removed rather than merely down-weighted: matching on "the" is not weak evidence, it is no
 * evidence, and letting it through would make the honest refusal at the end of this pipeline
 * unreachable.
 *
 * Returns `null` when nothing searchable survives — a question made entirely of stopwords or
 * punctuation skips the keyword half rather than issuing `MATCH ''`.
 */
export function toFtsQuery(query: string): string | null {
  const tokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token))
    .slice(0, 32);

  return tokens.length === 0 ? null : tokens.map((token) => `"${token}"`).join(' OR ');
}

/** Hex SHA-256, for the cache key. WebCrypto is available in Workers and in the test runtime. */
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

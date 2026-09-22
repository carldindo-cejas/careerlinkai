import { httpClient, unwrap } from '@/services/httpClient';
import type {
  AiInsights,
  AiPolicy,
  CatalogSyncResult,
  CoverageReport,
  ExplainOutcome,
  FlaggedAnswer,
  KnowledgeDocument,
  KnowledgeEntryContent,
  KnowledgeEntryPayload,
  ProcessingStatus,
  ResolvedQuestion,
  UnansweredQuestion,
  UpdateAiPolicyPayload,
} from '@/types/ai';
import type { ApiSuccess } from '@/types/api';
import type { Paginated } from '@/types/class';

/**
 * The AI / Knowledge module's HTTP surface (FULLPLAN §20, Phase 5a).
 *
 * The upload is multipart `{ file, extracted_text }` (§33 v1.5): the text is extracted in
 * THIS browser (see features/admin/utils/extractText.ts) because the Workers Free plan has
 * no server-side CPU home for a PDF parser — the raw file still travels, for provenance.
 */

/**
 * Which mount to call — the knowledge surface exists identically under `/admin` and
 * `/counselor`, scoped server-side to the caller (backend `createKnowledgeRoutes`).
 *
 * Passed in by the hooks rather than read from the auth store here, so this module stays what
 * every other service in `services/` is: a description of the API with no opinion about who is
 * signed in. It is also what keeps the query keys honest — a scope the hook did not choose is a
 * scope the hook cannot put in its cache key, and two roles sharing one cache entry in the same
 * browser session is a real way to show somebody another person's library.
 */
export type KnowledgeScope = 'admin' | 'counselor';

/**
 * The knowledge list query (backend `listKnowledgeDocumentsQuerySchema`, audit F4). `status`
 * filters on the processing state — the filter that makes a stuck or failed document findable
 * rather than something you notice by reading every page.
 *
 * `author_role` is the admin's "what have the counselors contributed?" filter. It is a *filter*,
 * never a permission: a counselor's own narrowing is applied from their token and cannot be
 * widened from here.
 */
export interface KnowledgeListQuery {
  search?: string | undefined;
  status?: ProcessingStatus | undefined;
  author_role?: 'admin' | 'counselor' | undefined;
  /**
   * Which half of the library to list. Omitted means `live` — the server's default, and the one
   * the page's Knowledge tab wants; the Archived tab asks for the other.
   */
  archived?: 'live' | 'archived' | 'all' | undefined;
  page?: number | undefined;
  per_page?: number | undefined;
}

export const aiApi = {
  listKnowledgeDocuments(
    scope: KnowledgeScope,
    query: KnowledgeListQuery = {},
  ): Promise<Paginated<KnowledgeDocument>> {
    return unwrap(
      httpClient.get<ApiSuccess<Paginated<KnowledgeDocument>>>(`/${scope}/knowledge-documents`, {
        params: { per_page: 20, ...query },
      }),
    );
  },

  uploadKnowledgeDocument(
    scope: KnowledgeScope,
    file: File,
    extractedText: string,
  ): Promise<KnowledgeDocument> {
    const form = new FormData();

    form.append('file', file);
    form.append('extracted_text', extractedText);

    return unwrap(
      httpClient.post<ApiSuccess<KnowledgeDocument>>(`/${scope}/knowledge-documents`, form, {
        // Axios must not send the JSON default; the boundary comes from the browser.
        headers: { 'Content-Type': 'multipart/form-data' },
      }),
    );
  },

  /**
   * Write an entry rather than upload one — a pasted note or a Q&A pair (AiNormalisation
   * Phase 1). No file, no parser, no waiting for someone to produce a PDF.
   *
   * `resolves_question` on the payload is what takes the question off the backlog (migration
   * 0031). It carries the question **as the report worded it**, which is routinely not how the
   * author finally worded it in the form — see the type.
   */
  createKnowledgeEntry(
    scope: KnowledgeScope,
    payload: KnowledgeEntryPayload,
  ): Promise<KnowledgeDocument> {
    return unwrap(
      httpClient.post<ApiSuccess<KnowledgeDocument>>(`/${scope}/knowledge-entries`, payload),
    );
  },

  /** The entry plus its text, for the edit form — so a one-word fix is a one-word fix. */
  knowledgeEntryContent(scope: KnowledgeScope, id: string): Promise<KnowledgeEntryContent> {
    return unwrap(
      httpClient.get<ApiSuccess<KnowledgeEntryContent>>(
        `/${scope}/knowledge-documents/${id}/content`,
      ),
    );
  },

  /** Saving re-chunks and re-embeds: the corrected text replaces the old one in the index. */
  updateKnowledgeEntry(
    scope: KnowledgeScope,
    id: string,
    payload: KnowledgeEntryPayload,
  ): Promise<KnowledgeDocument> {
    return unwrap(
      httpClient.patch<ApiSuccess<KnowledgeDocument>>(`/${scope}/knowledge-entries/${id}`, payload),
    );
  },

  /** Regenerate the entry for every career and program now, rather than at 03:00 UTC. */
  syncCatalogKnowledge(): Promise<CatalogSyncResult> {
    return unwrap(
      httpClient.post<ApiSuccess<CatalogSyncResult>>('/admin/knowledge-catalog-sync'),
    );
  },

  /** DELETE archives (§13.7) — the response is the archived row, not a 204. */
  archiveKnowledgeDocument(scope: KnowledgeScope, id: string): Promise<KnowledgeDocument> {
    return unwrap(
      httpClient.delete<ApiSuccess<KnowledgeDocument>>(`/${scope}/knowledge-documents/${id}`),
    );
  },

  /**
   * **Destroy** an entry — the row, its passages, its vectors and its stored file.
   *
   * A different URL from `archiveKnowledgeDocument` rather than a flag on it, matching the server:
   * these are not two settings of one operation, and a boolean would put "retire it" and "destroy
   * it" one argument apart at every call site. The server refuses an entry that is not already
   * archived, so this is always the second of two deliberate acts.
   */
  removeKnowledgeDocument(scope: KnowledgeScope, id: string): Promise<{ id: string }> {
    return unwrap(
      httpClient.delete<ApiSuccess<{ id: string }>>(
        `/${scope}/knowledge-documents/${id}/permanently`,
      ),
    );
  },

  /** The §42 re-run path: Free-plan queues keep messages for 24 h — a stuck job needs a button. */
  reprocessKnowledgeDocument(scope: KnowledgeScope, id: string): Promise<KnowledgeDocument> {
    return unwrap(
      httpClient.post<ApiSuccess<KnowledgeDocument>>(
        `/${scope}/knowledge-documents/${id}/reprocess`,
      ),
    );
  },

  /** Undo an archive: the entry returns to the live list and is re-embedded. */
  unarchiveKnowledgeDocument(scope: KnowledgeScope, id: string): Promise<KnowledgeDocument> {
    return unwrap(
      httpClient.post<ApiSuccess<KnowledgeDocument>>(
        `/${scope}/knowledge-documents/${id}/unarchive`,
      ),
    );
  },

  /**
   * The report header: corpus health, the tab counts, and what this caller may do.
   *
   * One call, on every visit, regardless of which tab is open. The four lists have their own
   * endpoints below — see the backend route comment for why one endpoint became five when the
   * screen became four tabs.
   */
  aiInsights(scope: KnowledgeScope): Promise<AiInsights> {
    return unwrap(httpClient.get<ApiSuccess<AiInsights>>(`/${scope}/ai-insights`));
  },

  unansweredQuestions(
    scope: KnowledgeScope,
    page = 1,
  ): Promise<Paginated<UnansweredQuestion>> {
    return unwrap(
      httpClient.get<ApiSuccess<Paginated<UnansweredQuestion>>>(
        `/${scope}/ai-insights/unanswered`,
        { params: { page } },
      ),
    );
  },

  resolvedQuestions(scope: KnowledgeScope, page = 1): Promise<Paginated<ResolvedQuestion>> {
    return unwrap(
      httpClient.get<ApiSuccess<Paginated<ResolvedQuestion>>>(`/${scope}/ai-insights/resolved`, {
        params: { page },
      }),
    );
  },

  /** Bounded server-side rather than paged — a flagged answer is rare and each one needs reading. */
  flaggedAnswers(scope: KnowledgeScope): Promise<FlaggedAnswer[]> {
    return unwrap(
      httpClient.get<ApiSuccess<FlaggedAnswer[]>>(`/${scope}/ai-insights/flagged`),
    );
  },

  /** Empty for a counselor, by the server's decision — the only fix for a gap is the admin's sync. */
  catalogCoverage(scope: KnowledgeScope): Promise<CoverageReport> {
    return unwrap(
      httpClient.get<ApiSuccess<CoverageReport>>(`/${scope}/ai-insights/coverage`),
    );
  },

  /**
   * Take a question off the backlog without answering it (migration 0031). Admin-only on the
   * server: a dismissal has no entry behind it and so can never lapse.
   */
  dismissQuestion(question: string): Promise<{ id: string; question: string }> {
    return unwrap(
      httpClient.post<ApiSuccess<{ id: string; question: string }>>(
        '/admin/knowledge-questions/dismiss',
        { question },
      ),
    );
  },

  /** The undo for both answering and dismissing — puts the question back on the backlog. */
  reopenQuestion(scope: KnowledgeScope, resolutionId: string): Promise<{ id: string }> {
    return unwrap(
      httpClient.delete<ApiSuccess<{ id: string }>>(
        `/${scope}/knowledge-question-resolutions/${resolutionId}`,
      ),
    );
  },

  listAiPolicies(): Promise<AiPolicy[]> {
    return unwrap(httpClient.get<ApiSuccess<AiPolicy[]>>('/admin/ai-policies'));
  },

  updateAiPolicy(id: string, payload: UpdateAiPolicyPayload): Promise<AiPolicy> {
    return unwrap(httpClient.patch<ApiSuccess<AiPolicy>>(`/admin/ai-policies/${id}`, payload));
  },

  /** "Explain more" (§20, §30). Always 200 — the fallback reason is part of the contract. */
  explainRecommendation(recommendationId: string): Promise<ExplainOutcome> {
    return unwrap(
      httpClient.post<ApiSuccess<ExplainOutcome>>(
        `/student/recommendations/${recommendationId}/explain`,
      ),
    );
  },
};

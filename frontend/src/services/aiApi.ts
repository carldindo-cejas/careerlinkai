import { httpClient, unwrap } from '@/services/httpClient';
import type {
  AiInsights,
  AiPolicy,
  CatalogSyncResult,
  ExplainOutcome,
  KnowledgeDocument,
  KnowledgeEntryContent,
  KnowledgeEntryPayload,
  ProcessingStatus,
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
 * The knowledge list query (backend `listKnowledgeDocumentsQuerySchema`, audit F4). `status`
 * filters on the processing state — the filter that makes a stuck or failed document findable
 * rather than something you notice by reading every page.
 */
export interface KnowledgeListQuery {
  search?: string | undefined;
  status?: ProcessingStatus | undefined;
  page?: number | undefined;
  per_page?: number | undefined;
}

export const aiApi = {
  listKnowledgeDocuments(
    query: KnowledgeListQuery = {},
  ): Promise<Paginated<KnowledgeDocument>> {
    return unwrap(
      httpClient.get<ApiSuccess<Paginated<KnowledgeDocument>>>('/admin/knowledge-documents', {
        params: { per_page: 20, ...query },
      }),
    );
  },

  uploadKnowledgeDocument(file: File, extractedText: string): Promise<KnowledgeDocument> {
    const form = new FormData();

    form.append('file', file);
    form.append('extracted_text', extractedText);

    return unwrap(
      httpClient.post<ApiSuccess<KnowledgeDocument>>('/admin/knowledge-documents', form, {
        // Axios must not send the JSON default; the boundary comes from the browser.
        headers: { 'Content-Type': 'multipart/form-data' },
      }),
    );
  },

  /**
   * Write an entry rather than upload one — a pasted note or a Q&A pair (AiNormalisation
   * Phase 1). No file, no parser, no waiting for someone to produce a PDF.
   */
  createKnowledgeEntry(payload: KnowledgeEntryPayload): Promise<KnowledgeDocument> {
    return unwrap(
      httpClient.post<ApiSuccess<KnowledgeDocument>>('/admin/knowledge-entries', payload),
    );
  },

  /** The entry plus its text, for the edit form — so a one-word fix is a one-word fix. */
  knowledgeEntryContent(id: string): Promise<KnowledgeEntryContent> {
    return unwrap(
      httpClient.get<ApiSuccess<KnowledgeEntryContent>>(
        `/admin/knowledge-documents/${id}/content`,
      ),
    );
  },

  /** Saving re-chunks and re-embeds: the corrected text replaces the old one in the index. */
  updateKnowledgeEntry(id: string, payload: KnowledgeEntryPayload): Promise<KnowledgeDocument> {
    return unwrap(
      httpClient.patch<ApiSuccess<KnowledgeDocument>>(`/admin/knowledge-entries/${id}`, payload),
    );
  },

  /** Regenerate the entry for every career and program now, rather than at 03:00 UTC. */
  syncCatalogKnowledge(): Promise<CatalogSyncResult> {
    return unwrap(
      httpClient.post<ApiSuccess<CatalogSyncResult>>('/admin/knowledge-catalog-sync'),
    );
  },

  /** DELETE archives (§13.7) — the response is the archived row, not a 204. */
  archiveKnowledgeDocument(id: string): Promise<KnowledgeDocument> {
    return unwrap(
      httpClient.delete<ApiSuccess<KnowledgeDocument>>(`/admin/knowledge-documents/${id}`),
    );
  },

  /** The §42 re-run path: Free-plan queues keep messages for 24 h — a stuck job needs a button. */
  reprocessKnowledgeDocument(id: string): Promise<KnowledgeDocument> {
    return unwrap(
      httpClient.post<ApiSuccess<KnowledgeDocument>>(
        `/admin/knowledge-documents/${id}/reprocess`,
      ),
    );
  },

  /** The Phase 4 report: unanswered questions, catalog coverage, flagged answers, corpus health. */
  aiInsights(): Promise<AiInsights> {
    return unwrap(httpClient.get<ApiSuccess<AiInsights>>('/admin/ai-insights'));
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

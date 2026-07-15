import { httpClient, unwrap } from '@/services/httpClient';
import type {
  AiPolicy,
  ExplainOutcome,
  KnowledgeDocument,
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
export const aiApi = {
  listKnowledgeDocuments(): Promise<Paginated<KnowledgeDocument>> {
    return unwrap(
      httpClient.get<ApiSuccess<Paginated<KnowledgeDocument>>>('/admin/knowledge-documents', {
        params: { per_page: 100 },
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

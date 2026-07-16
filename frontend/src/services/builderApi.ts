import { httpClient, unwrap } from '@/services/httpClient';
import type { ApiSuccess } from '@/types/api';
import type {
  BuilderDimension,
  BuilderTemplate,
  BuilderVersionSummary,
  GenerationStatusResponse,
  PublishReadiness,
  VersionReview,
} from '@/types/builder';

/**
 * The assessment builder + AI generation surface (Phase 5b — FULLPLAN §20, §31).
 *
 * Shared by admin and counselor: the endpoints mount at the API root and ownership is a
 * per-record server-side policy (admin: any template; counselor: their own — a foreign id
 * 404s). Nothing here is student-reachable.
 */
export const builderApi = {
  createTemplate(payload: { title: string; description?: string | null }): Promise<BuilderTemplate> {
    return unwrap(
      httpClient.post<ApiSuccess<BuilderTemplate>>('/assessment-templates', {
        category: 'CUSTOM',
        ...payload,
      }),
    );
  },

  getTemplate(templateId: string): Promise<BuilderTemplate> {
    return unwrap(
      httpClient.get<ApiSuccess<BuilderTemplate>>(`/assessment-templates/${templateId}`),
    );
  },

  addDimensions(
    templateId: string,
    dimensions: { code: string; name: string; description?: string | null }[],
  ): Promise<BuilderDimension[]> {
    return unwrap(
      httpClient.post<ApiSuccess<BuilderDimension[]>>(
        `/assessment-templates/${templateId}/dimensions`,
        { dimensions },
      ),
    );
  },

  createVersion(
    templateId: string,
    payload: { instructions?: string | null; scoring_algorithm?: 'HOLLAND_CODE_TOP3' | 'WEIGHTED_COMPOSITE' } = {},
  ): Promise<BuilderVersionSummary> {
    return unwrap(
      httpClient.post<ApiSuccess<BuilderVersionSummary>>(
        `/assessment-templates/${templateId}/versions`,
        { scoring_algorithm: 'WEIGHTED_COMPOSITE', ...payload },
      ),
    );
  },

  /** The §31 review payload — questions WITH scores and mappings (the author's view). */
  getVersion(versionId: string): Promise<VersionReview> {
    return unwrap(httpClient.get<ApiSuccess<VersionReview>>(`/assessment-versions/${versionId}`));
  },

  addQuestions(
    versionId: string,
    questions: {
      question_text: string;
      question_type: 'LIKERT' | 'MULTIPLE_CHOICE' | 'BOOLEAN';
      options: { label: string; value: string; score: number }[];
      dimension_codes: string[];
    }[],
  ): Promise<{ question_ids: string[] }> {
    return unwrap(
      httpClient.post<ApiSuccess<{ question_ids: string[] }>>(
        `/assessment-versions/${versionId}/questions`,
        { questions },
      ),
    );
  },

  updateQuestion(
    questionId: string,
    payload: { question_text?: string; required?: boolean },
  ): Promise<{ id: string; question_text: string; required: boolean }> {
    return unwrap(
      httpClient.patch<ApiSuccess<{ id: string; question_text: string; required: boolean }>>(
        `/assessment-questions/${questionId}`,
        payload,
      ),
    );
  },

  /** The §25 act — one mapping at a time; there is deliberately no bulk form (§31). */
  confirmMapping(mappingId: string): Promise<{
    mapping_id: string;
    confirmed: boolean;
    publish_readiness: PublishReadiness;
  }> {
    return unwrap(
      httpClient.post<
        ApiSuccess<{ mapping_id: string; confirmed: boolean; publish_readiness: PublishReadiness }>
      >(`/question-dimensions/${mappingId}/confirm`),
    );
  },

  publish(versionId: string): Promise<BuilderVersionSummary> {
    return unwrap(
      httpClient.post<ApiSuccess<BuilderVersionSummary>>(
        `/assessment-versions/${versionId}/publish`,
      ),
    );
  },

  /** §31 Mode A — the text was extracted in THIS browser (the shared §33 utility). */
  generateFromDocument(versionId: string, extractedText: string): Promise<{ ai_request_id: string }> {
    return unwrap(
      httpClient.post<ApiSuccess<{ ai_request_id: string }>>(
        `/assessment-versions/${versionId}/ai-generate/document`,
        { extracted_text: extractedText },
      ),
    );
  },

  /** §31 Mode B — the template's own dimensions are the target set. */
  generateFromDescription(versionId: string, description: string): Promise<{ ai_request_id: string }> {
    return unwrap(
      httpClient.post<ApiSuccess<{ ai_request_id: string }>>(
        `/assessment-versions/${versionId}/ai-generate/description`,
        { description },
      ),
    );
  },

  generationStatus(aiRequestId: string): Promise<GenerationStatusResponse> {
    return unwrap(
      httpClient.get<ApiSuccess<GenerationStatusResponse>>(`/ai/requests/${aiRequestId}/status`),
    );
  },
};

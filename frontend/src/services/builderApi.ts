import { httpClient, unwrap } from '@/services/httpClient';
import type { ApiSuccess } from '@/types/api';
import type {
  AuthorQuestion,
  BuilderDimension,
  BuilderTemplate,
  BuilderVersionSummary,
  CompositeRange,
  GenerationStatusResponse,
  PublishReadiness,
  QuestionOptionDraft,
  QuestionPatch,
  QuestionType,
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
  /**
   * Creating an assessment lives in `assessmentAdminApi.create`, not here: since migration 0014 the
   * request must carry an assessment type and its scoring methods, and those are validated against
   * the compatibility matrix that the management screen already holds. A second create path here
   * would be one that always 422s.
   */
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

  /**
   * **How a published instrument is edited.** Copies a version whole — questions, options,
   * mappings and its full scoring config — into a new DRAFT, and hands back that draft.
   *
   * Distinct from `createVersion`, which mints an *empty* one. Both are needed: a genuinely new
   * edition of an instrument starts blank, while fixing a typo in RIASEC's sixty items must not.
   */
  duplicateVersion(versionId: string): Promise<BuilderVersionSummary> {
    return unwrap(
      httpClient.post<ApiSuccess<BuilderVersionSummary>>(
        `/assessment-versions/${versionId}/duplicate`,
      ),
    );
  },

  /**
   * **Retire one edition** (prompt §4) — including a published one.
   *
   * Not a delete, and nothing beneath it is deleted either: every attempt names its
   * `assessment_version_id`, so a result from last year still resolves to the exact questions it was
   * produced against. What changes is that students can no longer *start* it. An attempt already in
   * progress is unaffected — ending that is closing the assignment, which is a different act.
   */
  archiveVersion(versionId: string): Promise<BuilderVersionSummary> {
    return unwrap(
      httpClient.post<ApiSuccess<BuilderVersionSummary>>(
        `/assessment-versions/${versionId}/archive`,
      ),
    );
  },

  /** Back to PUBLISHED or DRAFT, whichever it was before. The server decides which. */
  restoreVersion(versionId: string): Promise<BuilderVersionSummary> {
    return unwrap(
      httpClient.post<ApiSuccess<BuilderVersionSummary>>(
        `/assessment-versions/${versionId}/restore`,
      ),
    );
  },

  /**
   * A DRAFT's composite weights (fractions) and bands. A published version 422s — its students were
   * scored under its weights, so it is re-weighted by duplicating it.
   */
  updateScoringConfig(
    versionId: string,
    payload: { composite_weights: Record<string, number>; composite_ranges: CompositeRange[] },
  ): Promise<BuilderVersionSummary> {
    return unwrap(
      httpClient.patch<ApiSuccess<BuilderVersionSummary>>(
        `/assessment-versions/${versionId}/scoring-config`,
        payload,
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
      question_type: QuestionType;
      section_label?: string | null;
      required?: boolean;
      options: QuestionOptionDraft[];
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

  /**
   * The builder's auto-save. Sends only the changed fields; the response is the whole question in
   * the author's shape, so an optimistic UI reconciles against what the server actually wrote
   * rather than against what it hoped it wrote.
   */
  updateQuestion(questionId: string, payload: QuestionPatch): Promise<AuthorQuestion> {
    return unwrap(
      httpClient.patch<ApiSuccess<AuthorQuestion>>(`/assessment-questions/${questionId}`, payload),
    );
  },

  /** Copy an item, appended last. The copy is MANUAL and confirmed — a human chose to make it. */
  duplicateQuestion(questionId: string): Promise<AuthorQuestion> {
    return unwrap(
      httpClient.post<ApiSuccess<AuthorQuestion>>(`/assessment-questions/${questionId}/duplicate`),
    );
  },

  deleteQuestion(questionId: string): Promise<{ id: string }> {
    return unwrap(
      httpClient.delete<ApiSuccess<{ id: string }>>(`/assessment-questions/${questionId}`),
    );
  },

  /**
   * The drag-and-drop save — **the whole order, never a delta**, which is what makes it idempotent
   * and its meaning independent of what the server currently holds.
   */
  reorderQuestions(versionId: string, questionIds: string[]): Promise<{ question_ids: string[] }> {
    return unwrap(
      httpClient.put<ApiSuccess<{ question_ids: string[] }>>(
        `/assessment-versions/${versionId}/question-order`,
        { question_ids: questionIds },
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

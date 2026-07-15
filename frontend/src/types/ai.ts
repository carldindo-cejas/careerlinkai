/**
 * The AI / Knowledge module's wire types (FULLPLAN §13.7, Phase 5a).
 */

export type ProcessingStatus = 'UPLOADED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface KnowledgeDocument {
  id: string;
  file_name: string;
  file_type: 'pdf' | 'docx';
  processing_status: ProcessingStatus;
  visibility: 'GLOBAL' | 'COUNSELOR_PRIVATE';
  /** Archived, never deleted (§13.7) — an archived document is unretrievable by the AI. */
  archived_at: string | null;
  chunk_count: number | null;
  created_at: string;
  updated_at: string;
}

export interface AiPolicy {
  id: string;
  scope: 'GLOBAL';
  /** Appended to every AI system prompt (§32). */
  instructions: string | null;
  restrictions: string | null;
  is_active: boolean;
  updated_at: string;
}

export interface UpdateAiPolicyPayload {
  instructions?: string | null;
  restrictions?: string | null;
  is_active?: boolean;
}

export interface RecommendationExplanation {
  id: string;
  recommendation_id: string;
  explanation_text: string;
  ai_model: string;
  created_at: string;
}

/**
 * `POST /student/recommendations/{id}/explain` — always a 200, whatever happened to the
 * model (§30): `explanation` is null when no AI paragraph exists, `fallback_reason` is the
 * deterministic §27 reason and is always present, and `failure` says why there is no
 * paragraph when there is none.
 */
export interface ExplainOutcome {
  explanation: RecommendationExplanation | null;
  fallback_reason: string;
  failure: string | null;
}

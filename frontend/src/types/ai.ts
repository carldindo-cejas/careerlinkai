/**
 * The AI / Knowledge module's wire types (FULLPLAN §13.7, Phase 5a).
 */

export type ProcessingStatus = 'UPLOADED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

/**
 * Where a knowledge entry came from (backend migration 0022). This replaced `file_type`, which
 * could only be `pdf | docx` — and that was the whole reason the corpus stayed empty: knowledge
 * could only enter the system as a file somebody had.
 */
export type KnowledgeSourceType = 'pdf' | 'docx' | 'text' | 'qa' | 'catalog';

export interface KnowledgeDocument {
  id: string;
  /** What a human calls this entry. The file name for an upload; the question for a Q&A pair. */
  title: string;
  file_name: string;
  source_type: KnowledgeSourceType;
  /** Set only on catalog-synced entries: which career, program or college this is about. */
  entity_type: 'career' | 'program' | 'college' | null;
  entity_id: string | null;
  processing_status: ProcessingStatus;
  visibility: 'GLOBAL' | 'COUNSELOR_PRIVATE';
  /** Archived, never deleted (§13.7) — an archived document is unretrievable by the AI. */
  archived_at: string | null;
  chunk_count: number | null;
  created_at: string;
  updated_at: string;
}

/** One entry plus the text it was written from — what the edit form loads. */
export interface KnowledgeEntryContent extends KnowledgeDocument {
  body: string;
}

/**
 * A knowledge entry an admin writes. The Q&A shape is the high-value one: it embeds close to how
 * a student actually phrases the question, and it is the answer that can be returned verbatim.
 */
export type KnowledgeEntryPayload =
  | { type: 'qa'; question: string; answer: string }
  | { type: 'text'; title: string; body: string };

export interface CatalogSyncResult {
  total: number;
  changed: number;
  /** Entries archived because their career or program left the catalog. */
  retired: number;
  /** Entries that did not fit this run's subrequest budget — press again to continue. */
  remaining: number;
  skipped?: string;
}

/** One question students asked that the knowledge base could not answer (Phase 4). */
export interface UnansweredQuestion {
  question: string;
  asks: number;
  last_asked_at: string;
}

/** A career or program with nothing in the corpus about it. */
export interface CoverageGap {
  kind: 'career' | 'program';
  id: string;
  label: string;
  /** An entry exists but never finished processing — one Reprocess away, not a missing sync. */
  stalled: boolean;
}

export interface AiInsights {
  unanswered_questions: UnansweredQuestion[];
  coverage: {
    careers: { total: number; covered: number };
    programs: { total: number; covered: number };
    gaps: CoverageGap[];
  };
  flagged_answers: {
    message_id: string;
    answer: string;
    question: string | null;
    ai_request_id: string | null;
    chunk_ids: string[];
    created_at: string | null;
  }[];
  corpus: { entries: number; chunks: number; embedded: number; failed: number };
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
  /** The knowledge entries this paragraph cited, shown under it. Empty when there are none. */
  sources: string[];
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

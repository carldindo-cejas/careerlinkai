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
  /** `guide` is a Guidance corpus entry (AI-COVERAGE-PLAN.md Phase 3). */
  entity_type: 'career' | 'program' | 'college' | 'guide' | null;
  entity_id: string | null;
  processing_status: ProcessingStatus;
  visibility: 'GLOBAL' | 'COUNSELOR_PRIVATE';
  /** Archived, never deleted (§13.7) — an archived document is unretrievable by the AI. */
  archived_at: string | null;
  chunk_count: number | null;
  /**
   * Who wrote this, and in what capacity (migration 0031).
   *
   * Counselors contribute to the same corpus admins do, so an entry now has two possible kinds of
   * author and the difference matters when reviewing a wrong answer: a school-published entry and
   * one counselor's note are different things to act on even when they read identically.
   *
   * `added_by` is the id, and it is what the UI actually branches on — "is this mine?" is the only
   * question a client can answer locally, and a name is not an identity. The name and role are for
   * reading. Null on a response that serialized a row without the author join.
   */
  added_by: string;
  added_by_name: string | null;
  added_by_role: 'admin' | 'counselor' | 'student' | null;
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
  | { type: 'qa'; question: string; answer: string; resolves_question?: string; also_resolves?: string[] }
  | { type: 'text'; title: string; body: string; resolves_question?: string; also_resolves?: string[] };

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
  /** The normalised identity — what makes two phrasings one row. A React key, never displayed. */
  key: string;
  question: string;
  asks: number;
  /**
   * How many students pressed *"Request to add to knowledge"* on this refusal (migration 0030).
   *
   * Usually 0. When it is not, this question sorts to the top of the backlog — a student asking
   * for an answer outranks the pipeline having failed to find one.
   */
  requests: number;
  last_asked_at: string;
  /**
   * Non-null means: **this already has an answer and was asked again anyway** (migration 0031).
   *
   * The rarest and most valuable row on the screen. Somebody wrote an entry for exactly this
   * question and the pipeline still failed to retrieve it, so writing a second entry is not the
   * fix — the retrieval is what needs looking at. The `asks` count on such a row covers only the
   * asks since that answer was written.
   */
  answered_at: string | null;
}

/** A question somebody has already dealt with — the other half of a backlog (migration 0031). */
export interface ResolvedQuestion {
  id: string;
  question: string;
  resolution: 'ANSWERED' | 'DISMISSED';
  document_id: string | null;
  /** Null once the entry is archived or failed — i.e. whenever the resolution has lapsed. */
  document_title: string | null;
  /**
   * False when this no longer suppresses anything and the question is back on the backlog. The
   * point of showing it: an answer that stopped counting is otherwise completely silent.
   */
  live: boolean;
  resolved_by: string;
  resolved_by_name: string;
  resolved_by_role: 'admin' | 'counselor' | 'student';
  resolved_at: string;
}

/** A career or program with nothing in the corpus about it. */
export interface CoverageGap {
  kind: 'career' | 'program';
  id: string;
  label: string;
  /** An entry exists but never finished processing — one Reprocess away, not a missing sync. */
  stalled: boolean;
}

/**
 * The AI-gaps report **header** — what stays on screen whichever tab is open.
 *
 * The lists it used to carry (`unanswered_questions`, `resolved_questions`, `coverage`,
 * `flagged_answers`) moved to one endpoint each when the screen became four tabs: a response that
 * carried a page of one list and all of another could not be paginated, and a visit that fetched
 * all four ran the catalog-coverage scan to render a backlog page nobody asked it of.
 */
export interface AiInsights {
  corpus: { entries: number; chunks: number; embedded: number; failed: number };
  /**
   * Which gate answered, per day, over the last two weeks (AI-COVERAGE-PLAN.md Phase 6). `tokens` is
   * the text model's token use that day — the input to the daily neuron budget.
   */
  gates?: {
    days: {
      date: string;
      curated: number;
      lookup: number;
      generated: number;
      refused: number;
      total: number;
      tokens: number;
    }[];
  };
  /**
   * The tab badges, counted server-side rather than read off each tab's pagination — so the number
   * on a tab is right before anybody has opened it.
   */
  counts: {
    unanswered: number;
    resolved: number;
    flagged: number;
  };
  /**
   * What this caller may do, **said by the server** rather than inferred from a role string.
   *
   * A client that derives its own permissions is a client that renders a button the API will
   * refuse — and the rule here is not a simple role test anyway (dismissing is admin-only for a
   * reason specific to dismissal, not because counselors are second-class contributors).
   */
  can: {
    dismiss_questions: boolean;
    sync_catalog: boolean;
    see_all_knowledge: boolean;
  };
}

/** One answer a student marked wrong, with the provenance needed to work out why. */
export interface FlaggedAnswer {
  message_id: string;
  answer: string;
  question: string | null;
  ai_request_id: string | null;
  chunk_ids: string[];
  created_at: string | null;
}

export interface CoverageReport {
  careers: { total: number; covered: number };
  programs: { total: number; covered: number };
  gaps: CoverageGap[];
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

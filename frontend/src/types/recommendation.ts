import type {
  CanonicalProgram,
  Career,
  College,
  Program,
  ProgramOffering,
} from '@/types/catalog';

/**
 * The Recommendation module's wire types (FULLPLAN §27, §13.6).
 *
 * `match_score` is a **number**, not a string — unlike `dimension_scores`, which arrive as
 * `"100.00"` because they are measurements whose trailing zeros carry the precision they were
 * computed to. A match score is a ranking figure (§28 renders `76.1`), and a client that has to
 * `parseFloat` a percentage before it can sort by it has been handed a chore.
 */

export type MatchType = 'CAREER' | 'PROGRAM';

interface RecommendationBase {
  id: string;
  match_type: MatchType;
  /** 0–100, one decimal. */
  match_score: number;
  /** 1 = best **within its own type**. A career's 69.1 and a program's 76.1 are not comparable. */
  ranking: number;
  /**
   * The deterministic §27 reason — computed, never a model call, and always present. §3: no
   * recommendation is shown without a reason. Phase 5a's AI explanation will elaborate on this
   * sentence; it will not replace it, so a student can be told *why* even when the model is down.
   */
  reason: string;
  created_at: string;
}

export interface CareerRecommendation extends RecommendationBase {
  match_type: 'CAREER';
  career: Career;
}

export interface ProgramRecommendation extends RecommendationBase {
  match_type: 'PROGRAM';
  program: Program;
  /** §13.6: a recommended college is a join, not a stored match — and it arrives already resolved. */
  college: College;
}

export interface RecommendationSet {
  /** The RIASEC result the ranking was computed over. */
  assessment_result_id: string;
  generated_at: string;
  careers: CareerRecommendation[];
  programs: ProgramRecommendation[];
}

// --- The recommendations chat assistant (migration 0019) -------------------------------------

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /**
   * The `ai_requests` row behind an assistant message, or null.
   *
   * Its absence is **meaningful**, not incidental: an assistant message with no request behind it
   * is the deterministic fallback built from the student's own computed results (§29), and the
   * panel labels it as such rather than passing computed text off as a generation.
   */
  ai_request_id: string | null;
  created_at: string | null;
}

export interface ChatTranscript {
  conversation_id: string | null;
  messages: ChatMessage[];
}

export interface ChatTurn {
  conversation_id: string;
  question: ChatMessage;
  answer: ChatMessage;
  /** `MODEL_UNAVAILABLE`, `QUOTA_EXHAUSTED`, `FAILED_VALIDATION`, … — null on a real generation. */
  failure: string | null;
}

// --- The two relationship lookups (migration 0018) -------------------------------------------

/** "Which college programs lead to this career?" */
export interface CareerProgramsResponse {
  career: Career;
  programs: { program: Program; college: College }[];
}

/** "Which colleges offer this program?" */
export interface ProgramCollegesResponse {
  canonical: CanonicalProgram | null;
  offerings: ProgramOffering[];
}

/**
 * How the Top-5 careers list is ordered (prompt-driven, 2026-07-27).
 *
 * `match` is the default and is the ranking §27 actually computed. The other two re-order the
 * *same* set on catalog facts the student can see on the card — they never change which careers
 * are in it, because that would be a second ranking the engine never made.
 */
export type CareerSort = 'match' | 'salary' | 'outlook';

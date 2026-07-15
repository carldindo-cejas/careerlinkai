import type { Career, College, Program } from '@/types/catalog';

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

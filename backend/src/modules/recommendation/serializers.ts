import { serializeCareer, serializeCollege, serializeProgram } from '@/modules/catalog/serializers';
import type {
  CareerRecommendation,
  ProgramRecommendation,
  RecommendationSet,
} from '@/modules/recommendation/recommendation-service';

/**
 * The Recommendation module's wire shapes (FULLPLAN §19).
 *
 * The catalog rows are serialized by **the catalog module's own serializers**, not re-mapped here.
 * A second hand-written mapping of `careers` would be a copy of a field list that some future
 * migration will change in one place and not the other — and the failure mode is silent: a card
 * that renders without a salary range because someone renamed a column and updated one of the two
 * serializers. §10 says a module owns its own wire shape; this module owns the *recommendation*,
 * and borrows the catalog's shape for the thing being recommended.
 *
 * `match_score` goes out as a **number**, not a string. `dimension_scores` are serialized as
 * `"100.00"` because they are a measurement and the trailing zeros carry the precision they were
 * computed to; a match score is a ranking figure §28 renders as `76.1`, and a client that has to
 * `parseFloat` a percentage before it can sort by it has been handed a chore, not a contract.
 */

function serializeBase(recommendation: CareerRecommendation['recommendation']) {
  return {
    id: recommendation.id,
    match_type: recommendation.matchType,
    match_score: recommendation.matchScore,
    /** 1 = best **within its own type**. A career's 69.1 and a program's 76.1 are not comparable. */
    ranking: recommendation.ranking,
    /**
     * The deterministic §27 reason. Always present, always computed, never a model call — §3's
     * "no recommendation is shown without a reason" is satisfied *here*, before any AI exists.
     * Phase 5a's explanation elaborates on this sentence and lives on its own table, so a student
     * can always be told why, even when the model is down.
     */
    reason: recommendation.reason,
    created_at: recommendation.createdAt,
  };
}

export function serializeCareerRecommendation({ recommendation, career }: CareerRecommendation) {
  return { ...serializeBase(recommendation), career: serializeCareer(career) };
}

export function serializeProgramRecommendation({
  recommendation,
  program,
  college,
}: ProgramRecommendation) {
  return {
    ...serializeBase(recommendation),
    program: serializeProgram(program),
    /**
     * §13.6: a recommended college is a **join**, not a stored match — `target_program_id →
     * programs.college_id → colleges`. Nested here rather than left for the client to fetch,
     * because "BS Computer Science" without an institution is not an answer to "where should I go?",
     * and a round trip per card to find out is the N+1 that reshaping `colleges` from a free-text
     * column into a real table (v1.1) existed to make unnecessary.
     */
    college: serializeCollege(college),
  };
}

export function serializeRecommendationSet(set: RecommendationSet) {
  return {
    /** The RIASEC result these were computed from — the Holland Code the cards sit next to. */
    assessment_result_id: set.assessmentResultId,
    generated_at: set.generatedAt,
    careers: set.careers.map(serializeCareerRecommendation),
    programs: set.programs.map(serializeProgramRecommendation),
  };
}

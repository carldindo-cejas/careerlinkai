import { describe, expect, it } from 'vitest';

import type { InterpretationRange, ScoringConfig } from '@/db/schema';
import {
  compositeIndex,
  interpret,
  score,
  type ScoringAnswer,
  type ScoringDimension,
  type ScoringQuestion,
} from '@/lib/scoring';

/**
 * §24's engine against the **Part VI worked examples** (§22, §23).
 *
 * §57 says to build the scorer first and check it against these numbers *before* any route
 * exists, and the reason is the same one that governs §28: a scoring engine tested only against
 * itself proves nothing. §22 works an Investigative raw score of 42/50 out to 84.0 and a Holland
 * Code of "IAS"; §23 works an SCCT composite out to 72.3. Those are the fixed points here.
 */

// RIASEC's 3-tier banding (§22), verbatim.
const RIASEC_BANDS: InterpretationRange[] = [
  { min: 0, max: 33.99, label: 'Low Interest' },
  { min: 34, max: 66.99, label: 'Moderate Interest' },
  { min: 67, max: 100, label: 'High Interest' },
];

const HOLLAND_CONFIG: ScoringConfig = { algorithm: 'HOLLAND_CODE_TOP3' };

/** The six RIASEC dimensions in canonical order — `orderNumber` *is* the tie-break (§22). */
const riasecDimensions = (): ScoringDimension[] =>
  ['R', 'I', 'A', 'S', 'E', 'C'].map((code, index) => ({
    id: `dim-${code}`,
    code,
    orderNumber: index + 1,
    interpretationRanges: RIASEC_BANDS,
  }));

/** `n` five-point Likert items loading onto one dimension at weight 1.00 (§22's setup). */
const likertQuestions = (dimensionId: string, count: number, prefix: string): ScoringQuestion[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    maxOptionScore: 5,
    dimensions: [{ dimensionId, weight: 1 }],
  }));

const answersFor = (prefix: string, scores: number[]): ScoringAnswer[] =>
  scores.map((value, i) => ({ questionId: `${prefix}-${i}`, score: value }));

describe('§22 worked example — RIASEC', () => {
  it('normalizes 42 of a possible 50 to 84.0, banded "High Interest"', () => {
    // Student answers 10 Investigative questions: 5,4,5,3,4,5,4,3,5,4 → raw 42, max 50 → 84.0
    const result = score({
      config: HOLLAND_CONFIG,
      dimensions: riasecDimensions(),
      questions: likertQuestions('dim-I', 10, 'q-I'),
      answers: answersFor('q-I', [5, 4, 5, 3, 4, 5, 4, 3, 5, 4]),
    });

    expect(result.dimensionScores).toHaveLength(1);
    expect(result.dimensionScores[0]).toMatchObject({
      code: 'I',
      rawScore: 42,
      normalizedScore: 84,
      interpretation: 'High Interest',
    });
  });

  it('derives the Holland Code "IAS" from §22’s six dimension scores', () => {
    // I = 84.0, A = 71.0, S = 62.0, C = 55.0, E = 48.0, R = 30.0 → top three: I, A, S
    const result = score(scoredProfile({ I: 84, A: 71, S: 62, C: 55, E: 48, R: 30 }));

    expect(result.resultCode).toBe('IAS');
    expect(result.overallSummary).toBeNull(); // RIASEC produces a code, not a composite.
  });

  /**
   * The tie-break is why `order_number` is scoring data. Without it a student with I = A = 71.0
   * gets whichever dimension the database happened to return first, and their Holland Code is a
   * fact about row ordering rather than about them.
   */
  it('tie-breaks on the canonical R > I > A > S > E > C order', () => {
    const result = score(scoredProfile({ I: 71, A: 71, R: 71, S: 10, E: 10, C: 10 }));

    expect(result.resultCode).toBe('RIA');
  });

  it('produces a shorter code rather than inventing a third letter', () => {
    const dimensions = riasecDimensions();

    const result = score({
      config: HOLLAND_CONFIG,
      dimensions,
      questions: [
        ...likertQuestions('dim-I', 1, 'q-I'),
        ...likertQuestions('dim-A', 1, 'q-A'),
      ],
      answers: [...answersFor('q-I', [5]), ...answersFor('q-A', [4])],
    });

    expect(result.resultCode).toBe('IA');
  });
});

describe('§23 worked example — SCCT', () => {
  const SCCT_CONFIG: ScoringConfig = {
    algorithm: 'WEIGHTED_COMPOSITE',
    composite_weights: { SE: 0.4, OE: 0.3, GO: 0.3 },
    composite_ranges: [
      { min: 0, max: 33.99, label: 'Low' },
      { min: 34, max: 66.99, label: 'Moderate' },
      { min: 67, max: 79.99, label: 'Moderately High' },
      { min: 80, max: 100, label: 'High' },
    ],
  };

  const scctDimensions: ScoringDimension[] = [
    { id: 'dim-SE', code: 'SE', orderNumber: 1, interpretationRanges: null },
    { id: 'dim-OE', code: 'OE', orderNumber: 2, interpretationRanges: null },
    { id: 'dim-GO', code: 'GO', orderNumber: 3, interpretationRanges: null },
  ];

  /** SE = 78.0, OE = 65.0, GO = 72.0 — §23's numbers, reached through real answers. */
  const scctInput = () => ({
    config: SCCT_CONFIG,
    dimensions: scctDimensions,
    questions: [
      ...likertQuestions('dim-SE', 10, 'q-SE'),
      ...likertQuestions('dim-OE', 10, 'q-OE'),
      ...likertQuestions('dim-GO', 10, 'q-GO'),
    ],
    answers: [
      // 39/50 = 78.0
      ...answersFor('q-SE', [4, 4, 4, 4, 4, 4, 4, 4, 4, 3]),
      // 32.5/50 = 65.0
      ...answersFor('q-OE', [3, 3, 3, 3, 3, 3, 3, 3, 3, 5.5]),
      // 36/50 = 72.0
      ...answersFor('q-GO', [4, 4, 4, 4, 4, 4, 4, 4, 2, 2]),
    ],
  });

  it('computes the Career Confidence Index as 72.3', () => {
    // (78.0 × 0.40) + (65.0 × 0.30) + (72.0 × 0.30) = 31.2 + 19.5 + 21.6 = 72.3
    const { dimensionScores } = score(scctInput());

    expect(compositeIndex(dimensionScores, SCCT_CONFIG)).toBeCloseTo(72.3, 6);
  });

  it('bands 72.3 as "Moderately High Career Confidence"', () => {
    const result = score(scctInput());

    expect(result.overallSummary).toBe('Moderately High Career Confidence.');
    expect(result.resultCode).toBeNull(); // SCCT produces a composite, not a code.
  });

  /**
   * §23 (v1.2): `overall_summary` is display-only and **nothing may parse a number back out of
   * it**. The surest way to enforce that is to leave no number in it to parse. Part VII calls
   * `compositeIndex()` instead — which is the assertion above.
   */
  it('puts no number in the summary prose at all', () => {
    const result = score(scctInput());

    expect(result.overallSummary).not.toMatch(/\d/);
  });
});

describe('prorating (§24, v1.2)', () => {
  /**
   * An unanswered question contributes to neither `raw` nor `max`. Skipping an optional item must
   * not deflate the score — the student simply was not asked to weigh in on it.
   */
  it('excludes an unanswered question from both raw and max', () => {
    const result = score({
      config: HOLLAND_CONFIG,
      dimensions: riasecDimensions(),
      questions: likertQuestions('dim-I', 10, 'q-I'),
      // Five answered at 4/5; five skipped. 20/25 = 80.0 — *not* 20/50 = 40.0.
      answers: answersFor('q-I', [4, 4, 4, 4, 4]),
    });

    expect(result.dimensionScores[0]?.rawScore).toBe(20);
    expect(result.dimensionScores[0]?.normalizedScore).toBe(80);
  });

  /**
   * **An absent dimension is not a zero** (§24). A stored 0.00 would be sorted into the Holland
   * Code as a real dimension and averaged into a recommendation as a real number — a false claim
   * about the student, not a conservative one.
   */
  it('writes no row at all when every question on a dimension was skipped', () => {
    const result = score({
      config: HOLLAND_CONFIG,
      dimensions: riasecDimensions(),
      questions: [
        ...likertQuestions('dim-I', 2, 'q-I'),
        ...likertQuestions('dim-R', 2, 'q-R'),
      ],
      answers: answersFor('q-I', [5, 5]), // R is never answered.
    });

    expect(result.dimensionScores.map((d) => d.code)).toEqual(['I']);
    expect(result.dimensionScores.find((d) => d.code === 'R')).toBeUndefined();
    // And the unmeasured dimension contributes no letter to the code.
    expect(result.resultCode).toBe('I');
  });
});

describe('weighting', () => {
  it('applies the mapping weight to both raw and max, so the ratio stays honest', () => {
    // One item at weight 2.0, answered 4/5. raw = 8, max = 10 → 80.0, same as an unweighted 4/5.
    const result = score({
      config: HOLLAND_CONFIG,
      dimensions: riasecDimensions(),
      questions: [{ id: 'q1', maxOptionScore: 5, dimensions: [{ dimensionId: 'dim-I', weight: 2 }] }],
      answers: [{ questionId: 'q1', score: 4 }],
    });

    expect(result.dimensionScores[0]).toMatchObject({ rawScore: 8, normalizedScore: 80 });
  });

  it('lets one question load onto two dimensions at different weights', () => {
    const result = score({
      config: HOLLAND_CONFIG,
      dimensions: riasecDimensions(),
      questions: [
        {
          id: 'q1',
          maxOptionScore: 5,
          dimensions: [
            { dimensionId: 'dim-I', weight: 1 },
            { dimensionId: 'dim-A', weight: 0.5 },
          ],
        },
      ],
      answers: [{ questionId: 'q1', score: 4 }],
    });

    // Both normalize to 80 — the weight scales raw and max together — but the raw scores differ.
    expect(result.dimensionScores.find((d) => d.code === 'I')).toMatchObject({ rawScore: 4 });
    expect(result.dimensionScores.find((d) => d.code === 'A')).toMatchObject({ rawScore: 2 });
  });
});

describe('the ungraded CUSTOM path (§24, §25)', () => {
  /**
   * An assessment with no dimensions is reflection-only. It is still SCORED and still fires
   * AssessmentCompleted: "the student finished" is true whether or not anything was measured.
   */
  it('produces a result with no scores and no code, rather than failing', () => {
    const result = score({
      config: { algorithm: 'HOLLAND_CODE_TOP3' },
      dimensions: [],
      questions: [{ id: 'q1', maxOptionScore: 5, dimensions: [] }],
      answers: [{ questionId: 'q1', score: 3 }],
    });

    expect(result).toEqual({ dimensionScores: [], resultCode: null, overallSummary: null });
  });
});

describe('compositeIndex', () => {
  const config: ScoringConfig = {
    algorithm: 'WEIGHTED_COMPOSITE',
    composite_weights: { SE: 0.4, OE: 0.3, GO: 0.3 },
  };

  const scored = (code: string, normalizedScore: number) => ({
    dimensionId: `dim-${code}`,
    code,
    rawScore: 0,
    normalizedScore,
    interpretation: null,
  });

  it('is the weighted mean of the measured dimensions', () => {
    expect(
      compositeIndex([scored('SE', 78), scored('OE', 65), scored('GO', 72)], config),
    ).toBeCloseTo(72.3, 6);
  });

  /**
   * The same reasoning as prorating: a dimension that was never measured must not be scored as a
   * zero, which would drag the index down as though the student had answered and answered badly.
   * The remaining weights are renormalized instead.
   */
  it('renormalizes the weights when a dimension was not measured', () => {
    // Only SE (0.40) and OE (0.30) measured → (78×0.4 + 65×0.3) / 0.7 = 72.428…
    const index = compositeIndex([scored('SE', 78), scored('OE', 65)], config);

    expect(index).toBeCloseTo((78 * 0.4 + 65 * 0.3) / 0.7, 6);
    // And emphatically not the un-renormalized 51.7, which is what treating GO as 0 would give.
    expect(index).toBeGreaterThan(70);
  });

  it('is null when nothing was measured — an index over no dimensions is undefined, not 0', () => {
    expect(compositeIndex([], config)).toBeNull();
  });

  it('degrades to a plain mean when no configured weight matches, rather than fabricating a 0', () => {
    const misconfigured: ScoringConfig = {
      algorithm: 'WEIGHTED_COMPOSITE',
      composite_weights: { NOPE: 1 },
    };

    expect(compositeIndex([scored('SE', 80), scored('OE', 60)], misconfigured)).toBe(70);
  });
});

describe('interpret', () => {
  it('maps a score into its band', () => {
    expect(interpret(RIASEC_BANDS, 84)).toBe('High Interest');
    expect(interpret(RIASEC_BANDS, 50)).toBe('Moderate Interest');
    expect(interpret(RIASEC_BANDS, 0)).toBe('Low Interest');
  });

  it('has no label when the instrument defines no bands', () => {
    expect(interpret(null, 84)).toBeNull();
    expect(interpret([], 84)).toBeNull();
  });

  it('returns null rather than guessing at a score the bands do not cover', () => {
    // 33.995 falls in the gap between §22's own bands. That gap is the instrument's, not ours.
    expect(interpret(RIASEC_BANDS, 33.995)).toBeNull();
  });
});

/**
 * Build a scoring input that lands each dimension on an exact normalized score, through real
 * answers rather than by asserting on hand-placed `dimension_scores` rows — the engine has to do
 * the arithmetic for the test to mean anything.
 */
function scoredProfile(target: Record<string, number>) {
  const dimensions = riasecDimensions();
  const questions: ScoringQuestion[] = [];
  const answers: ScoringAnswer[] = [];

  for (const [code, normalized] of Object.entries(target)) {
    const questionId = `q-${code}`;

    // One 100-point question per dimension: the answer's score *is* the normalized score.
    questions.push({
      id: questionId,
      maxOptionScore: 100,
      dimensions: [{ dimensionId: `dim-${code}`, weight: 1 }],
    });
    answers.push({ questionId, score: normalized });
  }

  return { config: HOLLAND_CONFIG, dimensions, questions, answers };
}

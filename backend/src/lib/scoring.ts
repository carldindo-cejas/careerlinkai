import type { InterpretationRange, ScoringConfig } from '@/db/schema';

/**
 * §24's generic scoring engine — **one algorithm with two configurations**, and the whole point
 * of it is that a third instrument is added by writing data (dimensions, questions, a
 * `scoring_config`), never by writing new scoring code. `CUSTOM` assessments therefore run down
 * exactly the same path as RIASEC and SCCT; no "custom scoring" branch exists anywhere.
 *
 * This file is **pure**: no database, no clock, no I/O. §57 says to build the scorer first and
 * unit-test it standalone against the Part VI worked examples *before* wiring any route, and
 * that instruction is only executable if the scorer can run without a Worker around it. The
 * service (`scoring-service.ts`) is the shell that loads rows, calls this, and persists; every
 * decision worth arguing about is here.
 *
 * ## The three rules that look like edge cases and are not
 *
 * 1. **Prorating** (v1.2): an unanswered question contributes to neither `raw` nor `max`. It is
 *    only reachable for an *optional* question — submission is blocked while any REQUIRED one is
 *    unanswered — and that block is what makes prorating safe rather than catastrophic. Without
 *    it a student could answer one Investigative item with a 5, skip the other 59, and walk out
 *    with a perfect and entirely meaningless `I`.
 * 2. **`max === 0` writes no row at all.** An absent dimension means "not measured", which is a
 *    different and more honest claim than a zero. A stored `0.00` would be sorted into a Holland
 *    Code as a real dimension and averaged into a recommendation as a real number.
 * 3. **An assessment with no dimensions is still scored** — it is an ungraded, reflection-only
 *    CUSTOM assessment (§25). It gets a result row with a null code, and it still fires
 *    `AssessmentCompleted`, because "the student finished" is true regardless of whether anything
 *    was measured.
 */

// --- Inputs (plain data — the service projects DB rows into these) ---------------------------

export interface ScoringDimension {
  id: string;
  code: string;
  /**
   * **Scoring data, not display order** (§22, §24). It is the Holland-code tie-break: a student
   * with I = A = 71.0 must get a deterministic code, not whichever row the database returned
   * first.
   */
  orderNumber: number;
  interpretationRanges: InterpretationRange[] | null;
}

export interface ScoringQuestion {
  id: string;
  /** The highest score obtainable on this question — its `max_option_score` (§24). */
  maxOptionScore: number;
  /** Its `question_dimensions` mappings. A question may load onto more than one dimension. */
  dimensions: { dimensionId: string; weight: number }[];
}

/** One answer's **snapshotted** score (§13.5) — never re-derived from `question_options`. */
export interface ScoringAnswer {
  questionId: string;
  score: number;
}

export interface ScoringInput {
  config: ScoringConfig;
  dimensions: ScoringDimension[];
  questions: ScoringQuestion[];
  answers: ScoringAnswer[];
}

// --- Outputs --------------------------------------------------------------------------------

export interface ScoredDimension {
  dimensionId: string;
  code: string;
  rawScore: number;
  normalizedScore: number;
  interpretation: string | null;
}

export interface ScoringOutput {
  /** Only the dimensions that were actually measured. A skipped one is **absent**, not zero. */
  dimensionScores: ScoredDimension[];
  /** "IAS" for `HOLLAND_CODE_TOP3`; null for `WEIGHTED_COMPOSITE` and for an ungraded CUSTOM. */
  resultCode: string | null;
  /** Display-only prose (§23). Nothing may ever parse a number back out of it. */
  overallSummary: string | null;
}

/** §22's Holland Code takes the top three dimensions. */
const HOLLAND_CODE_LENGTH = 3;

// --- The engine ------------------------------------------------------------------------------

export function score(input: ScoringInput): ScoringOutput {
  const { config, dimensions, questions, answers } = input;

  // An ungraded, reflection-only CUSTOM assessment (§24/§25). Answers are still stored; nothing
  // is measured, so nothing is claimed.
  if (dimensions.length === 0) {
    return { dimensionScores: [], resultCode: null, overallSummary: null };
  }

  const answerByQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));

  const dimensionScores: ScoredDimension[] = [];

  for (const dimension of dimensions) {
    let raw = 0;
    let max = 0;

    for (const question of questions) {
      const mapping = question.dimensions.find((m) => m.dimensionId === dimension.id);

      if (mapping === undefined) {
        continue; // This question does not load onto this dimension.
      }

      const answer = answerByQuestion.get(question.id);

      if (answer === undefined) {
        // Prorate (v1.2). Only reachable for an optional question — see rule 1 in the header.
        // It contributes to neither `raw` nor `max`, so skipping it cannot deflate the score.
        continue;
      }

      raw += answer.score * mapping.weight;
      max += question.maxOptionScore * mapping.weight;
    }

    if (max === 0) {
      // Every question on this dimension was optional and skipped. Write **no row** — see rule 2.
      continue;
    }

    const normalizedScore = (raw / max) * 100;

    dimensionScores.push({
      dimensionId: dimension.id,
      code: dimension.code,
      rawScore: raw,
      normalizedScore,
      interpretation: interpret(dimension.interpretationRanges, normalizedScore),
    });
  }

  if (config.algorithm === 'WEIGHTED_COMPOSITE') {
    const composite = compositeIndex(dimensionScores, config);

    return {
      dimensionScores,
      resultCode: null,
      overallSummary: composite === null ? null : formatCompositeSummary(composite, config),
    };
  }

  return {
    dimensionScores,
    resultCode: hollandCode(dimensionScores, dimensions),
    overallSummary: null,
  };
}

/**
 * §22's Holland Code: the top three dimensions, descending, **tie-broken on the instrument's
 * canonical order** (`order_number`, which for RIASEC is R > I > A > S > E > C).
 *
 * The tie-break is the reason `order_number` is scoring data rather than a display preference.
 * Without it, a student with I = A = 71.0 gets whichever dimension the database happened to
 * return first — and their Holland Code becomes a fact about row ordering rather than about them.
 *
 * Fewer than three measured dimensions yields a shorter code rather than a padded one: there is
 * no third letter to invent.
 */
function hollandCode(
  dimensionScores: ScoredDimension[],
  dimensions: ScoringDimension[],
): string | null {
  if (dimensionScores.length === 0) {
    return null;
  }

  const orderByDimension = new Map(dimensions.map((d) => [d.id, d.orderNumber]));
  const canonicalOrder = (scored: ScoredDimension) =>
    orderByDimension.get(scored.dimensionId) ?? Number.MAX_SAFE_INTEGER;

  return [...dimensionScores]
    .sort(
      (a, b) => b.normalizedScore - a.normalizedScore || canonicalOrder(a) - canonicalOrder(b),
    )
    .slice(0, HOLLAND_CODE_LENGTH)
    .map((scored) => scored.code)
    .join('');
}

/**
 * §23's Career Confidence Index — **the number Part VII actually consumes.**
 *
 * Exported, and deliberately so: every consumer recomputes the index from the `dimension_scores`
 * rows plus the version's `scoring_config`, and **nothing ever parses it back out of
 * `overall_summary`** (§23, v1.2 — "a numeric value round-tripping through prose was a bug
 * waiting to happen"). This function is what "recompute" means; the prose is a dead end by design.
 *
 * A weight for a dimension that was never measured is simply not applied, and the remaining
 * weights are **renormalized** — the same reasoning as prorating. Scoring an unmeasured
 * dimension as 0 would drag the index down as though the student had answered and answered
 * badly. Returns `null` when nothing was measured at all: an index over no dimensions is not 0,
 * it is undefined.
 */
export function compositeIndex(
  dimensionScores: ScoredDimension[],
  config: ScoringConfig,
): number | null {
  if (dimensionScores.length === 0) {
    return null;
  }

  const weights = config.composite_weights ?? {};

  let weighted = 0;
  let weightSum = 0;

  for (const scored of dimensionScores) {
    const weight = weights[scored.code];

    if (weight === undefined) {
      continue;
    }

    weighted += scored.normalizedScore * weight;
    weightSum += weight;
  }

  if (weightSum === 0) {
    // No configured weight matched a measured dimension. Fall back to a plain mean rather than
    // claiming 0 — a misconfigured `scoring_config` should degrade, not fabricate a low score.
    const mean =
      dimensionScores.reduce((sum, s) => sum + s.normalizedScore, 0) / dimensionScores.length;

    return mean;
  }

  return weighted / weightSum;
}

/**
 * Display-only prose (§23). Note what is **not** in it: the number. That is not an oversight —
 * §23 forbids any consumer from parsing a value back out of this string, and the surest way to
 * enforce that is to leave nothing there to parse. The dimension breakdown carries the numbers.
 */
function formatCompositeSummary(composite: number, config: ScoringConfig): string {
  const label = interpret(config.composite_ranges ?? null, composite);

  return label === null ? 'Career Confidence measured.' : `${label} Career Confidence.`;
}

/**
 * Turn a normalized score into its band label (§22). An out-of-band score has no label rather
 * than a guessed one — the bands are the instrument's claim about what a number means, and a
 * score they do not cover is a gap in the instrument, not something to paper over.
 */
export function interpret(
  ranges: InterpretationRange[] | null,
  normalizedScore: number,
): string | null {
  if (ranges === null || ranges.length === 0) {
    return null;
  }

  const band = ranges.find(
    (range) => normalizedScore >= range.min && normalizedScore <= range.max,
  );

  return band?.label ?? null;
}

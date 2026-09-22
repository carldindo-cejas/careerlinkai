/**
 * **The shape of the §27 formula, and the values it ships with.**
 *
 * Every number the matching engine multiplies by used to be a `const` in `lib/recommendation.ts`.
 * They are now the fields of one object, and the engine takes that object as an argument. Nothing
 * about the arithmetic changed — `DEFAULT_FORMULA` below *is* the set of constants that were there,
 * and an engine call that names no formula still gets exactly them.
 *
 * ## Why this file exists
 *
 * Because "how much should SCCT confidence count?" is a question the school answers, not one the
 * deploy pipeline answers. Re-weighting a composite meant editing a TypeScript constant, running
 * the test suite and shipping a Worker — an hour of an engineer's day for a decision a guidance
 * office is better placed to make than we are. `FormulaService` persists one of these in
 * `app_settings` and the engine reads it per run, so the same change is a form and a save.
 *
 * ## What stays out of reach
 *
 * The *structure* is not configurable — which components exist, how each one is computed, and the
 * fact that an absent signal is neutral rather than a penalty. Those are §27's claims about what a
 * match score means, and a screen that let an operator delete `careerAlignment` or make a blank
 * strand score 0 would be a screen for rewriting the instrument, not for tuning it. What is
 * configurable is how loudly each component speaks and where its neutral points sit.
 *
 * This file is pure data and pure arithmetic — no zod, no database, no I/O — for the same reason
 * `lib/recommendation.ts` is: §26's reproducibility claim is only checkable if the numbers can be
 * run against a worked example without a runtime. Validation lives one layer up, in
 * `modules/recommendation/formula-service.ts`, where the stored row is parsed.
 */

/** The career composite's three terms. Weights, summing to 1.00 (§27). */
export interface CareerWeights {
  riasecCompatibility: number;
  careerConfidence: number;
  studentPreference: number;
}

/** The program composite's five terms. Weights, summing to 1.00 — see `PROGRAM_WEIGHTS`. */
export interface ProgramWeights {
  riasecCompatibility: number;
  careerAlignment: number;
  careerConfidence: number;
  academicFit: number;
  strandAlignment: number;
}

/**
 * The values §27 falls back to when a signal is **absent**.
 *
 * Every one of these is a neutral or neutral-leaning-positive number, and that is the rule the
 * screen states rather than a coincidence of the defaults: an unfilled profile field is not a wrong
 * answer. `strandMismatch` is the one entry that is a genuine penalty — the student's track is
 * known and it is not the one the program expects — and even that is 40 rather than 0, because
 * §27's standing instruction is that the platform advises and does not gatekeep.
 */
export interface NeutralValues {
  /**
   * §27's student-preference term, a constant for every career match until a real preference input
   * ships (§63). Being constant it shifts every career score equally and changes no ranking.
   */
  studentPreference: number;
  /** A career or program with no Holland code to compare against. */
  riasec: number;
  /** A student who filled in none of Math, Science and English. */
  academicUnknown: number;
  /** A student with no strand on file — unknown, not mismatched. */
  strandUnknown: number;
  /** A known strand that is not the one the program expects. */
  strandMismatch: number;
  /** A strand that matches, or a program with no strand requirement to fail. */
  strandAligned: number;
}

/**
 * The two anchors `academicFit` interpolates between: the Philippine SHS passing minimum and a
 * practical high-end anchor. A grade at or below the floor scores 0, at or above the ceiling 100.
 */
export interface AcademicAnchors {
  floor: number;
  ceiling: number;
}

export interface ScoringFormula {
  career: CareerWeights;
  program: ProgramWeights;
  /**
   * Position weights for a Holland code — the first letter is the dominant type, which is how
   * Holland Code interpretation itself works (`IEC` and `CEI` are different careers). Renormalized
   * by the engine for a code shorter than three letters, so what matters here is the *ratio*
   * between them; they are kept summing to 1 so the screen can show them as percentages.
   */
  positionWeights: [number, number, number];
  /**
   * How many of a program's linked careers vote on `careerAlignment`, and how loudly. Three, not
   * one — a single `max()` would hand a quarter of a program's score to one catalog row typed by an
   * admin. Renormalized when fewer than three careers are linked.
   */
  careerAlignmentDepth: [number, number, number];
  neutrals: NeutralValues;
  academic: AcademicAnchors;
    /**
   * How much each kind of program → career link counts (migration 0041). `direct` is the program's
   * natural destination and is fixed at 1; `related` and `conditional` count for less. A lighter
   * link pulls its career's contribution toward **neutral**, never toward zero — a related career
   * is weaker evidence, not evidence against.
   */
  linkWeights: LinkWeights;
  /** How many matches of each kind are persisted per student (§27 keeps ten). */
  topN: number;
}

export interface LinkWeights {
  /** Fixed: a direct link is the program's own destination, and always counts fully. */
  direct: 1;
  related: number;
  conditional: number;
}

/**
 * **What the engine does when nobody has configured anything** — the §27 constants as they stood
 * on 2026-09-18, unchanged.
 *
 * A missing row, an unparseable row and a row from a future version this deployment cannot read all
 * resolve to exactly this (see `FormulaService.get`). That matters more than it looks: every score
 * on every student's screen comes out of here, so the failure mode of the configuration layer has
 * to be "the system scores the way it always did", never "the system stops scoring".
 */
export const DEFAULT_FORMULA: ScoringFormula = {
  career: {
    riasecCompatibility: 0.6,
    careerConfidence: 0.3,
    studentPreference: 0.1,
  },
  /*
    Read the program weights as two halves. `riasecCompatibility` + `careerAlignment` = 0.60 is
    **the careers this program leads to**, seen twice: once in breadth (the average over all of
    them) and once in depth (the best few, on the student's own career scale). The remaining 0.40 is
    the student: how confident they are, how their grades sit against the academic band, and whether
    the track they are on is the one the program expects.
  */
  program: {
    riasecCompatibility: 0.35,
    careerAlignment: 0.25,
    careerConfidence: 0.2,
    academicFit: 0.1,
    strandAlignment: 0.1,
  },
  positionWeights: [0.5, 0.3, 0.2],
  careerAlignmentDepth: [0.6, 0.25, 0.15],
  neutrals: {
    studentPreference: 70,
    riasec: 50,
    academicUnknown: 60,
    strandUnknown: 70,
    strandMismatch: 40,
    strandAligned: 100,
  },
  academic: { floor: 75, ceiling: 95 },
  /*
    Added 2026-09-22 with migration 0041, which made every existing link `direct` — so these
    defaults change no score anywhere until an administrator grades a link as related or
    conditional.
  */
  linkWeights: { direct: 1, related: 0.7, conditional: 0.5 },
  topN: 10,
};

/**
 * How far a set of weights may sit from 1.00 and still be accepted.
 *
 * Not zero, because `0.35 + 0.25 + 0.2 + 0.1 + 0.1` is not 1 in binary floating point and an
 * operator typing the defaults back in must not be told they are wrong. Not loose either: at 0.01 a
 * five-term composite could legitimately sum to 0.95, which silently rescales every score on every
 * student's screen by five percent.
 */
export const WEIGHT_SUM_TOLERANCE = 1e-6;

export function sumOf(weights: object): number {
  return Object.values(weights).reduce<number>(
    (total, weight) => total + (weight as number),
    0,
  );
}

/** Whether a weight set is normalized, within `WEIGHT_SUM_TOLERANCE`. */
export function sumsToOne(weights: number[]): boolean {
  return (
    Math.abs(weights.reduce((total, weight) => total + weight, 0) - 1) <= WEIGHT_SUM_TOLERANCE
  );
}

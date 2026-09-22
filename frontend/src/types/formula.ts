/**
 * The §27 match formula, as the admin screen edits it.
 *
 * **camelCase, unlike every other type in this folder**, and deliberately: these keys are not
 * database columns renamed for the wire, they are the component names the scoring engine multiplies
 * by. The server sends them unchanged and takes them back unchanged (see `serializeFormula`), so
 * renaming them here would add two mappings whose only job is to undo each other — and whose first
 * divergence would be a weight silently dropped from a composite.
 */

/** The career composite's three terms. Fractions, summing to 1. */
export interface CareerWeights {
  riasecCompatibility: number;
  careerConfidence: number;
  studentPreference: number;
}

/** The program composite's five terms. Fractions, summing to 1. */
export interface ProgramWeights {
  riasecCompatibility: number;
  careerAlignment: number;
  careerConfidence: number;
  academicFit: number;
  strandAlignment: number;
}

/** What a score falls back to when the signal behind a component is missing. 0–100. */
export interface NeutralValues {
  studentPreference: number;
  riasec: number;
  academicUnknown: number;
  strandUnknown: number;
  strandMismatch: number;
  strandAligned: number;
}

export interface AcademicAnchors {
  floor: number;
  ceiling: number;
}

export interface ScoringFormula {
  career: CareerWeights;
  program: ProgramWeights;
  /** Holland code positions: how much the first, second and third letter each count. */
  positionWeights: number[];
  /** How loudly the best, second-best and third-best linked career vote on career alignment. */
  careerAlignmentDepth: number[];
  neutrals: NeutralValues;
  academic: AcademicAnchors;
  /**
   * How much each kind of program → career link counts (backend migration 0041). `direct` is fixed
   * at 1; a lighter link pulls its career toward neutral, never toward zero.
   */
  linkWeights: LinkWeights;
  /** How many matches of each kind are kept per student. */
  topN: number;
}

export interface LinkWeights {
  direct: 1;
  related: number;
  conditional: number;
}

/** `GET /admin/recommendation-formula` — the current formula, its provenance, and what shipped. */
export interface ScoringFormulaResponse {
  formula: ScoringFormula;
  /** True while nothing has been saved: the deployment is running the shipped weights. */
  is_default: boolean;
  updated_at: string | null;
  updated_by_name: string | null;
  /**
   * What the release ships, sent with every read rather than copied into this app.
   *
   * The screen marks each field that differs from it and offers to restore them, and a frontend
   * copy of these numbers would be a second source of truth that drifts the first time a release
   * tunes one.
   */
  defaults: ScoringFormula;
  /**
   * How many students currently hold a recommendation set.
   *
   * A re-weighting applies to scores computed from then on; it does not rewrite rows that already
   * exist. This is the size of what has not caught up, and the screen says so plainly rather than
   * letting an admin discover it from a confused counselor.
   */
  students_with_recommendations: number;
}

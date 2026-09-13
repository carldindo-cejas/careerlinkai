/**
 * The interpretation bands both printed reports use (docs_report/ — the approved exports).
 *
 * Anchored on the 1–5 item mean rather than on the percentage: a 5-point Likert item floors at 1,
 * so a normalized score floors at 20 and the five tiers are equal fifths of the *reachable* range,
 * not of 0–100. `mean = score / 20` because score = (raw ÷ max) × 100 and max is 5 per item.
 *
 * The same cut points the instruments themselves band on (backend migration 0035), so the stored
 * `interpretation` and this label always agree. The engine's label carries the noun ("High
 * Interest", "High Confidence"); the printed band column is the table's bare word.
 */

export interface LikertBand {
  label: string;
  /** Inclusive, on the 1–5 item mean. */
  meanMin: number;
  meanMax: number;
  /** Inclusive, on the normalized 0–100 score. */
  scoreMin: number;
  scoreMax: number;
}

const VERY_LOW: LikertBand = {
  label: 'Very Low',
  meanMin: 1.0,
  meanMax: 1.79,
  scoreMin: 20.0,
  scoreMax: 35.9,
};

export const LIKERT_BANDS: readonly LikertBand[] = [
  VERY_LOW,
  { label: 'Low', meanMin: 1.8, meanMax: 2.59, scoreMin: 36.0, scoreMax: 51.9 },
  { label: 'Moderate', meanMin: 2.6, meanMax: 3.39, scoreMin: 52.0, scoreMax: 67.9 },
  { label: 'High', meanMin: 3.4, meanMax: 4.19, scoreMin: 68.0, scoreMax: 83.9 },
  { label: 'Very High', meanMin: 4.2, meanMax: 5.0, scoreMin: 84.0, scoreMax: 100.0 },
];

export function itemMean(normalizedScore: number): number {
  return normalizedScore / 20;
}

/** The band a normalized score falls in. Anything under the floor reads as the lowest tier. */
export function bandFor(normalizedScore: number): LikertBand {
  return (
    [...LIKERT_BANDS].reverse().find((band) => normalizedScore >= band.scoreMin) ?? VERY_LOW
  );
}

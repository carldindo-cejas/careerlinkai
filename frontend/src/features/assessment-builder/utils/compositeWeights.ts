import type { CompositeRange } from '@/types/builder';

/**
 * The Scoring panel's arithmetic, kept pure so it can be tested without rendering.
 *
 * The server stores weights as fractions (0.4) and checks them the same way on save and at publish
 * (`compositeConfigErrors`). The panel works in percentages because that is how a counselor reads
 * "Self-Efficacy counts for 40%". These helpers are the only place the two meet.
 */

/** `0.4` → `40`, `1/3` → `33.3`. One decimal, the precision the inputs offer. */
export function toPercent(fraction: number): number {
  return Math.round(fraction * 1000) / 10;
}

/** Percentages → the fractions the server stores. */
export function toFractions(percents: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(percents).map(([code, percent]) => [code, Math.round(percent * 10) / 1000]),
  );
}

export function percentTotal(percents: Record<string, number>): number {
  return Math.round(Object.values(percents).reduce((sum, value) => sum + value, 0) * 10) / 10;
}

/** The same slack the server allows (0.1 percentage points). */
export function isBalanced(percents: Record<string, number>): boolean {
  return Math.abs(percentTotal(percents) - 100) < 0.1;
}

/**
 * Rescale to exactly 100%, keeping the ratio. Rounding leftovers go to the **last** code, so the
 * total is exactly 100 rather than 99.9, which would fail the sum check. With nothing to keep the
 * ratio of, it splits evenly.
 */
export function balancePercents(
  percents: Record<string, number>,
  codes: string[],
): Record<string, number> {
  const total = codes.reduce((sum, code) => sum + Math.max(0, percents[code] ?? 0), 0);
  const result: Record<string, number> = {};
  let assigned = 0;

  codes.forEach((code, index) => {
    if (index === codes.length - 1) {
      result[code] = Math.round((100 - assigned) * 10) / 10;
      return;
    }

    const share = total > 0 ? (Math.max(0, percents[code] ?? 0) / total) * 100 : 100 / codes.length;
    const rounded = Math.round(share * 10) / 10;

    result[code] = rounded;
    assigned += rounded;
  });

  return result;
}

/**
 * What the scorer does with one student's dimension scores: a weighted mean over the dimensions
 * that have a weight, renormalized. Mirrors `compositeIndex` in the backend.
 */
export function sampleComposite(
  scores: Record<string, number>,
  percents: Record<string, number>,
): number | null {
  let weighted = 0;
  let weightSum = 0;

  for (const [code, score] of Object.entries(scores)) {
    const weight = percents[code] ?? 0;

    if (weight > 0) {
      weighted += score * weight;
      weightSum += weight;
    }
  }

  return weightSum === 0 ? null : Math.round((weighted / weightSum) * 10) / 10;
}

/** First match, highest band first — the same rule as the scorer's `interpret()`. */
export function bandFor(ranges: CompositeRange[], score: number): string | null {
  const ordered = [...ranges].sort((a, b) => b.min - a.min);

  return ordered.find((range) => score >= range.min && score <= range.max)?.label ?? null;
}

/** Client-side mirror of the server's band check, so the Save button can explain itself. */
export function bandProblems(ranges: CompositeRange[]): string[] {
  if (ranges.length === 0) {
    return ['Add at least one band.'];
  }

  const problems: string[] = [];

  for (const range of ranges) {
    if (range.label.trim() === '') {
      problems.push(`The ${range.min}–${range.max} band needs a label.`);
    }
    if (range.min >= range.max) {
      problems.push(`The ${range.min}–${range.max} band must start below where it ends.`);
    }
  }

  if (problems.length > 0) {
    return problems;
  }

  const ascending = [...ranges].sort((a, b) => a.min - b.min);

  if (ascending[0]!.min !== 0) {
    problems.push('The lowest band must start at 0.');
  }
  if (ascending[ascending.length - 1]!.max !== 100) {
    problems.push('The highest band must end at 100.');
  }
  for (let i = 1; i < ascending.length; i++) {
    const previous = ascending[i - 1]!;
    const current = ascending[i]!;

    if (current.min > previous.max) {
      problems.push(`Nothing covers ${previous.max}–${current.min}.`);
    } else if (current.min < previous.max) {
      problems.push(`"${previous.label}" and "${current.label}" overlap.`);
    }
  }

  return problems;
}

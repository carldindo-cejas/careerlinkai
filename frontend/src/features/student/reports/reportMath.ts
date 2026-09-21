import { bandFor, itemMean } from '@/features/student/reports/likertBands';
import type { AssessmentReport, ReportItem } from '@/types/assessment';

/**
 * The arithmetic behind the printed reports and the results screen — no JSX, no stylesheet, so the
 * results screen can use it without pulling the print styles (and their `@page` rule) into the app.
 *
 * Everything here is arithmetic the mockups themselves show — raw ÷ max, score ÷ 20, a weighted
 * mean. No score is re-derived from the option table and no code or index is re-ranked.
 */

export interface ReportDimension {
  code: string;
  name: string;
  description: string | null;
  raw: number;
  max: number;
  pct: number;
  mean: number;
  band: string;
  items: ReportItem[];
}

export type AnsweredItem = ReportItem & { answer: NonNullable<ReportItem['answer']> };

/**
 * A dimension's `max` as the engine reads it: the sum over its *answered* items of the item's
 * highest option score times the item's weight on that dimension. A skipped optional item is left
 * out of both raw and max (prorating), which is why the report counts answered items only.
 */
function maxFor(code: string, items: ReportItem[]): number {
  return items.reduce((max, item) => {
    if (item.answer === null) return max;

    const load = item.loads_on.find((entry) => entry.code === code);

    return load === undefined ? max : max + item.max_score * load.weight;
  }, 0);
}

export function buildDimensions(report: AssessmentReport): ReportDimension[] {
  return report.dimensions.map((dimension) => {
    const items = report.items.filter((item) =>
      item.loads_on.some((load) => load.code === dimension.code),
    );
    const pct = Number(dimension.normalized_score);

    return {
      code: dimension.code,
      name: dimension.name,
      description: dimension.description,
      raw: Number(dimension.raw_score),
      max: maxFor(dimension.code, items),
      pct,
      mean: itemMean(pct),
      band: bandFor(pct).label,
      items,
    };
  });
}

export function answeredItems(report: AssessmentReport): AnsweredItem[] {
  return report.items.filter((item): item is AnsweredItem => item.answer !== null);
}

/** The scale's top value — 5 on both instruments — read off the items rather than assumed. */
export function scaleMaxOf(report: AssessmentReport): number {
  return report.items.reduce((max, item) => Math.max(max, item.max_score), 0);
}

export interface CompositeTerm {
  code: string;
  pct: number;
  weight: number;
}

export interface Composite {
  index: number;
  /** The constructs a weight was applied to, in the order given. */
  terms: CompositeTerm[];
  weightSum: number;
}

/**
 * §23's Career Confidence Index, the way `lib/scoring.ts` `compositeIndex` computes it: the
 * weighted mean over constructs that carry a weight on the version, renormalized so an unmeasured
 * construct is not scored as zero, and a plain mean when no weight applies at all. `null` when
 * nothing was measured — an index over no constructs is undefined, not 0.
 */
export function compositeIndex(
  dimensions: { code: string; pct: number }[],
  weights: Record<string, number> | null,
): Composite | null {
  if (dimensions.length === 0) return null;

  const terms = dimensions.flatMap((dimension) => {
    const weight = weights?.[dimension.code];

    return weight === undefined ? [] : [{ code: dimension.code, pct: dimension.pct, weight }];
  });
  const weightSum = terms.reduce((sum, term) => sum + term.weight, 0);

  const index =
    weightSum > 0
      ? terms.reduce((sum, term) => sum + term.pct * term.weight, 0) / weightSum
      : dimensions.reduce((sum, dimension) => sum + dimension.pct, 0) / dimensions.length;

  return { index, terms, weightSum };
}

/** "45" for a whole number, "23.5" otherwise — the mockups print raw and max as counts. */
export function count(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function pct(value: number): string {
  return value.toFixed(1);
}

const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function formatDate(iso: string | null, style: 'short' | 'long'): string {
  if (iso === null) return '—';

  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) return '—';

  if (style === 'short') {
    // Spelled out rather than Intl: newer ICU writes September as "Sept" in en-GB, and the mockups
    // (and every other month) use three letters.
    return `${date.getDate()} ${SHORT_MONTHS[date.getMonth()] ?? ''} ${date.getFullYear()}`;
  }

  const day = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);

  return `${day}, ${time}`;
}

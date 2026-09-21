import { bandFor, itemMean, LIKERT_BANDS } from '@/features/student/reports/likertBands';
import {
  answeredItems,
  buildDimensions,
  compositeIndex,
  count,
  formatDate,
  pct,
  scaleMaxOf,
  type ReportDimension,
} from '@/features/student/reports/reportMath';
import type { AssessmentReport } from '@/types/assessment';
import type { RecommendationSet } from '@/types/recommendation';

/**
 * What the two exports *say* — every sentence and every derived figure — apart from how they are
 * drawn. Two things draw them: the printed sheet (`RiasecReport` / `ScctReport`, HTML and the
 * browser's print engine) and the downloaded PDF (`pdf/reportPdf`, drawn with jsPDF). Both read
 * this module, so a reworded note or a changed figure lands in both or in neither.
 *
 * No JSX and no stylesheet: the PDF builder is a lazy chunk and must not drag the print CSS (and
 * its `@page` rule) along with it.
 */

/** RIASEC is Report 1 of 2 and always prints first, whatever order the reports were named in. */
const REPORT_ORDER = ['RIASEC', 'SCCT'];

function reportRank(report: AssessmentReport): number {
  return REPORT_ORDER.indexOf(report.assessment?.category ?? '');
}

/** The reports that have an export, in the order they print. */
export function inReportOrder(reports: AssessmentReport[]): AssessmentReport[] {
  return reports
    .filter((report) => reportRank(report) !== -1)
    .sort((a, b) => reportRank(a) - reportRank(b));
}

// --- The frame every page shares ------------------------------------------------------------

export const FRAME_COPY = {
  headerTitle: 'CareerLinkAI | Career Guidance Assessment Report',
  exportKicker: 'Assessment Results Export',
  footerMark: 'Confidential',
  footer: (year: number) =>
    `© ${year} CareerLinkAI • Your interests and goals matter. Your future is yours to shape.`,
};

export interface ReportIdentity {
  student: string;
  completedLong: string;
  completedShort: string;
  /** "Grade 12 · Academic", or "—" when neither is on file. */
  gradeAndStrand: string;
  className: string;
  /** "—" when the class has no counselor. */
  counselor: string;
  /** The signature line's caption — blank rather than a dash when there is no counselor. */
  counselorSignature: string;
  /** "60 items · 5-point Likert · v1" */
  instrument: string;
}

export function identityOf(report: AssessmentReport): ReportIdentity {
  const gradeAndStrand = [report.student.grade_level, report.student.strand]
    .filter((value): value is string => value !== null && value !== '')
    .join(' · ');

  return {
    student: report.student.name,
    completedLong: formatDate(report.submitted_at, 'long'),
    completedShort: formatDate(report.submitted_at, 'short'),
    gradeAndStrand: gradeAndStrand || '—',
    className: report.class.name,
    counselor: report.counselor?.name ?? '—',
    counselorSignature: report.counselor?.name ?? '',
    instrument: `${report.instrument.question_count} items · ${scaleMaxOf(report)}-point Likert · v${report.instrument.version_number}`,
  };
}

export const SIGNATURE_LABELS = ['Student signature', 'Guidance counselor', 'Date received'] as const;

// --- The parts both reports carry -----------------------------------------------------------

/**
 * The two instruments' 5-point agreement scale, by score (backend `instruments.ts` LIKERT).
 *
 * The report payload carries the label of the option a student *chose*, item by item, and nothing
 * else — so a point nobody landed on has no label in the data at all. Reading the labels off the
 * answers therefore left every unused point of the scale showing as a bare "1" or "2", which is
 * not a response and reads as missing data. The distribution is an axis of the scale, so it is
 * named by the scale: all five points, every time, whatever the student happened to pick.
 *
 * The midpoint is "Neutral" here. The instrument itself presents it as "Neither Agree nor
 * Disagree" (§8A), which is the same point said at length; the appendix still prints the student's
 * own wording item by item, and the Value column pins which point each row is.
 */
const AGREEMENT_SCALE = ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'];

export interface LikertRow {
  value: number;
  /** The scale's name for this point — see `AGREEMENT_SCALE`. */
  label: string;
  count: number;
  /** "13.3%" */
  share: string;
  /** The bar's length, relative to the most-chosen point (0–1). */
  fill: number;
}

export function likertTally(report: AssessmentReport): { heading: string; rows: LikertRow[] } {
  const answered = answeredItems(report);
  const counted = Array.from({ length: scaleMaxOf(report) }, (_, i) => {
    const value = i + 1;

    return {
      value,
      count: answered.filter((item) => item.answer.score === value).length,
      // A scale longer than the five points above is not one of the two instruments; its extra
      // points have no name to give, so they keep their number.
      label: AGREEMENT_SCALE[i] ?? `${value}`,
    };
  });
  const total = answered.length;
  const peak = Math.max(1, ...counted.map((row) => row.count));

  return {
    heading: `Likert response distribution — ${report.instrument.question_count} items`,
    rows: counted.map((row) => ({
      ...row,
      share: `${(total === 0 ? 0 : (row.count / total) * 100).toFixed(1)}%`,
      fill: row.count / peak,
    })),
  };
}

export const BAND_ROWS = LIKERT_BANDS.map((band) => ({
  mean: `${band.meanMin.toFixed(2)} – ${band.meanMax.toFixed(2)}`,
  score: `${band.scoreMin.toFixed(1)} – ${band.scoreMax.toFixed(1)}`,
  label: band.label,
}));

export const APPENDIX_COPY = {
  title: 'Appendix A — Item responses',
  lead: (questionCount: number) =>
    `All ${questionCount} items in administered order, with the response given and the score it contributed`,
  notAnswered: 'Not answered',
};

/** "45 / 50 · 90.0" — a dimension's line in the appendix. */
export function appendixScore(dimension: ReportDimension): string {
  return `${count(dimension.raw)} / ${count(dimension.max)} · ${pct(dimension.pct)}`;
}

export const CALCULATION_TITLE = 'How these numbers were calculated';

interface Normalization {
  kicker: string;
  formula: string;
  /** The lead dimension, worked through — absent when nothing was measured. */
  example: string | null;
}

function normalization(lead: ReportDimension | undefined): Normalization {
  return {
    kicker: 'Normalization',
    formula: 'score = (raw ÷ max) × 100',
    example: lead
      ? `${lead.name}: (${count(lead.raw)} ÷ ${count(lead.max)}) × 100 = ${pct(lead.pct)}`
      : null,
  };
}

// --- RIASEC ---------------------------------------------------------------------------------

export interface MatchRow {
  rank: number;
  title: string;
  code: string;
  match: string;
  reason: string;
}

function matchRows<T extends { ranking: number; match_score: number; reason: string }>(
  rows: T[],
  pick: (row: T) => { title: string; code: string },
): MatchRow[] {
  return rows
    .slice()
    .sort((a, b) => a.ranking - b.ranking)
    .slice(0, 3)
    .map((row, i) => ({
      rank: i + 1,
      ...pick(row),
      match: row.match_score.toFixed(1),
      reason: row.reason,
    }));
}

export interface RiasecContent {
  label: string;
  kicker: string;
  headline: string;
  title: string;
  subtitle: string;
  /** The server's code, tie-break already applied — nothing here re-ranks. */
  holland: string;
  dims: ReportDimension[];
  /** The code's letters as dimensions, in the code's order. */
  ranked: ReportDimension[];
  heroKicker: string;
  topThree: string;
  heroNote: string;
  breakdownTitle: string;
  breakdownLead: string;
  normalization: Normalization;
  tieBreak: { kicker: string; note: string; example: string | null };
  bandsHeading: string;
  matches: {
    title: string;
    lead: string;
    programs: MatchRow[];
    careers: MatchRow[];
    /** False when the student has no recommendation set yet: the section is left out entirely. */
    any: boolean;
  };
  acknowledgement: string;
}

export function riasecContent(
  report: AssessmentReport,
  recommendations: RecommendationSet | null,
): RiasecContent {
  const dims = buildDimensions(report);
  const holland = report.result?.result_code ?? '';
  const ranked = holland
    .split('')
    .map((code) => dims.find((dimension) => dimension.code === code))
    .filter((dimension): dimension is ReportDimension => dimension !== undefined);

  const programs = matchRows(recommendations?.programs ?? [], (row) => ({
    title: row.program.name,
    code: row.program.code,
  }));
  const careers = matchRows(recommendations?.careers ?? [], (row) => ({
    title: row.career.title,
    code: row.career.typical_riasec_code ?? '—',
  }));

  return {
    label: 'RIASEC Interest Inventory report',
    kicker: 'Report 1 of 2 · RIASEC Interest Inventory',
    headline: `Holland Code ${holland}`,
    title: 'RIASEC Interest Inventory',
    subtitle:
      "Holland's six vocational interest types. Your three strongest types form your Holland Code.",
    holland,
    dims,
    ranked,
    heroKicker: 'Your Holland Code',
    topThree: ranked.map((dimension) => dimension.name).join(' · '),
    heroNote:
      'Your three strongest interest areas, in order. Each score is out of 100 and shows how ' +
      'strongly an interest came through in your answers — not how well you did. There is no ' +
      'pass mark.',
    breakdownTitle: 'Dimension breakdown',
    breakdownLead: 'Raw / max · normalized percentage · interpretation band',
    normalization: normalization(ranked[0]),
    tieBreak: {
      kicker: 'Holland Code — top 3, with tie-break',
      note:
        'Dimensions are sorted by normalized score, descending, and ties are broken on the ' +
        "instrument's canonical order R > I > A > S > E > C — so an identical pair of scores " +
        'always yields the same code.',
      example:
        ranked.length > 0
          ? `${ranked.map((dimension) => `${dimension.code} ${pct(dimension.pct)}`).join(' > ')} → ${holland}`
          : null,
    },
    bandsHeading: 'Interpretation bands',
    matches: {
      title: 'Top matches from this profile',
      lead: 'Generated from the RIASEC profile above and the SCCT career-confidence index (Report 2)',
      programs,
      careers,
      any: programs.length > 0 || careers.length > 0,
    },
    acknowledgement:
      'This report is intended to support self-awareness, career exploration, and informed ' +
      'educational planning. The recommendations are not final career decisions or guarantees ' +
      'of success. Students are encouraged to reflect on their interests, abilities, goals, ' +
      'personal circumstances, and available opportunities, and to discuss their results with ' +
      'a teacher, guidance counselor, or parent.',
  };
}

// --- SCCT -----------------------------------------------------------------------------------

export type WeightedDimension = ReportDimension & { weight: number | null };

export interface ScctContent {
  label: string;
  kicker: string;
  headline: string;
  title: string;
  subtitle: string;
  dims: WeightedDimension[];
  /** The Career Confidence Index, recomputed from the constructs (§23) — never parsed. */
  index: string;
  meanLine: string;
  summary: string;
  heroKicker: string;
  heroNote: string;
  breakdownTitle: string;
  breakdownLead: string;
  normalization: Normalization;
  composite: {
    kicker: string;
    formula: string;
    /** "(84.0 × 0.4) + (86.0 × 0.3) + …" */
    terms: string;
    /** "33.60 + 25.80 + 21.60 = 81.00" */
    products: string;
    /** "÷ (0.4 + 0.3 + 0.3 = 1.00) →" — followed by the index, set in bold. */
    divisor: string;
    fine: string;
  };
  bandsHeading: string;
  acknowledgement: string;
}

/**
 * The index is **recomputed here from the construct scores and the version's weights** — the same
 * arithmetic as the engine's `compositeIndex` (§23: every consumer recomputes it; `overall_summary`
 * is prose and nothing reads a number out of it). A weight for a construct that was never measured
 * is not applied and the rest are renormalized, exactly as the engine does. The summary sentence is
 * the five-tier band, not the engine's four-tier `overall_summary`.
 */
export function scctContent(report: AssessmentReport): ScctContent {
  const weights = report.instrument.composite_weights ?? {};
  const dims = buildDimensions(report).map((dimension) => ({
    ...dimension,
    weight: weights[dimension.code] ?? null,
  }));

  const composite = compositeIndex(dims, report.instrument.composite_weights);
  const terms = composite?.terms ?? [];
  const weightSum = composite?.weightSum ?? 0;
  const index = composite?.index ?? 0;

  return {
    label: 'SCCT Career Confidence Scale report',
    kicker: 'Report 2 of 2 · SCCT Career Confidence Scale',
    headline: `Confidence Index ${pct(index)}`,
    title: 'SCCT Career Confidence Scale',
    subtitle:
      'Social Cognitive Career Theory: self-efficacy, outcome expectations, and goal ' +
      'orientation. The three construct scores combine into one weighted Career Confidence Index.',
    dims,
    index: pct(index),
    meanLine: `item mean ${itemMean(index).toFixed(2)} / 5.00`,
    summary: `${bandFor(index).label} Career Confidence.`,
    heroKicker: 'Career Confidence Index',
    heroNote:
      'The index is the weighted combination of the three construct scores below. Every ' +
      'consumer of this result recomputes it from those scores — the sentence above is written ' +
      'for the reader and no number is ever read back out of it.',
    breakdownTitle: 'Construct breakdown',
    breakdownLead: 'Raw / max · normalized percentage · weight applied to the index',
    normalization: normalization(dims[0]),
    composite: {
      kicker: `Weighted composite — ${terms.map((term) => term.weight.toFixed(1)).join(' / ') || 'mean'}`,
      formula: 'index = ∑(score × weight) ÷ ∑(weight)',
      terms: terms.map((term) => `(${pct(term.pct)} × ${term.weight.toFixed(1)})`).join(' + '),
      products: `${terms.map((term) => (term.pct * term.weight).toFixed(2)).join(' + ')} = ${terms
        .reduce((sum, term) => sum + term.pct * term.weight, 0)
        .toFixed(2)}`,
      divisor: `÷ (${terms.map((term) => term.weight.toFixed(1)).join(' + ')} = ${weightSum.toFixed(2)}) →`,
      fine:
        'Weights live on the assessment version, not in the scorer — one engine, two ' +
        'configurations.',
    },
    bandsHeading: 'Confidence bands — index and constructs',
    acknowledgement:
      'Program and career matches are computed from both results together: the RIASEC interest ' +
      'profile in Report 1 and the Career Confidence Index above. This report is intended to ' +
      'support self-awareness, career exploration, and informed educational planning. The ' +
      'recommendations are not final career decisions or guarantees of success. Students are ' +
      'encouraged to reflect on their interests, abilities, goals, personal circumstances, and ' +
      'available opportunities, and to discuss their results with a teacher, guidance ' +
      'counselor, or parent.',
  };
}

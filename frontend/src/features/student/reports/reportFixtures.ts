import { bandFor } from '@/features/student/reports/likertBands';
import type { AssessmentReport, AssessmentResult } from '@/types/assessment';

/**
 * Test fixtures for the results screen and the print sheet — never imported by app code.
 *
 * The RIASEC answers are the Results Screen mockup's own (raw 199 / 300, code IAS), so the numbers
 * a test asserts are the numbers the approved design printed.
 */

const LIKERT = ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'];

interface DimensionSpec {
  code: string;
  name: string;
  scores: number[];
}

function build(options: {
  attemptId: string;
  category: 'RIASEC' | 'SCCT';
  title: string;
  noun: string;
  resultCode: string | null;
  summary: string | null;
  weights: Record<string, number> | null;
  submittedAt: string;
  dimensions: DimensionSpec[];
}): AssessmentReport {
  let n = 0;

  return {
    attempt_id: options.attemptId,
    submitted_at: options.submittedAt,
    assessment: { title: options.title, category: options.category },
    result: {
      result_code: options.resultCode,
      overall_summary: options.summary,
      generated_at: options.submittedAt,
    },
    dimensions: options.dimensions.map((dimension) => {
      const raw = dimension.scores.reduce((a, b) => a + b, 0);
      const pct = (raw / (dimension.scores.length * 5)) * 100;

      return {
        code: dimension.code,
        name: dimension.name,
        description: null,
        raw_score: raw.toFixed(2),
        normalized_score: pct.toFixed(2),
        interpretation: `${bandFor(pct).label} ${options.noun}`,
      };
    }),
    instrument: {
      version_number: 1,
      question_count: options.dimensions.reduce((sum, d) => sum + d.scores.length, 0),
      composite_weights: options.weights,
    },
    student: {
      name: 'Maria Louise A. Fernandez',
      grade_level: 'Grade 12',
      strand: 'Academic',
      username: 'mfernandez',
    },
    class: { name: 'Grade 12 – Newton (Section B)', academic_year: '2026-2027' },
    counselor: { name: 'Ms. Angeline P. Ravelo, RGC' },
    items: options.dimensions.flatMap((dimension) =>
      dimension.scores.map((score) => ({
        order_number: ++n,
        question_text: `${dimension.name} item ${n}`,
        loads_on: [{ code: dimension.code, weight: 1 }],
        max_score: 5,
        answer: { label: LIKERT[score - 1] ?? null, score },
      })),
    ),
  };
}

export function riasecReport(attemptId = 'attempt-riasec'): AssessmentReport {
  return build({
    attemptId,
    category: 'RIASEC',
    title: 'RIASEC Interest Inventory',
    noun: 'Interest',
    resultCode: 'IAS',
    summary: null,
    weights: null,
    submittedAt: '2026-09-12T10:24:00+08:00',
    dimensions: [
      { code: 'R', name: 'Realistic', scores: [2, 1, 3, 2, 2, 3, 1, 3, 2, 2] },
      { code: 'I', name: 'Investigative', scores: [5, 4, 5, 5, 4, 4, 5, 5, 4, 4] },
      { code: 'A', name: 'Artistic', scores: [4, 5, 4, 5, 3, 4, 4, 5, 4, 3] },
      { code: 'S', name: 'Social', scores: [4, 4, 3, 4, 3, 3, 4, 4, 4, 4] },
      { code: 'E', name: 'Enterprising', scores: [3, 3, 2, 3, 2, 4, 3, 3, 2, 3] },
      { code: 'C', name: 'Conventional', scores: [3, 2, 3, 3, 3, 3, 2, 3, 2, 3] },
    ],
  });
}

/** SE 80, OE 100, GO 60 → index (80 × 0.4) + (100 × 0.3) + (60 × 0.3) = 80.0 → High. */
export function scctReport(attemptId = 'attempt-scct'): AssessmentReport {
  return build({
    attemptId,
    category: 'SCCT',
    title: 'SCCT Career Confidence Scale',
    noun: 'Confidence',
    resultCode: null,
    summary: 'High Career Confidence.',
    weights: { SE: 0.4, OE: 0.3, GO: 0.3 },
    submittedAt: '2026-09-12T10:51:00+08:00',
    dimensions: [
      { code: 'SE', name: 'Self-Efficacy', scores: Array(10).fill(4) },
      { code: 'OE', name: 'Outcome Expectations', scores: Array(10).fill(5) },
      { code: 'GO', name: 'Goal Orientation', scores: Array(10).fill(3) },
    ],
  });
}

/** The list endpoint's shape: the report without what only the report carries. */
export function asResult(report: AssessmentReport): AssessmentResult {
  return {
    attempt_id: report.attempt_id,
    submitted_at: report.submitted_at,
    ...(report.assessment ? { assessment: report.assessment } : {}),
    result: report.result,
    dimensions: report.dimensions,
  };
}

/** A counselor's own instrument, finished — nothing measured, nothing to print. */
export function customResult(n: number): AssessmentResult {
  return {
    attempt_id: `attempt-custom-${n}`,
    submitted_at: `2026-08-${String(10 + n).padStart(2, '0')}T09:00:00+08:00`,
    assessment: { title: `Custom ${n}`, category: 'CUSTOM' },
    result: { result_code: null, overall_summary: null, generated_at: null },
    dimensions: [],
  };
}

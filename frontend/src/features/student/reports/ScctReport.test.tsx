import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ScctReport } from '@/features/student/reports/ScctReport';
import type { AssessmentReport, ReportItem } from '@/types/assessment';

/**
 * The SCCT export against the approved mockup (docs_report/ — SCCT Report). The fixture is the
 * mockup's own worked example, so its printed numbers (42 / 50 · 84.0 · index 81.0 · "High Career
 * Confidence.") are what this component must reproduce from the wire shape.
 */

const LIKERT = ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'];

const ANSWERS = {
  SE: [5, 4, 4, 4, 5, 4, 4, 4, 3, 5],
  OE: [5, 4, 5, 4, 4, 4, 4, 5, 4, 4],
  GO: [3, 4, 3, 4, 4, 3, 4, 3, 4, 4],
} as const;

type Code = keyof typeof ANSWERS;

const META: Record<Code, { name: string; desc: string }> = {
  SE: { name: 'Self-Efficacy', desc: 'Belief in your ability to succeed in a domain.' },
  OE: { name: 'Outcome Expectations', desc: 'Belief that effort in a domain leads to good outcomes.' },
  GO: { name: 'Goal Orientation', desc: 'Your intent to pursue a domain.' },
};

function report(overrides: Partial<AssessmentReport> = {}): AssessmentReport {
  const order: Code[] = ['SE', 'OE', 'GO'];
  let n = 0;

  const items: ReportItem[] = order.flatMap((code) =>
    ANSWERS[code].map((score) => ({
      order_number: ++n,
      question_text: `${META[code].name} item ${n}`,
      loads_on: [{ code, weight: 1 }],
      max_score: 5,
      answer: { label: LIKERT[score - 1] ?? null, score },
    })),
  );

  const dimensions = order.map((code) => {
    const raw = ANSWERS[code].reduce((a, b) => a + b, 0);

    return {
      code,
      name: META[code].name,
      description: META[code].desc,
      raw_score: raw.toFixed(2),
      normalized_score: ((raw / 50) * 100).toFixed(2),
      interpretation: 'High Confidence',
    };
  });

  return {
    attempt_id: 'attempt-2',
    submitted_at: '2026-09-12T10:51:00+08:00',
    assessment: { title: 'SCCT Career Confidence Scale', category: 'SCCT' },
    // The engine's own four-tier sentence — the export writes its own from the five-tier table.
    result: { result_code: null, overall_summary: 'High Career Confidence.', generated_at: null },
    dimensions,
    instrument: {
      version_number: 1,
      question_count: 30,
      composite_weights: { SE: 0.4, OE: 0.3, GO: 0.3 },
    },
    student: { name: 'Maria Louise A. Fernandez', grade_level: 'Grade 12', strand: 'Academic', username: 'mf' },
    class: { name: 'Grade 12 – Newton (Section B)', academic_year: '2026-2027' },
    counselor: { name: 'Ms. Angeline P. Ravelo, RGC' },
    items,
    ...overrides,
  };
}

describe('ScctReport', () => {
  it('recomputes the weighted Career Confidence Index from the construct scores', () => {
    render(<ScctReport report={report()} />);

    // (84.0 × 0.4) + (86.0 × 0.3) + (72.0 × 0.3) = 33.60 + 25.80 + 21.60 = 81.00 ÷ 1.00
    expect(screen.getByText(/Confidence Index 81\.0/)).toBeInTheDocument();
    expect(screen.getByText('81.0', { selector: '.rr-hero-value' })).toBeInTheDocument();
    expect(screen.getByText('item mean 4.05 / 5.00')).toBeInTheDocument();
    expect(screen.getByText('High Career Confidence.')).toBeInTheDocument();
    expect(screen.getByText(/33\.60 \+ 25\.80 \+ 21\.60 = 81\.00/)).toBeInTheDocument();
    expect(screen.getByText('Self-Efficacy: (42 ÷ 50) × 100 = 84.0')).toBeInTheDocument();
  });

  it('prints each construct with its weight, description and five-tier band', () => {
    render(<ScctReport report={report()} />);

    const se = screen.getByText('Self-Efficacy', { selector: 'td' }).closest('tr')!;
    expect(within(se).getAllByRole('cell').map((c) => c.textContent)).toEqual([
      'SE',
      'Self-EfficacyBelief in your ability to succeed in a domain.',
      '42', '50', '84.0', '4.20', '', '0.40', 'Very High',
    ]);

    const go = screen.getByText('Goal Orientation', { selector: 'td' }).closest('tr')!;
    expect(within(go).getByText('0.30')).toBeInTheDocument();
    expect(within(go).getByText('High')).toBeInTheDocument();

    // The engine's stored dimension label is not what the export prints.
    expect(screen.queryByText('High Confidence')).not.toBeInTheDocument();
    expect(screen.getByText('Confidence bands — index and constructs')).toBeInTheDocument();
  });

  /** §23: an unmeasured construct's weight is not applied; the rest are renormalized. */
  it('renormalizes the weights when a construct was not measured', () => {
    const fixture = report();
    fixture.dimensions = fixture.dimensions.filter((d) => d.code !== 'GO');

    render(<ScctReport report={fixture} />);

    // (84.0 × 0.4 + 86.0 × 0.3) ÷ 0.7 = 59.4 ÷ 0.7 = 84.857… → 84.9
    expect(screen.getByText(/Confidence Index 84\.9/)).toBeInTheDocument();
    expect(screen.getByText('Very High Career Confidence.')).toBeInTheDocument();
  });

  it('has no matches section and hides the appendix on request', () => {
    const { rerender } = render(<ScctReport report={report()} />);

    expect(screen.queryByText('Top matches from this profile')).not.toBeInTheDocument();
    expect(screen.getAllByText(/item \d+$/)).toHaveLength(30);

    rerender(<ScctReport report={report()} showAppendix={false} />);

    expect(screen.queryByText('Appendix A — Item responses')).not.toBeInTheDocument();
  });
});

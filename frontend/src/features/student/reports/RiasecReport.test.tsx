import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { bandFor } from '@/features/student/reports/likertBands';
import { RiasecReport } from '@/features/student/reports/RiasecReport';
import type { AssessmentReport, ReportItem } from '@/types/assessment';
import type { Career, College, Program } from '@/types/catalog';
import type { RecommendationSet } from '@/types/recommendation';

/**
 * The printable export against the approved mockup (docs_report/ — RIASEC Report). The fixture is
 * the mockup's own worked example — the same sixty answers — so every number the mockup prints
 * (45 / 50 · 90.0 · 4.50 · IAS) is a value this component must reproduce from the wire shape.
 */

const LIKERT = ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'];

const ANSWERS = {
  R: [2, 1, 3, 2, 2, 3, 1, 3, 2, 2],
  I: [5, 4, 5, 5, 4, 4, 5, 5, 4, 4],
  A: [4, 5, 4, 5, 3, 4, 4, 5, 4, 3],
  S: [4, 4, 3, 4, 3, 3, 4, 4, 4, 4],
  E: [3, 3, 2, 3, 2, 4, 3, 3, 2, 3],
  C: [3, 2, 3, 3, 3, 3, 2, 3, 2, 3],
} as const;

type Code = keyof typeof ANSWERS;

const NAMES: Record<Code, string> = {
  R: 'Realistic',
  I: 'Investigative',
  A: 'Artistic',
  S: 'Social',
  E: 'Enterprising',
  C: 'Conventional',
};

function report(overrides: Partial<AssessmentReport> = {}): AssessmentReport {
  const order: Code[] = ['R', 'I', 'A', 'S', 'E', 'C'];
  let n = 0;

  const items: ReportItem[] = order.flatMap((code) =>
    ANSWERS[code].map((score) => ({
      order_number: ++n,
      question_text: `${NAMES[code]} item ${n}`,
      loads_on: [{ code, weight: 1 }],
      max_score: 5,
      answer: { label: LIKERT[score - 1] ?? null, score },
    })),
  );

  const dimensions = order.map((code) => {
    const raw = ANSWERS[code].reduce((a, b) => a + b, 0);

    return {
      code,
      name: NAMES[code],
      description: null,
      raw_score: raw.toFixed(2),
      normalized_score: ((raw / 50) * 100).toFixed(2),
      // The engine's own three-tier label — the export reads the finer scale instead.
      interpretation: 'High Interest',
    };
  });

  return {
    attempt_id: 'attempt-1',
    submitted_at: '2026-09-12T10:24:00+08:00',
    assessment: { title: 'RIASEC Interest Inventory', category: 'RIASEC' },
    result: { result_code: 'IAS', overall_summary: null, generated_at: '2026-09-12T10:24:01+08:00' },
    dimensions,
    instrument: { version_number: 1, question_count: 60, composite_weights: null },
    student: {
      name: 'Maria Louise A. Fernandez',
      grade_level: 'Grade 12',
      strand: 'Academic',
      username: 'mfernandez',
    },
    class: { name: 'Grade 12 – Newton (Section B)', academic_year: '2026-2027' },
    counselor: { name: 'Ms. Angeline P. Ravelo, RGC' },
    items,
    ...overrides,
  };
}

const COLLEGE: College = {
  id: 'college-1',
  name: 'Holy Name University',
  description: null,
  status: 'active',
  region: null,
  province: null,
  town: null,
  barangay: null,
  map_link: null,
  created_at: null,
  updated_at: null,
};

function program(id: string, name: string, code: string): Program {
  return {
    id,
    college_id: COLLEGE.id,
    code,
    name,
    department_name: null,
    description: null,
    recommended_strand: null,
    status: 'active',
    program_catalog_id: null,
    created_at: null,
    updated_at: null,
  };
}

function career(id: string, title: string, code: string): Career {
  return {
    id,
    title,
    description: null,
    salary_min: null,
    salary_max: null,
    employment_outlook_id: null,
    employment_outlook: null,
    typical_riasec_code: code,
    status: 'active',
    created_at: null,
    updated_at: null,
  };
}

function recommendations(): RecommendationSet {
  return {
    assessment_result_id: 'result-1',
    generated_at: '2026-09-12T10:24:05+08:00',
    programs: [
      { id: 'p2', match_type: 'PROGRAM', match_score: 88.0, ranking: 2, reason: 'Second program.', created_at: '', program: program('prog-2', 'BS Architecture', 'BSARCH'), college: COLLEGE },
      { id: 'p1', match_type: 'PROGRAM', match_score: 91.4, ranking: 1, reason: 'Investigative 90% fits.', created_at: '', program: program('prog-1', 'BS Computer Science', 'BSCS'), college: COLLEGE },
      { id: 'p3', match_type: 'PROGRAM', match_score: 81.9, ranking: 3, reason: 'Third program.', created_at: '', program: program('prog-3', 'BS Psychology', 'BSPSY'), college: COLLEGE },
      { id: 'p4', match_type: 'PROGRAM', match_score: 70.0, ranking: 4, reason: 'Fourth program.', created_at: '', program: program('prog-4', 'BS Nursing', 'BSN'), college: COLLEGE },
    ],
    careers: [
      { id: 'c1', match_type: 'CAREER', match_score: 87.2, ranking: 1, reason: 'Data fits.', created_at: '', career: career('car-1', 'Data Analyst', 'ICR') },
    ],
  };
}

describe('bandFor', () => {
  /** The approved table, at every edge: 35.9 is still Very Low, 36.0 is already Low. */
  it('bands a normalized score on the five-tier item-mean scale', () => {
    const cases: [number, string][] = [
      [20, 'Very Low'],
      [35.9, 'Very Low'],
      [36, 'Low'],
      [51.9, 'Low'],
      [52, 'Moderate'],
      [67.9, 'Moderate'],
      [68, 'High'],
      [83.9, 'High'],
      [84, 'Very High'],
      [100, 'Very High'],
    ];

    for (const [score, label] of cases) {
      expect(bandFor(score).label, `score ${score}`).toBe(label);
    }
  });
});

describe('RiasecReport', () => {
  it('prints the identity block from the report, not from anywhere else', () => {
    render(<RiasecReport report={report()} />);

    // The name and the counselor appear twice: in the header table and on the signature lines.
    expect(screen.getAllByText('Maria Louise A. Fernandez')).toHaveLength(2);
    expect(screen.getAllByText('Ms. Angeline P. Ravelo, RGC')).toHaveLength(2);
    expect(screen.getByText('Grade 12 · Academic')).toBeInTheDocument();
    expect(screen.getByText('Grade 12 – Newton (Section B)')).toBeInTheDocument();
    expect(screen.getByText(/60 items · 5-point Likert · v1/)).toBeInTheDocument();
    expect(screen.getByText(/12 September 2026/)).toBeInTheDocument();
  });

  it('shows the server Holland Code and names its three dimensions in that order', () => {
    render(<RiasecReport report={report()} />);

    expect(screen.getByText('IAS', { selector: 'span[aria-hidden]' })).toBeInTheDocument();
    expect(screen.getByText('Investigative · Artistic · Social')).toBeInTheDocument();
    expect(screen.getByText('I 90.0 > A 82.0 > S 74.0 → IAS')).toBeInTheDocument();
    expect(screen.getByText('Investigative: (45 ÷ 50) × 100 = 90.0')).toBeInTheDocument();
  });

  /**
   * The breakdown row is the mockup's: raw 45, max 50 (ten items × 5 × weight 1), score 90.0,
   * item mean 4.50 — and the band comes from the five-tier table, not the stored three-tier label.
   */
  it('derives max, mean and the five-tier band per dimension', () => {
    render(<RiasecReport report={report()} />);

    const row = screen.getByText('Investigative', { selector: 'td' }).closest('tr')!;
    const cells = within(row).getAllByRole('cell').map((cell) => cell.textContent);

    expect(cells).toEqual(['I', 'Investigative', '45', '50', '90.0', '4.50', '', 'Very High']);

    const realistic = screen.getByText('Realistic', { selector: 'td' }).closest('tr')!;
    expect(within(realistic).getAllByRole('cell').map((c) => c.textContent)).toEqual([
      'R', 'Realistic', '21', '50', '42.0', '2.10', '', 'Low',
    ]);

    const enterprising = screen.getByText('Enterprising', { selector: 'td' }).closest('tr')!;
    expect(within(enterprising).getByText('Moderate')).toBeInTheDocument();

    // The stored three-tier label is not what the export prints.
    expect(screen.queryByText('High Interest')).not.toBeInTheDocument();
  });

  it('prints the interpretation table exactly as approved', () => {
    render(<RiasecReport report={report()} />);

    expect(screen.getByText('1.00 – 1.79').closest('tr')).toHaveTextContent('20.0 – 35.9Very Low');
    expect(screen.getByText('2.60 – 3.39').closest('tr')).toHaveTextContent('52.0 – 67.9Moderate');
    expect(screen.getByText('4.20 – 5.00').closest('tr')).toHaveTextContent('84.0 – 100.0Very High');
  });

  it('tallies the Likert distribution across all sixty answers', () => {
    render(<RiasecReport report={report()} />);

    // Eight fives in the fixture: five Investigative, three Artistic. Scoped to the tally table —
    // the appendix prints "Strongly Agree" on every item that chose it.
    const tally = screen.getByText(/Likert response distribution/).parentElement!;
    const row = within(tally).getByText('Strongly Agree').closest('tr')!;
    expect(within(row).getAllByRole('cell').map((c) => c.textContent)).toEqual([
      'Strongly Agree', '5', '8', '13.3%', '',
    ]);
  });

  it('lists the top three matches of each kind, by ranking', () => {
    render(<RiasecReport report={report()} recommendations={recommendations()} />);

    const programs = screen.getByText('Program recommendations').parentElement!;
    const titles = within(programs)
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell')[1]?.textContent);

    expect(titles).toEqual([
      'BS Computer ScienceInvestigative 90% fits.',
      'BS ArchitectureSecond program.',
      'BS PsychologyThird program.',
    ]);
    expect(screen.queryByText('BS Nursing')).not.toBeInTheDocument();
    expect(screen.getByText('91.4')).toBeInTheDocument();

    expect(screen.getByText('Data Analyst')).toBeInTheDocument();
    expect(screen.getByText('ICR')).toBeInTheDocument();
  });

  it('omits the matches section when there are none, and the appendix on request', () => {
    const { rerender } = render(<RiasecReport report={report()} recommendations={null} />);

    expect(screen.queryByText('Top matches from this profile')).not.toBeInTheDocument();
    expect(screen.getByText('Appendix A — Item responses')).toBeInTheDocument();
    expect(screen.getAllByText(/item \d+$/)).toHaveLength(60);

    rerender(<RiasecReport report={report()} showAppendix={false} />);

    expect(screen.queryByText('Appendix A — Item responses')).not.toBeInTheDocument();
  });

  /** §24: an optional item the student skipped is prorated out of both raw and max. */
  it('leaves a skipped optional item out of max', () => {
    const fixture = report();
    const skipped = fixture.items.find((item) => item.loads_on[0]?.code === 'C')!;
    skipped.answer = null;
    const conventional = fixture.dimensions.find((d) => d.code === 'C')!;
    conventional.raw_score = '24.00';
    conventional.normalized_score = ((24 / 45) * 100).toFixed(2);

    render(<RiasecReport report={fixture} />);

    const row = screen.getByText('Conventional', { selector: 'td' }).closest('tr')!;
    expect(within(row).getAllByRole('cell').map((c) => c.textContent)).toEqual([
      'C', 'Conventional', '24', '45', '53.3', '2.67', '', 'Moderate',
    ]);
    expect(screen.getByText('Not answered')).toBeInTheDocument();
  });
});

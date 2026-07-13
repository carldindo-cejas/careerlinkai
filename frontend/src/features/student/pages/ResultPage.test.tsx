import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { ResultPage } from '@/features/student/pages/ResultPage';
import { studentAssessmentApi } from '@/services/assessmentApi';
import type { AssessmentResult } from '@/types/assessment';

vi.mock('@/services/assessmentApi');

const ATTEMPT_ID = '55555555-5555-4555-8555-555555555555';

function riasecResult(overrides: Partial<AssessmentResult> = {}): AssessmentResult {
  return {
    attempt_id: ATTEMPT_ID,
    submitted_at: '2026-07-13T09:30:00+00:00',
    assessment: { title: 'RIASEC Interest Inventory', category: 'RIASEC' },
    result: {
      result_code: 'IAS',
      overall_summary: null,
      generated_at: '2026-07-13T09:30:01+00:00',
    },
    dimensions: [
      dimension('I', 'Investigative', '84.00', 'High Interest'),
      dimension('A', 'Artistic', '71.00', 'High Interest'),
      dimension('S', 'Social', '62.00', 'Moderate Interest'),
      dimension('R', 'Realistic', '30.00', 'Low Interest'),
    ],
    ...overrides,
  };
}

function dimension(
  code: string,
  name: string,
  normalized: string,
  interpretation: string,
): AssessmentResult['dimensions'][number] {
  return {
    code,
    name,
    description: `What ${name} means.`,
    raw_score: '42.00',
    normalized_score: normalized,
    interpretation,
  };
}

function renderResult() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[`/student/results/${ATTEMPT_ID}`]}>
        <Routes>
          <Route path="/student/results/:attemptId" element={<ResultPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ResultPage', () => {
  beforeEach(() => {
    vi.mocked(studentAssessmentApi.getResult).mockResolvedValue(riasecResult());
  });

  /** §22: the Holland Code is the headline, and the breakdown is what makes it mean anything. */
  it('shows the Holland Code and the dimension breakdown', async () => {
    renderResult();

    expect(await screen.findByText('IAS')).toBeInTheDocument();

    // The top three, named in order — "IAS" alone tells a Grade 12 student nothing.
    expect(screen.getByText(/Investigative · Artistic · Social/)).toBeInTheDocument();

    expect(screen.getByText(/84 · High Interest/)).toBeInTheDocument();
    expect(screen.getByText(/30 · Low Interest/)).toBeInTheDocument();
  });

  /**
   * §24: a dimension the student was never measured on is **absent**, not zero — and the UI must
   * render it as absent. "We did not measure this" and "you scored nothing" are different
   * sentences, and only one of them is true.
   *
   * Here Enterprising and Conventional have no rows at all. The page must not invent a 0% bar for
   * them.
   */
  it('does not invent a zero for a dimension that was never measured', async () => {
    renderResult();

    await screen.findByText('IAS');

    expect(screen.queryByText('Enterprising')).not.toBeInTheDocument();
    expect(screen.queryByText('Conventional')).not.toBeInTheDocument();

    // Exactly the four dimensions that were measured — no invented fifth and sixth rows sitting
    // at zero. (Asserting "no text matching 0" would be wrong: "30 · Low Interest" contains a
    // zero, and an earlier draft of this test failed on precisely that.)
    expect(screen.getAllByText(/· (High|Moderate|Low) Interest/)).toHaveLength(4);
  });

  /**
   * §23: SCCT produces a composite sentence rather than a code, and the sentence is **display
   * only** — the page renders it as given and never parses a number back out of it.
   */
  it('shows the SCCT composite as a sentence rather than a code', async () => {
    vi.mocked(studentAssessmentApi.getResult).mockResolvedValue(
      riasecResult({
        assessment: { title: 'SCCT Career Confidence Scale', category: 'SCCT' },
        result: {
          result_code: null,
          overall_summary: 'Moderately High Career Confidence (Career Confidence Index: 72.3)',
          generated_at: '2026-07-13T09:30:01+00:00',
        },
      }),
    );

    renderResult();

    expect(
      await screen.findByText('Moderately High Career Confidence (Career Confidence Index: 72.3)'),
    ).toBeInTheDocument();

    expect(screen.queryByText('Your Holland Code')).not.toBeInTheDocument();
  });
});

import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { ResultListPage } from '@/features/student/pages/ResultListPage';
import { downloadReportsPdf } from '@/features/student/reports/pdf/reportPdf';
import {
  asResult,
  customResult,
  riasecReport,
  scctReport,
} from '@/features/student/reports/reportFixtures';
import { paths } from '@/routes/paths';
import { studentAssessmentApi } from '@/services/assessmentApi';
import { recommendationApi } from '@/services/recommendationApi';
import type { AssessmentReport } from '@/types/assessment';
import type { Career, College, Program } from '@/types/catalog';
import type { RecommendationSet } from '@/types/recommendation';

vi.mock('@/services/assessmentApi');
vi.mock('@/services/recommendationApi');
// The PDF itself is `reportPdf.test.ts`'s business; here only what the dialog hands it.
vi.mock('@/features/student/reports/pdf/reportPdf', () => ({ downloadReportsPdf: vi.fn() }));

/**
 * "My results", against `docs_report/…/Results Screen`: the two standing instruments as cards
 * and every other result paged underneath.
 */

const RIASEC = riasecReport();
const SCCT = scctReport();
const REPORTS: Record<string, AssessmentReport> = {
  [RIASEC.attempt_id]: RIASEC,
  [SCCT.attempt_id]: SCCT,
};

/** Where a button navigated to — the print sheet is a different route. */
function Probe() {
  const location = useLocation();

  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

function renderPage() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[paths.studentResults]}>
        <Routes>
          <Route path={paths.studentResults} element={<ResultListPage />} />
          <Route path="*" element={<Probe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
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

function program(n: number): Program {
  return {
    id: `program-${n}`,
    college_id: COLLEGE.id,
    code: `BSP${n}`,
    name: `BS Program ${n}`,
    department_name: null,
    description: null,
    recommended_strand: null,
    status: 'active',
    program_catalog_id: null,
    created_at: null,
    updated_at: null,
  };
}

function career(n: number): Career {
  return {
    id: `career-${n}`,
    title: `Career ${n}`,
    description: null,
    salary_min: null,
    salary_max: null,
    employment_outlook_id: null,
    employment_outlook: null,
    typical_riasec_code: 'IAS',
    status: 'active',
    created_at: null,
    updated_at: null,
  };
}

function recommendations(): RecommendationSet {
  return {
    assessment_result_id: 'result-1',
    generated_at: '2026-09-12T11:00:00+08:00',
    programs: [1, 2, 3].map((n) => ({
      id: `rec-program-${n}`,
      match_type: 'PROGRAM' as const,
      match_score: 92 - n,
      ranking: n,
      reason: `Program reason ${n}`,
      created_at: '',
      program: program(n),
      college: COLLEGE,
    })),
    careers: [1, 2, 3].map((n) => ({
      id: `rec-career-${n}`,
      match_type: 'CAREER' as const,
      match_score: 88 - n,
      ranking: n,
      reason: `Career reason ${n}`,
      created_at: '',
      career: career(n),
    })),
  };
}

describe('ResultListPage', () => {
  beforeEach(() => {
    vi.mocked(studentAssessmentApi.listResults)
      .mockReset()
      .mockResolvedValue([
        asResult(RIASEC),
        asResult(SCCT),
        ...[1, 2, 3, 4, 5, 6].map(customResult),
      ]);
    vi.mocked(studentAssessmentApi.getReport)
      .mockReset()
      .mockImplementation(async (attemptId) => {
        const report = REPORTS[attemptId];

        if (report === undefined) throw new Error('Not found');

        return report;
      });
    vi.mocked(recommendationApi.getMine).mockReset().mockResolvedValue(null);
    vi.mocked(downloadReportsPdf).mockReset().mockResolvedValue(undefined);
  });

  it('shows the RIASEC card with its code, top three and bands', async () => {
    renderPage();

    expect(await screen.findByText('Both assessments complete')).toBeInTheDocument();
    expect(screen.getByText('IAS')).toBeInTheDocument();
    expect(screen.getByText('Investigative · Artistic · Social')).toBeInTheDocument();
    expect(screen.getByText('90.0 · Very High Interest')).toBeInTheDocument();

    // The report fills in what the list does not carry — the mockup's own raw 199 / 300.
    expect(await screen.findByText('60 items · completed 12 Sep 2026')).toBeInTheDocument();
    // The cards carry only the scores — the report and breakdown links live elsewhere now.
    expect(screen.queryByText(/tie-break/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /printable/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Scored')).not.toBeInTheDocument();
  });

  /** §23: the index is recomputed from the construct scores and the version's weights. */
  it('shows the SCCT card with the recomputed Career Confidence Index', async () => {
    renderPage();

    expect(await screen.findByText('80.0')).toBeInTheDocument();
    expect(screen.getByText('High Career Confidence.')).toBeInTheDocument();
    expect(screen.getByText('item mean 4.00 / 5.00')).toBeInTheDocument();
    expect(screen.getByText('Weighted index — SE 0.4, OE 0.3, GO 0.3')).toBeInTheDocument();
    expect(screen.queryByText(/^Raw /)).not.toBeInTheDocument();
  });

  it('lists every other result below the two cards, five to a page', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('Custom 1')).toBeInTheDocument();
    expect(screen.getByText('Custom 5')).toBeInTheDocument();
    expect(screen.queryByText('Custom 6')).not.toBeInTheDocument();
    expect(screen.getByText('Page 1 of 2 · 6 results')).toBeInTheDocument();

    // The two standing results are the cards, not rows in this list.
    expect(screen.getAllByText('RIASEC Interest Inventory')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.getByText('Custom 6')).toBeInTheDocument();
    expect(screen.queryByText('Custom 1')).not.toBeInTheDocument();
  });

  it('prints both reports on one sheet', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Print results' }));

    expect(screen.getByTestId('location')).toHaveTextContent(
      '/student/reports?attempts=attempt-riasec%2Cattempt-scct&print=1',
    );
  });

  it('opens the export dialog on the report whose card it was pressed from', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Export RIASEC results' }));

    let dialog = await screen.findByRole('dialog', { name: 'Export results' });

    expect(within(dialog).getByRole('radio', { name: /RIASEC only/ })).toBeChecked();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Export SCCT results' }));

    dialog = await screen.findByRole('dialog', { name: 'Export results' });

    expect(within(dialog).getByRole('radio', { name: /SCCT only/ })).toBeChecked();
  });

  it('prints the chosen report with the chosen sections', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Export SCCT results' }));

    const dialog = await screen.findByRole('dialog', { name: 'Export results' });

    await user.click(within(dialog).getByRole('checkbox', { name: 'Include item appendix' }));

    // Top matches belong to the RIASEC report, so SCCT alone does not offer them.
    expect(
      within(dialog).queryByRole('checkbox', { name: 'Include top matches' }),
    ).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Print' }));

    expect(screen.getByTestId('location')).toHaveTextContent(
      '/student/reports?attempts=attempt-scct&appendix=0&print=1',
    );
    expect(downloadReportsPdf).not.toHaveBeenCalled();
  });

  /** The other way out of the dialog: a file, straight away, and the student stays put. */
  it('downloads the chosen report as a PDF without leaving the page', async () => {
    const user = userEvent.setup();
    renderPage();

    // The file is built from the reports, so the button waits for them.
    await screen.findByText('60 items · completed 12 Sep 2026');
    await screen.findByText('80.0');

    await user.click(screen.getByRole('button', { name: 'Export SCCT results' }));

    const dialog = await screen.findByRole('dialog', { name: 'Export results' });

    await user.click(within(dialog).getByRole('checkbox', { name: 'Include item appendix' }));
    await user.click(within(dialog).getByRole('button', { name: 'Download PDF' }));

    await waitFor(() =>
      expect(downloadReportsPdf).toHaveBeenCalledWith([SCCT], {
        recommendations: null,
        showAppendix: false,
        showRecommendations: true,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByTestId('location')).not.toBeInTheDocument();
  });

  it('keeps the dialog open and says so when the PDF cannot be made', async () => {
    const user = userEvent.setup();
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(downloadReportsPdf).mockRejectedValue(new Error('font fetch failed'));

    renderPage();
    await screen.findByText('80.0');
    await user.click(screen.getByRole('button', { name: 'Export SCCT results' }));

    const dialog = await screen.findByRole('dialog', { name: 'Export results' });

    await user.click(within(dialog).getByRole('button', { name: 'Download PDF' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The PDF could not be created.',
    );
    expect(within(dialog).getByRole('button', { name: 'Download PDF' })).toBeEnabled();

    quiet.mockRestore();
  });

  it('says which instrument is still to do, and offers only what exists', async () => {
    vi.mocked(studentAssessmentApi.listResults).mockResolvedValue([asResult(RIASEC)]);

    renderPage();

    expect(await screen.findByText('1 of 2 assessments complete')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'SCCT Career Confidence Scale' })).toBeInTheDocument();
    expect(screen.getByText(/Not completed yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Print results' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export RIASEC results' })).toBeInTheDocument();
    expect(screen.getByText(/Nothing else yet/)).toBeInTheDocument();
  });

  /** The matches live on "My recommendations" — this page carries the two results only. */
  it('does not show a top matches card, even once recommendations exist', async () => {
    vi.mocked(recommendationApi.getMine).mockResolvedValue(recommendations());

    renderPage();

    expect(await screen.findByText('Both assessments complete')).toBeInTheDocument();
    await waitFor(() => expect(recommendationApi.getMine).toHaveBeenCalled());
    expect(screen.queryByText(/Top matches/)).not.toBeInTheDocument();
    expect(screen.queryByText('BS Program 1')).not.toBeInTheDocument();
  });

  it('keeps the pager on the other results even when they fit on one page', async () => {
    vi.mocked(studentAssessmentApi.listResults).mockResolvedValue([
      asResult(RIASEC),
      asResult(SCCT),
      customResult(1),
      customResult(2),
    ]);

    renderPage();

    expect(await screen.findByText('Page 1 of 1 · 2 results')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });
});

import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { ResultReportPage } from '@/features/student/pages/ResultReportPage';
import { downloadReportsPdf } from '@/features/student/reports/pdf/reportPdf';
import { riasecReport, scctReport } from '@/features/student/reports/reportFixtures';
import { paths, reportsPath } from '@/routes/paths';
import { studentAssessmentApi } from '@/services/assessmentApi';
import { recommendationApi } from '@/services/recommendationApi';

vi.mock('@/services/assessmentApi');
vi.mock('@/services/recommendationApi');
vi.mock('@/features/student/reports/pdf/reportPdf', () => ({ downloadReportsPdf: vi.fn() }));

const RIASEC = riasecReport();
const SCCT = scctReport();

/** The `@page` rule the page writes for the chosen paper. */
function pageRule(): string {
  return document.querySelector('style[data-rr-paper]')?.textContent ?? '';
}

function renderAt(url: string) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path={paths.studentReports} element={<ResultReportPage />} />
          <Route path={paths.studentResultReport} element={<ResultReportPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ResultReportPage', () => {
  beforeEach(() => {
    vi.mocked(studentAssessmentApi.getReport)
      .mockReset()
      .mockImplementation(async (attemptId) => {
        if (attemptId === RIASEC.attempt_id) return RIASEC;
        if (attemptId === SCCT.attempt_id) return SCCT;
        throw new Error('Not found');
      });
    vi.mocked(recommendationApi.getMine).mockReset().mockResolvedValue(null);
    vi.mocked(downloadReportsPdf).mockReset().mockResolvedValue(undefined);
  });

  /** "Print both": one sheet, Report 1 before Report 2 whatever order the link named them in. */
  it('prints both reports on one sheet, RIASEC first, once they have loaded', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});

    renderAt(reportsPath([SCCT.attempt_id, RIASEC.attempt_id], { print: true }));

    await screen.findByText('SCCT Career Confidence Scale', { selector: 'h1' });

    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual([
      'RIASEC Interest Inventory',
      'SCCT Career Confidence Scale',
    ]);
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));

    print.mockRestore();
  });

  /** The paper drives both ways out: the `@page` rule the print dialog opens on, and the file. */
  it('lays the sheet out for the paper chosen in the toolbar', async () => {
    const user = userEvent.setup();

    renderAt(reportsPath([RIASEC.attempt_id]));
    await screen.findByText('RIASEC Interest Inventory', { selector: 'h1' });

    expect(pageRule()).toContain('size: 210mm 297mm');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Paper' }), 'long');

    expect(pageRule()).toContain('size: 8.5in 13in');

    await user.click(screen.getByRole('button', { name: 'Download PDF' }));

    await waitFor(() =>
      expect(downloadReportsPdf).toHaveBeenCalledWith(
        [RIASEC],
        expect.objectContaining({ paper: 'long' }),
      ),
    );
  });

  it('pre-sets the paper from the export link', async () => {
    renderAt(reportsPath([RIASEC.attempt_id], { paper: 'short' }));

    await screen.findByText('RIASEC Interest Inventory', { selector: 'h1' });

    expect(screen.getByRole('combobox', { name: 'Paper' })).toHaveValue('short');
    expect(pageRule()).toContain('size: 8.5in 11in');
  });

  it('pre-sets the section toggles from the export link', async () => {
    renderAt(reportsPath([RIASEC.attempt_id], { appendix: false }));

    await screen.findByText('RIASEC Interest Inventory', { selector: 'h1' });

    expect(screen.getByRole('checkbox', { name: 'Item appendix' })).not.toBeChecked();
    expect(screen.queryByText('Appendix A — Item responses')).not.toBeInTheDocument();
  });

  /** Print and Download sit side by side; the download follows the sheet, toggles and all. */
  it('downloads what is on the sheet as a PDF, in print order', async () => {
    const user = userEvent.setup();

    renderAt(reportsPath([SCCT.attempt_id, RIASEC.attempt_id]));
    await screen.findByText('SCCT Career Confidence Scale', { selector: 'h1' });

    expect(screen.getByRole('button', { name: 'Print' })).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Item appendix' }));
    await user.click(screen.getByRole('button', { name: 'Download PDF' }));

    await waitFor(() =>
      expect(downloadReportsPdf).toHaveBeenCalledWith([RIASEC, SCCT], {
        recommendations: null,
        showRecommendations: true,
        showAppendix: false,
        paper: 'a4',
      }),
    );
  });
});

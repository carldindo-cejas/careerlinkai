import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { MatchingPage } from '@/features/admin/pages/MatchingPage';
import { matchingApi } from '@/services/platformApi';

vi.mock('@/services/platformApi');

/**
 * The admin Matching page (backend 2026-09-22): how many saved recommendation sets predate the last
 * catalog or formula change, recompute them one small page per request, and preview a student.
 */

function renderPage() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MatchingPage />
    </QueryClientProvider>,
  );

  return userEvent.setup();
}

describe('MatchingPage', () => {
  beforeEach(() => {
    vi.mocked(matchingApi.freshness).mockReset();
    vi.mocked(matchingApi.recompute).mockReset();
    vi.mocked(matchingApi.preview).mockReset();
  });

  it('says so when every saved set is current', async () => {
    vi.mocked(matchingApi.freshness).mockResolvedValue({
      inputs_changed_at: '2026-09-22T00:00:00.000Z',
      students_with_sets: 12,
      stale_sets: 0,
    });

    renderPage();

    expect(await screen.findByText(/all 12 students' results are current/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /recompute/i })).not.toBeInTheDocument();
  });

  /**
   * The server does about three students a request (Free-plan subrequest budget), so the page keeps
   * asking until nothing is left.
   */
  it('recomputes page after page until nothing is stale', async () => {
    vi.mocked(matchingApi.freshness).mockResolvedValue({
      inputs_changed_at: '2026-09-22T00:00:00.000Z',
      students_with_sets: 12,
      stale_sets: 5,
    });
    vi.mocked(matchingApi.recompute)
      .mockResolvedValueOnce({ regenerated: 3, failed: 0, remaining: 2 })
      .mockResolvedValueOnce({ regenerated: 2, failed: 0, remaining: 0 });

    const user = renderPage();

    expect(await screen.findByText(/5 of 12 students' recommendations/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /recompute 5/i }));

    await waitFor(() => expect(matchingApi.recompute).toHaveBeenCalledTimes(2));
  });

  /** A set that cannot be regenerated stays stale — the loop must not spin on it forever. */
  it('stops when a page makes no progress', async () => {
    vi.mocked(matchingApi.freshness).mockResolvedValue({
      inputs_changed_at: '2026-09-22T00:00:00.000Z',
      students_with_sets: 3,
      stale_sets: 1,
    });
    vi.mocked(matchingApi.recompute).mockResolvedValue({ regenerated: 0, failed: 1, remaining: 1 });

    const user = renderPage();

    await user.click(await screen.findByRole('button', { name: /recompute 1/i }));

    await waitFor(() => expect(matchingApi.recompute).toHaveBeenCalledTimes(1));
    // Give a runaway loop the chance to show itself.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(matchingApi.recompute).toHaveBeenCalledTimes(1);
  });

  it('previews a student from a preset and shows what they would be recommended', async () => {
    vi.mocked(matchingApi.freshness).mockResolvedValue({
      inputs_changed_at: null,
      students_with_sets: 0,
      stale_sets: 0,
    });
    vi.mocked(matchingApi.preview).mockResolvedValue({
      careers: [
        {
          id: 'c-1',
          title: 'Graphic Designer',
          typical_riasec_code: 'AER',
          match_score: 81.4,
          reason: 'Your Artistic interest…',
          components: {},
        },
      ],
      programs: [
        {
          id: 'p-1',
          name: 'BS Multimedia Arts',
          college_name: 'Holy Name University',
          match_score: 78.2,
          reason: '…',
          components: {},
          careers: ['Graphic Designer', 'Multimedia Artist'],
        },
      ],
    });

    const user = renderPage();

    await user.click(screen.getByRole('button', { name: /^artistic$/i }));
    await user.click(screen.getByRole('button', { name: /preview recommendations/i }));

    await waitFor(() => {
      expect(matchingApi.preview).toHaveBeenCalledWith(
        expect.objectContaining({
          riasec: expect.objectContaining({ A: 92 }),
          academic_average: null,
          strand: null,
        }),
      );
    });

    expect(await screen.findByText(/graphic designer/i, { selector: 'span' })).toBeInTheDocument();
    expect(screen.queryByText(/leads to:/i)).not.toBeInTheDocument();
  });
});

import { QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { TOUR_VERSION } from '@/features/student/tour/tourOrder';
import { StudentLayout } from '@/layouts/StudentLayout';
import { paths } from '@/routes/paths';
import { studentAssessmentApi } from '@/services/assessmentApi';
import { useTourStore } from '@/stores/tourStore';
import type { StudentProfile } from '@/types/assessment';

vi.mock('@/services/assessmentApi');
vi.mock('@/services/recommendationApi');

/**
 * When the welcome tour offers itself, and when it keeps quiet (2026-09-18).
 *
 * The whole feature turns on this being right exactly once. An introduction that opens over an
 * assessment somebody is halfway through is worse than no introduction, and one that reappears
 * after it was dismissed teaches students not to trust a dismiss button.
 */

function renderShell(at: string) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route element={<StudentLayout />}>
            <Route path="/student/*" element={<div>page</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Only the two fields the shell reads; the rest of the profile is not this file's business. */
function profile(complete: boolean): StudentProfile {
  return {
    profiling: {
      is_complete: complete,
      missing: complete ? [] : [{ field: 'subject_grades', label: 'At least one subject grade' }],
      required_fields: ['shs_strand_id', 'grade_level_id', 'subject_grades'],
    },
  } as StudentProfile;
}

beforeEach(() => {
  useTourStore.setState({ steps: [], index: 0, seenVersion: null });
  // The default: a student whose profile is filled in, so the gate is not in the way.
  vi.mocked(studentAssessmentApi.getProfile).mockReset().mockResolvedValue(profile(true));
});

describe('offering the tour unprompted', () => {
  it('starts it for a student who has never seen it, on the dashboard', async () => {
    renderShell(paths.studentDashboard);

    await waitFor(() => {
      expect(useTourStore.getState().steps.length).toBeGreaterThan(0);
    });
  });

  it('keeps quiet for a student who has already finished or skipped it', async () => {
    useTourStore.setState({ seenVersion: TOUR_VERSION });

    renderShell(paths.studentDashboard);

    await waitFor(() => {
      expect(useTourStore.getState().steps).toEqual([]);
    });
  });

  /**
   * The shell also hosts the assessment player, and the tour's first stop navigates to the
   * dashboard — so an unprompted start here would walk a student out of their own attempt.
   */
  it('does not interrupt an assessment in progress', async () => {
    renderShell('/student/attempts/aa000000-0000-4000-8000-000000000001');

    await waitFor(() => {
      expect(useTourStore.getState().steps).toEqual([]);
    });

    // And the offer is not spent — nothing was recorded as seen, so it is made next time.
    expect(useTourStore.getState().seenVersion).toBeNull();
  });

  /**
   * Caught by `npm run audit:responsive` at 320px: a brand-new student is both the only person
   * the tour introduces itself to and the only person `ProfileGate` stops, so the two opened on
   * top of each other on the very first screen — a tour of a dashboard behind a locked door.
   */
  it('waits for the profile gate rather than opening behind it', async () => {
    vi.mocked(studentAssessmentApi.getProfile).mockResolvedValue(profile(false));

    renderShell(paths.studentDashboard);

    await waitFor(() => expect(studentAssessmentApi.getProfile).toHaveBeenCalled());
    expect(useTourStore.getState().steps).toEqual([]);

    // And the offer is not spent — it is made once the gate is out of the way.
    expect(useTourStore.getState().seenVersion).toBeNull();
  });

  /** No gate renders on a failed profile load (D11), so nothing is in the way of the tour. */
  it('still offers itself when the profile could not be loaded at all', async () => {
    vi.mocked(studentAssessmentApi.getProfile).mockRejectedValue(new Error('offline'));

    renderShell(paths.studentDashboard);

    await waitFor(() => {
      expect(useTourStore.getState().steps.length).toBeGreaterThan(0);
    });
  });

  it('does not interrupt a student who deep-linked into their results', async () => {
    renderShell(paths.studentResults);

    await waitFor(() => {
      expect(useTourStore.getState().steps).toEqual([]);
    });
  });
});

import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { useTourDemoStore } from '@/features/student/tour/demoMode';
import { StudentTour } from '@/features/student/tour/StudentTour';
import { TOUR, TOUR_STOPS, TOUR_VERSION } from '@/features/student/tour/stops';
import { paths } from '@/routes/paths';
import { platformApi } from '@/services/platformApi';
import { ApiRequestError } from '@/types/api';
import type { StudentDashboard } from '@/types/platform';
import { useTourStore } from '@/stores/tourStore';

vi.mock('@/services/platformApi');

/**
 * The tour overlay. jsdom gives every element a zero-sized rect, so what can honestly be tested
 * here is the *behaviour* — what it says, where it navigates, how it is left — and not the
 * geometry. The geometry is `placement.test.ts`, which is pure arithmetic for exactly this reason.
 *
 * The dashboard endpoint is mocked because the overlay reads one fact from it: whether this
 * student has finished, which is what decides between their own screens and the example
 * student's. `recommendations_ready` is that fact.
 */

function dashboard(ready: boolean): StudentDashboard {
  return {
    assignments: { active: 2, completed: ready ? 2 : 0, pending: ready ? 0 : 2 },
    results_count: ready ? 2 : 0,
    recommendations_ready: ready,
    unread_notifications: 0,
    profile_complete: true,
  };
}

/** Prints the current path, so a navigation the tour performs is visible to an assertion. */
function Where() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

function renderTour(at: string = paths.studentDashboard) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[at]}>
        <Where />
        <Routes>
          {/* Every student route resolves to the same placeholder — the tour's own navigation is
              what is under test, not what it lands on. */}
          <Route path="/student/*" element={<div />} />
        </Routes>
        <StudentTour />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useTourStore.setState({ steps: [], index: 0, seenVersion: null });
  useTourDemoStore.setState({ demo: null });
  vi.mocked(platformApi.studentDashboard).mockResolvedValue(dashboard(false));
});

describe('the welcome tour', () => {
  it('renders nothing at all when no tour is running', () => {
    const { container } = renderTour();

    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('opens on the first stop', () => {
    useTourStore.getState().startTour();
    renderTour();

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(TOUR_STOPS.welcome.title)).toBeInTheDocument();
  });

  it('walks forward and back through the stops', async () => {
    const user = userEvent.setup();

    useTourStore.getState().startTour();
    renderTour();

    await user.click(screen.getByRole('button', { name: /show me/i }));
    expect(screen.getByText(TOUR_STOPS.nav.title)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^back$/i }));
    expect(screen.getByText(TOUR_STOPS.welcome.title)).toBeInTheDocument();
  });

  /** The stops span four routes; a tour that described them from one screen would be a modal. */
  it('navigates to the route a stop lives on', async () => {
    const user = userEvent.setup();

    useTourStore.setState({ steps: ['welcome', 'assessments'], index: 0 });
    renderTour();

    expect(screen.getByTestId('path')).toHaveTextContent(paths.studentDashboard);

    await user.click(screen.getByRole('button', { name: /show me/i }));

    await waitFor(() => {
      expect(screen.getByTestId('path')).toHaveTextContent(paths.studentAssessments);
    });
  });

  it('says where you are in it', () => {
    useTourStore.setState({ steps: TOUR, index: 2 });
    renderTour();

    expect(screen.getByText(`Step 3 of ${TOUR.length}`)).toBeInTheDocument();
  });

  /**
   * An anchor that is not on the page is the ordinary state of a new student's account — no
   * results, no recommendations. The stop is still shown, and still says something true.
   */
  it('keeps a stop whose element is missing, and explains the gap', async () => {
    useTourStore.setState({ steps: ['results'], index: 0 });
    renderTour(paths.studentResults);

    expect(screen.getByText(TOUR_STOPS.results.title)).toBeInTheDocument();
    await waitFor(
      () => {
        expect(screen.getByText(TOUR_STOPS.results.absentNote!)).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
  });
});

describe('leaving the tour', () => {
  it('skips from any step', async () => {
    const user = userEvent.setup();

    useTourStore.setState({ steps: TOUR, index: 3 });
    renderTour();

    await user.click(screen.getByRole('button', { name: /^skip$/i }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useTourStore.getState().steps).toEqual([]);
  });

  it('offers Skip on every step, including the first and the last', () => {
    for (const index of [0, TOUR.length - 1]) {
      useTourStore.setState({ steps: TOUR, index });

      const { unmount } = renderTour();

      expect(screen.getByRole('button', { name: /^skip$/i })).toBeInTheDocument();
      unmount();
    }
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();

    useTourStore.getState().startTour();
    renderTour();

    await user.keyboard('{Escape}');

    expect(useTourStore.getState().steps).toEqual([]);
  });

  /**
   * Skipping counts as seen. Re-offering a tour somebody has already dismissed is the behaviour
   * that teaches people not to trust a dismiss button.
   */
  it('records the version when it is skipped', async () => {
    const user = userEvent.setup();

    useTourStore.setState({ steps: TOUR, index: 1 });
    renderTour();

    await user.click(screen.getByRole('button', { name: /^skip$/i }));

    expect(useTourStore.getState().seenVersion).toBe(TOUR_VERSION);
  });

  it('records the version when it is finished', async () => {
    const user = userEvent.setup();

    useTourStore.setState({ steps: TOUR, index: TOUR.length - 1 });
    renderTour();

    await user.click(screen.getByRole('button', { name: /finish/i }));

    expect(useTourStore.getState().seenVersion).toBe(TOUR_VERSION);
    expect(useTourStore.getState().steps).toEqual([]);
  });
});

describe('the assistant pointing at one thing', () => {
  it('shows a single card with no counter and no Next', () => {
    useTourStore.getState().pointAt('report-download');
    renderTour(paths.studentResults);

    expect(screen.getByText(TOUR_STOPS['report-download'].title)).toBeInTheDocument();
    expect(screen.queryByText(/step \d+ of/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /next/i })).toBeNull();
    expect(screen.getByRole('button', { name: /got it/i })).toBeInTheDocument();
  });

  it('travels to the screen the thing is on', async () => {
    useTourStore.getState().pointAt('recommendations');
    renderTour(paths.studentDashboard);

    await waitFor(() => {
      expect(screen.getByTestId('path')).toHaveTextContent(paths.studentRecommendations);
    });
  });

  it('closes on Got it', async () => {
    const user = userEvent.setup();

    useTourStore.getState().pointAt('profile-strand');
    renderTour(paths.studentProfile);

    await user.click(screen.getByRole('button', { name: /got it/i }));

    expect(useTourStore.getState().steps).toEqual([]);
  });
});

/**
 * The example student (2026-09-21).
 *
 * The tour is shown on a student's first visit — the one visit on which half of what it points at
 * does not exist. These are the three things that have to hold for standing somebody else's
 * answers in to be an improvement rather than a deception: it happens only for a student with
 * nothing of their own, it is announced while it is on, and it is gone the moment the tour is.
 */
describe('the example student', () => {
  const BANNER = /this is an example student/i;

  it('fills the empty screens for a student who has answered nothing', async () => {
    useTourStore.getState().startTour();
    renderTour();

    await waitFor(() => {
      expect(screen.getByText(BANNER)).toBeInTheDocument();
    });

    const demo = useTourDemoStore.getState().demo;

    expect(demo?.results).toHaveLength(2);
    expect(demo?.recommendations.careers.length).toBeGreaterThan(0);
    expect(demo?.dashboard.recommendations_ready).toBe(true);
  });

  /** A student with their own Holland code must never be shown somebody else's. */
  it('leaves a finished student their own screens', async () => {
    vi.mocked(platformApi.studentDashboard).mockResolvedValue(dashboard(true));

    useTourStore.getState().startTour();
    renderTour();

    await waitFor(() => {
      expect(screen.getByText(TOUR_STOPS.welcome.title)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(platformApi.studentDashboard).toHaveBeenCalled();
    });

    expect(useTourDemoStore.getState().demo).toBeNull();
    expect(screen.queryByText(BANNER)).toBeNull();
  });

  /** A tour whose sample data outlived it would be a student reading a stranger's results. */
  it('puts the example student away when the tour is left', async () => {
    const user = userEvent.setup();

    useTourStore.setState({ steps: TOUR, index: 2 });
    renderTour();

    await waitFor(() => {
      expect(useTourDemoStore.getState().demo).not.toBeNull();
    });

    await user.click(screen.getByRole('button', { name: /^skip$/i }));

    expect(useTourDemoStore.getState().demo).toBeNull();
  });

  /**
   * A query that never answers is not a reason to run half a tour. The banner names whose answers
   * these are either way, so falling through to the example is the safer of the two failures.
   */
  it('falls through to the example when the dashboard cannot be read', async () => {
    // A 4xx, so the client does not retry it — the point under test is what the overlay does
    // once the query has failed, not how long TanStack spends deciding that it has.
    vi.mocked(platformApi.studentDashboard).mockRejectedValue(
      new ApiRequestError('Not found', 404),
    );

    useTourStore.getState().startTour();
    renderTour();

    await waitFor(() => {
      expect(screen.getByText(BANNER)).toBeInTheDocument();
    });
  });
});

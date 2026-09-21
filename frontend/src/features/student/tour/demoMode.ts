import { create } from 'zustand';

import type { AssessmentAssignment, AssessmentReport, AssessmentResult } from '@/types/assessment';
import type { StudentDashboard } from '@/types/platform';
import type { RecommendationSet } from '@/types/recommendation';

/**
 * The tour's example student — the switch, not the data.
 *
 * ## Why the tour needs one at all
 *
 * The tour runs on a student's *first* visit, which is precisely the visit on which they have
 * answered nothing. Half the stops then point at things that do not exist: there are no result
 * cards to ring, the **Print results** button is not rendered at all (it needs both instruments),
 * and the recommendations screen is a card explaining that there are none. The overlay handled
 * that honestly — it said "finish an assessment and your scores will show up here" — but honest
 * is not the same as *useful*. A student who has never seen a Holland code cannot picture one
 * from a sentence, and the one stop they most need, "this is how you print your results for your
 * parents", was the one stop that could never be highlighted.
 *
 * So while the tour is running, a student who has not finished sees the real screens filled with
 * a finished student's answers. Every anchor then exists, every stop can be pointed at, and what
 * they are being shown is the actual UI rather than a description of it.
 *
 * ## What keeps this from being a lie
 *
 * Four things, and all four are load-bearing:
 *
 *   1. **It is announced.** The overlay carries a banner saying these are an example student's
 *      answers for as long as the substitution is on. See `StudentTour.tsx`.
 *   2. **It only ever replaces an emptiness.** The decision is made once, from
 *      `recommendations_ready` — a student who has finished sees their own numbers and never
 *      meets this at all.
 *   3. **Nothing under the overlay is operable.** The dim layer swallows every click, so no
 *      demo id can reach the server and no demo value can be saved.
 *   4. **It dies with the overlay.** The state lives in this store, nothing persists it, and
 *      `StudentTour`'s unmount clears it — so the screen behind a closed tour is the student's own
 *      within a frame.
 *
 * The student's **profile** is deliberately not part of it. Every profile anchor exists whether or
 * not the form is filled in, so there is nothing to gain — and the form is the one student screen
 * that writes back, where a sample value left in an input is a sample value one Save away from
 * being the student's real strand.
 */
export interface TourDemo {
  assignments: AssessmentAssignment[];
  results: AssessmentResult[];
  /** The two standing instruments' reports, by attempt id — the SCCT card's index comes from one. */
  reports: AssessmentReport[];
  recommendations: RecommendationSet;
  dashboard: StudentDashboard;
}

interface TourDemoState {
  /** The example student's data while it is being shown, and null every other moment. */
  demo: TourDemo | null;
  show: (demo: TourDemo) => void;
  hide: () => void;
}

/**
 * A store of its own rather than a field on `tourStore`, because of what each one costs.
 *
 * `tourStore` is in the student route's **static** bundle — the shell reads it on the first paint
 * to decide whether to offer the tour. This is read only by the student hooks, and the data it
 * holds is put there by the lazy overlay chunk, so nothing about the example student is
 * downloaded by a student who never opens the tour. Keep it that way: this file should stay
 * switch-sized, and `demoStudent.ts` should stay reachable only from `StudentTour.tsx`.
 */
export const useTourDemoStore = create<TourDemoState>((set) => ({
  demo: null,
  show: (demo) => set({ demo }),
  hide: () => set({ demo: null }),
}));

/** The example student's data, or null when the tour is not standing in for an empty screen. */
export function useTourDemo(): TourDemo | null {
  return useTourDemoStore((state) => state.demo);
}

/** The same, read outside React — for a query function, which is not a component. */
export function demoReportFor(attemptId: string): AssessmentReport | undefined {
  return useTourDemoStore
    .getState()
    .demo?.reports.find((report) => report.attempt_id === attemptId);
}

/** What a query result has to carry for `demoInstead` to be able to stand in for it. */
interface QueryLike {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
}

/**
 * The example student's answer in place of the query's, or the query untouched.
 *
 * Every field that says *how* the data arrived is overwritten too, not just `data`: a page that
 * reads `isLoading` would otherwise render its spinner over a set of results it has already been
 * handed, and one that reads `isError` would render "we could not load this" over them — which is
 * the exact confusion between "empty" and "broken" that deviation D11 is about.
 *
 * The cast is the price of standing in for TanStack's discriminated result union, whose branches
 * cannot be constructed from a spread. It is contained to this one function.
 */
export function demoInstead<Q extends QueryLike>(
  query: Q,
  demo: NonNullable<Q['data']> | null | undefined,
): Q {
  if (demo === null || demo === undefined) return query;

  return {
    ...query,
    data: demo,
    status: 'success',
    isLoading: false,
    isPending: false,
    isFetching: false,
    isError: false,
    isSuccess: true,
    error: null,
  } as unknown as Q;
}

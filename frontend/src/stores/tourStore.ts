import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// `tourOrder`, not `stops` — the latter carries the tour's copy, which must not be in the
// student route's static bundle. See that file's header.
import { TOUR, TOUR_VERSION, type TourStopId } from '@/features/student/tour/tourOrder';

/**
 * What the tour overlay is currently showing, if anything.
 *
 * ## Why this is a store and not state inside the overlay
 *
 * Three unrelated places start it and none of them can reach the others: the shell (a student's
 * first visit), the dashboard's *"Take the tour"* button, and the assistant's *"Yes, show me"* —
 * which is inside a drawer, on a different route, in a lazily-loaded chunk. A store is the only
 * thing all three already share.
 *
 * ## Why it is deliberately this small
 *
 * This file is in the student route's **static** bundle — the shell imports it to decide whether a
 * first-time student should be offered the tour, and that decision has to be made before anything
 * is fetched. The overlay itself (measuring, positioning, the card, the spotlight) is behind a
 * `lazy()` that only resolves once `steps` is non-empty, so a returning student never downloads
 * it — and so is the tour's copy, which is why the import below is `tourOrder` and not `stops`.
 *
 * Keep that split. Anything heavy added here is added to every student's first paint, and the
 * margin is thin: the route budget is 565 KiB and the student screen sits at 561.
 *
 * ## Two modes, one shape
 *
 * A guided tour is a list of stops; the assistant pointing at one thing is a list of length one.
 * Modelling them as the same list means the overlay has one code path and the difference is
 * entirely in the footer — Next/Back versus a single "Got it".
 */
interface TourState {
  /** The stops being shown, in order. Empty means nothing is running. */
  steps: TourStopId[];
  /** Which one, as an index into `steps`. */
  index: number;
  /**
   * The version of the tour this student has finished or skipped, persisted.
   *
   * Null means never. It records the *version* rather than a boolean so the tour can be re-offered
   * once after it changes materially, without re-offering it every time the copy is tweaked — that
   * is a judgement call, and `TOUR_VERSION` is where it is made.
   */
  seenVersion: number | null;
  /** Start the full welcome tour from the beginning. */
  startTour: () => void;
  /**
   * Show exactly one stop — the assistant's *"Yes, show me"*.
   *
   * Deliberately **not** "jump into the tour at that stop": a student who asked where the download
   * button is wants the download button, not the remaining six screens of an introduction they did
   * not ask for.
   */
  pointAt: (id: TourStopId) => void;
  next: () => void;
  back: () => void;
  /**
   * Stop, and record that this version was seen.
   *
   * Skipping and finishing both land here, and both count as seen. A student who skipped has made
   * their position clear, and re-offering a tour somebody has already dismissed is the behaviour
   * that makes people distrust the dismiss button.
   */
  close: () => void;
}

export const TOUR_STORAGE_KEY = 'careerlinkai.student-tour';

export const useTourStore = create<TourState>()(
  persist(
    (set, get) => ({
      steps: [],
      index: 0,
      seenVersion: null,

      startTour: () => set({ steps: TOUR, index: 0 }),
      pointAt: (id) => set({ steps: [id], index: 0 }),

      next: () => {
        const { steps, index } = get();

        // Past the last stop is the end of the tour, not an index error.
        if (index >= steps.length - 1) {
          set({ steps: [], index: 0, seenVersion: TOUR_VERSION });

          return;
        }

        set({ index: index + 1 });
      },

      back: () => set({ index: Math.max(0, get().index - 1) }),

      close: () => set({ steps: [], index: 0, seenVersion: TOUR_VERSION }),
    }),
    {
      name: TOUR_STORAGE_KEY,
      /**
       * Only what must outlive the tab. Persisting `steps` would reopen a half-finished tour on
       * top of whatever screen the student came back to — and, worse, would restore a *pointer*
       * aimed at an element on a route they are no longer on.
       */
      partialize: (state) => ({ seenVersion: state.seenVersion }),
    },
  ),
);

/** Whether this student has a tour running right now. */
export function useTourRunning(): boolean {
  return useTourStore((state) => state.steps.length > 0);
}

/**
 * Whether the welcome tour should be offered to this student unprompted.
 *
 * Read once, on the shell's first render, and never again while the tab is open: a tour that
 * decides to start halfway through an assessment because a query settled would be worse than no
 * tour at all.
 */
export function shouldOfferTour(): boolean {
  return useTourStore.getState().seenVersion !== TOUR_VERSION;
}

import { ArrowLeft, ArrowRight, Check, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { useStudentDashboard } from '@/features/student/hooks/useDashboard';
import { useTourDemo, useTourDemoStore } from '@/features/student/tour/demoMode';
import { demoStudent } from '@/features/student/tour/demoStudent';
import { anchorSelector, TOUR_STOPS } from '@/features/student/tour/stops';
import { needsScroll, placeCard, spotlightBox, type Box } from '@/features/student/tour/placement';
import { useTourStore } from '@/stores/tourStore';

import '@/features/student/tour/tour.css';

/**
 * The guided tour overlay — the thing that dims the screen and points at something.
 *
 * ## What it is for
 *
 * A student's first minute in here is spent working out that "RIASEC" is an assessment, that
 * results are not marks, and that the recommendations they were told about do not exist until they
 * have finished two things. None of that is discoverable from a dashboard of empty cards. The tour
 * says it once, over the real screen, pointing at the real controls — which is why it navigates
 * between routes rather than describing them from a modal.
 *
 * ## Skipping is a first-class control, not an escape hatch
 *
 * **Skip** is present on every step, in the footer, at the same size as Next — never a grey link in
 * a corner. A tour that is hard to leave is a tour that gets resented, and the student most likely
 * to want out is the one who has seen it before. Escape does the same thing, and so does the X.
 *
 * ## Two shapes
 *
 * With several steps it is the welcome tour: Back, Next, a counter and Skip. With exactly one it is
 * the assistant having been asked *"where is it?"* — one card, one **Got it**, no counter. Same
 * component, because the difference really is only the footer.
 *
 * ## What it points at when there is nothing to point at
 *
 * A first visit is, by definition, a visit with no answers on it — so the stops that matter most
 * had nothing to ring: no result cards, no **Print results** button (it needs both instruments
 * finished before it renders at all), and a recommendations screen that is one card explaining
 * why it is empty. Saying so in the card was honest and useless: a student cannot picture a
 * Holland code from a sentence.
 *
 * So a student who has not finished is shown the real screens filled with an example student's
 * answers, for as long as the tour is up and not a moment longer, under a banner that says so.
 * `demoMode.ts` holds the reasoning and the four things that keep it from being a lie;
 * `demoStudent.ts` holds the answers.
 *
 * ## Loaded lazily, and deliberately
 *
 * Nothing in this file is in the student route's static bundle. `StudentLayout` mounts it behind a
 * `lazy()` that resolves only when a tour is actually running, so a returning student never
 * downloads it. See the note in `stores/tourStore.ts` about the 560 KiB route budget.
 */

/**
 * How long to look before *saying* the element is not here.
 *
 * Short, because this is the delay a student spends reading a centred card wondering what it is
 * pointing at. Long enough to cover a lazy route chunk and a warm query, which is the ordinary
 * case; the uncommon slow one is covered by continuing to look afterwards.
 */
const ANCHOR_TIMEOUT_MS = 1200;
/**
 * How long to keep looking after that.
 *
 * The hunt does **not** stop when the note appears. A student on a slow connection whose result
 * cards arrive at four seconds should get them highlighted and the note withdrawn, rather than
 * being told for the rest of the stop that they have no results — which would be false, and is
 * exactly what a single give-up timer would have said.
 */
const ANCHOR_GIVE_UP_MS = 12_000;
/** How often to look. Cheap — one `querySelector` against a list of two. */
const ANCHOR_POLL_MS = 100;

/**
 * How the spotlight and its card travel between stops (prompt-driven, 2026-09-20).
 *
 * **Slow, and on a decelerating curve.** It was 200ms of `ease-out`, which is the right duration
 * for a menu opening and the wrong one for a pointer: at that speed the ring is simply *somewhere
 * else* on the next frame a student looks, and they have to re-find it. 520ms on a curve that
 * starts fast and settles gently means the eye can follow the movement, and following it is how a
 * student learns that the two screens are connected — which is most of what the tour is for.
 *
 * It is also what makes the ring *track* smoothly: the overlay re-measures the anchor on every
 * animation frame while the page scrolls, so a transition on those same properties turns a
 * sequence of jumps into a single continuous follow.
 *
 * `motion-reduce:transition-none` is the floor. Somebody who asked the OS for less movement gets
 * the ring placed instantly, which is not worse for them — it is the thing they asked for.
 */
const GLIDE =
  'duration-[520ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none';

const CARD_WIDTH = 340;
/** Only used for the very first frame, before the real card has been measured. */
const CARD_HEIGHT_ESTIMATE = 210;

export function StudentTour() {
  const steps = useTourStore((state) => state.steps);
  const index = useTourStore((state) => state.index);
  const next = useTourStore((state) => state.next);
  const back = useTourStore((state) => state.back);
  const close = useTourStore((state) => state.close);

  const navigate = useNavigate();
  const { pathname } = useLocation();

  useExampleStudent(steps.length > 0);

  const demo = useTourDemo();

  const stopId = steps[index];
  const stop = stopId === undefined ? null : TOUR_STOPS[stopId];

  const [anchor, setAnchor] = useState<Box | null>(null);
  /**
   * Whether the hunt for the anchor has finished.
   *
   * It exists to stop the card flashing centred and then jumping into place: while this is false
   * the overlay renders the dim layer and nothing else, which for a route that is already loaded
   * is a single frame.
   */
  const [settled, setSettled] = useState(false);
  const [cardHeight, setCardHeight] = useState(CARD_HEIGHT_ESTIMATE);

  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);

  const isSinglePoint = steps.length === 1;
  const isLast = index === steps.length - 1;

  /*
    Get to the right screen first. `replace` rather than a push: the tour walks four routes, and
    pushing each one would leave a student who presses Back afterwards wading back through the tour
    instead of returning to where they came from.
  */
  useEffect(() => {
    if (stop === null) return;
    if (pathname === stop.path) return;

    navigate(stop.path, { replace: true });
  }, [stop, pathname, navigate]);

  /**
   * Find what this stop points at.
   *
   * Polling rather than a `MutationObserver` because the thing being waited for is not one
   * mutation — it is a route chunk downloading, a query resolving and a list rendering, in that
   * order, and the observer would fire dozens of times through all three. A hundred-millisecond
   * `querySelector` against a handful of selectors is the cheaper and simpler instrument.
   *
   * Visibility, not just existence: the sidebar navigation is in the DOM twice at some widths (the
   * rail and the drawer's copy of it), and pointing at the hidden one would draw a spotlight
   * around an empty rectangle at the top left of the screen.
   */
  useEffect(() => {
    if (stop === null) return;

    setAnchor(null);
    setSettled(stop.anchors.length === 0);

    if (stop.anchors.length === 0) return;

    let cancelled = false;
    const startedAt = Date.now();

    const look = () => {
      if (cancelled) return;

      const found = findVisible(stop.anchors);

      if (found !== null) {
        if (needsScroll(toBox(found.getBoundingClientRect()), viewport())) {
          found.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }

        // Measured after the scroll is requested, and re-measured by the tracking effect below —
        // a smooth scroll is still moving when this runs.
        setAnchor(toBox(found.getBoundingClientRect()));
        setSettled(true);

        return;
      }

      const waited = Date.now() - startedAt;

      if (waited > ANCHOR_TIMEOUT_MS) {
        // Say so — often this is simply the honest state of the page: no results yet, no
        // recommendations yet. `setSettled` is idempotent, so this runs harmlessly on every
        // subsequent poll rather than needing a flag of its own.
        setSettled(true);
      }

      if (waited > ANCHOR_GIVE_UP_MS) return;

      window.setTimeout(look, ANCHOR_POLL_MS);
    };

    look();

    return () => {
      cancelled = true;
    };
  }, [stop, pathname]);

  /**
   * Keep the spotlight on the anchor while the page moves under it — a scroll, a rotation, a
   * banner arriving, the smooth scroll requested above still settling. Without this the highlight
   * detaches from its element and points at empty background, which looks exactly like a bug
   * because it is one.
   */
  useEffect(() => {
    if (stop === null || anchor === null) return;

    let frame = 0;

    const track = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const found = findVisible(stop.anchors);

        setAnchor(found === null ? null : toBox(found.getBoundingClientRect()));
      });
    };

    window.addEventListener('scroll', track, true);
    window.addEventListener('resize', track);

    // The smooth scroll above is still running when the effect mounts; this catches where it lands.
    const settle = window.setTimeout(track, 400);

    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
      window.removeEventListener('scroll', track, true);
      window.removeEventListener('resize', track);
    };
    // `anchor === null` is the dependency that matters, not the box itself — depending on the box
    // would re-subscribe on every scroll frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stop, anchor === null]);

  /** The card's real height, so `placeCard` decides above-or-below against the truth. */
  useLayoutEffect(() => {
    if (cardRef.current === null) return;

    setCardHeight(cardRef.current.offsetHeight);
  }, [stop, settled]);

  /*
    Focus lands on the primary action of each new step. A dialog that opens without moving focus
    leaves a keyboard user's focus on whatever was behind it — under the dim layer, invisible, and
    still operable — which is the worst of both worlds.
  */
  useEffect(() => {
    primaryRef.current?.focus();
  }, [index, settled]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }

      if (isSinglePoint) return;

      if (event.key === 'ArrowRight') next();
      if (event.key === 'ArrowLeft' && index > 0) back();
    },
    [close, next, back, index, isSinglePoint],
  );

  if (stop === null) return null;

  const view = viewport();
  const cardWidth = Math.min(CARD_WIDTH, view.width - 32);
  const placement = placeCard(anchor, { width: cardWidth, height: cardHeight }, view);
  const spotlight = anchor === null ? null : spotlightBox(anchor);
  // Anchored but not found: say why, rather than pretending the stop was about nothing.
  const missing = settled && anchor === null && stop.anchors.length > 0;

  return (
    <div
      className="fixed inset-0 z-[70]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tour-title"
      /* The banner first when it is up: "whose answers am I looking at" is the thing a student
         listening to this needs before the stop's own sentence, not after it. */
      aria-describedby={demo === null ? 'tour-body' : 'tour-demo-note tour-body'}
      onKeyDown={onKeyDown}
    >
      {/*
        The dim layer, in one of two forms. With an anchor it is a single box carrying an enormous
        shadow spread, which paints everything *except* the anchor — one element rather than four
        strips that never quite meet at the corners. Without one it is an ordinary scrim.

        Either way it swallows clicks: the page underneath is not operable during a tour. That is
        deliberate. A student who clicks through the dimmed screen ends up somewhere the tour is
        not, with an overlay still pointing at the screen they left.
      */}
      {spotlight === null ? (
        <div
          className="absolute inset-0 bg-[color:rgb(2_6_23/0.72)]"
          onClick={close}
          aria-hidden="true"
        />
      ) : (
        <>
          {/*
            The dim, as a single box with an enormous shadow spread — it paints everything
            *except* the spotlight, which is one element rather than four strips that never quite
            meet at the corners.

            Its own outline is gone (2026-09-20): the ring is a second element below, so the halo
            can be animated without the browser re-rasterising a 9999px shadow on every frame of
            the animation. Same picture, a fraction of the paint cost.
          */}
          <div
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute',
              GLIDE,
              'transition-[top,left,width,height]',
            )}
            style={{
              top: spotlight.top,
              left: spotlight.left,
              width: spotlight.width,
              height: spotlight.height,
              boxShadow: '0 0 0 9999px rgb(2 6 23 / 0.72)',
            }}
          />
          {/*
            The ring, and the thing that actually does the pointing. `tour-spotlight` is the slow
            breathing halo (see `index.css`) — without it a still outline around a small button is
            genuinely easy to lose on a screen that just went dark all at once.
          */}
          <div
            aria-hidden="true"
            className={cn(
              'tour-spotlight pointer-events-none absolute border-2 border-primary',
              GLIDE,
              'transition-[top,left,width,height]',
            )}
            style={{
              top: spotlight.top,
              left: spotlight.left,
              width: spotlight.width,
              height: spotlight.height,
            }}
          />
          {/* The click-catcher, separate from the painted ring so the ring can stay
              `pointer-events-none` and never eat a click meant for the card above it. */}
          <div className="absolute inset-0" onClick={close} aria-hidden="true" />
        </>
      )}

      {/*
        Said once, in the only place that is above the dim and always on screen. It sits before
        the card in the DOM on purpose: both are absolutely positioned with no z-index, so the
        card wins wherever the two would overlap rather than being written over by a notice the
        student has already read.
      */}
      {demo === null ? null : (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-3">
          <p
            id="tour-demo-note"
            className="max-w-md border border-primary/50 bg-card px-3 py-2 text-center text-xs leading-relaxed text-foreground shadow-lg"
          >
            <strong className="font-semibold">This is an example student.</strong> You have not
            answered anything yet, so the screens behind this card are filled with somebody
            else&apos;s answers — that is what yours will look like once you have finished.
          </p>
        </div>
      )}

      <div
        ref={cardRef}
        className={cn(
          'absolute flex flex-col gap-3 border border-border bg-card p-5 shadow-2xl',
          GLIDE,
          'transition-[top,left]',
        )}
        style={{ top: placement.top, left: placement.left, width: cardWidth }}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="tour-title" className="text-base font-semibold text-foreground">
            {stop.title}
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label={isSinglePoint ? 'Close' : 'Skip the tour'}
            // 44px on a phone, 32px from `sm` (2026-09-20, `audit:responsive`). This is the
            // first control a student ever meets — the tour opens unprompted on their first
            // visit — and it was 32x32 at every width, under the WCAG 2.2 AA floor. The negative
            // margins grow with it so the "X" stays optically flush with the heading either way.
            className="-mr-2 -mt-2 flex size-11 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:-mr-1 sm:-mt-1 sm:size-8"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <p id="tour-body" className="text-sm leading-relaxed text-muted-foreground">
          {stop.body}
        </p>

        {missing ? (
          <p className="border-l-2 border-primary/40 pl-3 text-sm text-foreground/70">
            {stop.absentNote ?? 'This appears here once you have something to show.'}
          </p>
        ) : null}

        {isSinglePoint ? (
          <div className="flex justify-end pt-1">
            <Button ref={primaryRef} size="sm" onClick={close}>
              <Check className="size-4" aria-hidden="true" />
              Got it
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3 pt-1">
            <Progress total={steps.length} index={index} />

            <div className="flex items-center justify-between gap-2">
              {/*
                Skip, first and permanent. It is a real button at the same weight as the others
                rather than a grey link, because the student who wants it most is the one who has
                seen this before and should not have to hunt for the way out.
              */}
              <Button variant="ghost" size="sm" onClick={close}>
                Skip
              </Button>

              <div className="flex items-center gap-2">
                {index > 0 ? (
                  <Button variant="secondary" size="sm" onClick={back}>
                    <ArrowLeft className="size-4" aria-hidden="true" />
                    Back
                  </Button>
                ) : null}

                <Button ref={primaryRef} size="sm" onClick={next}>
                  {isLast ? 'Finish' : index === 0 ? 'Show me' : 'Next'}
                  {isLast ? (
                    <Check className="size-4" aria-hidden="true" />
                  ) : (
                    <ArrowRight className="size-4" aria-hidden="true" />
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Fill the screens behind the tour with an example student's answers — once, and only for a
 * student who has nothing of their own.
 *
 * ## The decision, and why it is taken exactly once
 *
 * `recommendations_ready` is the single flag that means *finished*: §27 produces a set only from
 * a student who has completed both instruments, so a student who has one has results, has a
 * printable report and has matches, and every stop of the tour can point at their own. Anybody
 * else is shown the example.
 *
 * The ref makes it a one-shot. Once the example student is in place the dashboard query answers
 * with *its* numbers — `recommendations_ready: true` — and a decision re-taken on every render
 * would be reading its own output. It also means a query that settles mid-tour cannot swap the
 * screens out from under a student halfway through reading a card.
 *
 * ## Waiting, and not waiting long
 *
 * Nothing is substituted until the dashboard query has actually answered, because standing an
 * example student in front of somebody who has finished — even for a frame — would be showing
 * them somebody else's Holland code as their own. A query that *fails* falls through to the
 * example: the alternative is a tour whose second half points at nothing, and the banner says
 * plainly whose answers these are either way.
 */
function useExampleStudent(running: boolean) {
  const { data: dashboard, isPending, isError } = useStudentDashboard();
  const show = useTourDemoStore((state) => state.show);
  const hide = useTourDemoStore((state) => state.hide);
  const decided = useRef(false);

  useEffect(() => {
    /*
      The end of a tour, and the reason this is not only an unmount cleanup: `steps` empties one
      render before the shell stops rendering the overlay, and a substitution that waited for the
      unmount would leave a stranger's results on screen for that frame — on the screen the
      student is now free to click. Resetting the decision here is what lets a second tour, later
      the same session, ask the question again.
    */
    if (!running) {
      decided.current = false;
      hide();

      return;
    }

    if (decided.current) return;
    if (isPending && !isError) return;

    decided.current = true;

    if (dashboard?.recommendations_ready === true) return;

    show(demoStudent());
  }, [running, dashboard, isPending, isError, show, hide]);

  // And again on the way out, for the shell unmounting the overlay without the store ever going
  // quiet — a route change, a sign-out.
  useEffect(() => hide, [hide]);
}

/**
 * Where you are, twice over: dots for the glance, and a sentence for anyone who cannot see them.
 *
 * A tour with no visible end is a tour people abandon — "how much more of this is there" is the
 * question the dots answer before it is asked.
 */
function Progress({ total, index }: { total: number; index: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="sr-only">{`Step ${index + 1} of ${total}`}</span>
      {Array.from({ length: total }, (_, step) => (
        <span
          key={step}
          aria-hidden="true"
          className={cn(
            'h-1 flex-1 transition-colors motion-reduce:transition-none',
            step <= index ? 'bg-primary' : 'bg-border',
          )}
        />
      ))}
    </div>
  );
}

/**
 * The first anchor in the list that is actually on screen.
 *
 * `getClientRects().length` rather than `offsetParent`, because `offsetParent` is null for a
 * `position: fixed` element that is perfectly visible — which is exactly what the assistant's
 * launcher button is.
 */
function findVisible(anchors: string[]): HTMLElement | null {
  for (const anchor of anchors) {
    const elements = document.querySelectorAll<HTMLElement>(anchorSelector(anchor));

    for (const element of elements) {
      const rect = element.getBoundingClientRect();

      if (element.getClientRects().length > 0 && rect.width > 0 && rect.height > 0) {
        return element;
      }
    }
  }

  return null;
}

function toBox(rect: DOMRect): Box {
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

function viewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

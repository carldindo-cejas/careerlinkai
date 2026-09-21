/**
 * The tour's *shape* — its stop ids, their order, and its version. No copy.
 *
 * ## Why this is not simply the top of `stops.ts`
 *
 * Because of what imports it. `stores/tourStore.ts` needs the order and the version to decide, on
 * a student's very first paint, whether to offer the tour at all — so whatever the store imports
 * is in the student route's **static** bundle. `stops.ts` is four kilobytes of prose, and left in
 * one file with these three constants it rode along: every student paid for the wording of ten
 * cards before the shell had rendered, including the returning student who will never see them.
 *
 * Split, the prose is reachable only from the two lazy chunks that render it — the overlay and the
 * chat panel — and the static cost of the tour is this file. The route budget is 565 KiB and the
 * student screen sits about 4 KiB under it; that margin is what this split protects, and the
 * 2026-09-21 revision spent part of it — see `STUDENT_SCREEN_BUDGET` in `platform-gates.mjs`.
 *
 * `stops.ts` re-exports all three, so nothing outside the store needs to know this file exists.
 */

/**
 * A stop's id.
 *
 * The ones that are also chat destinations carry the **same string** as `STUDENT_DESTINATIONS` on
 * the server — that string is the whole contract between them, and `stops.test.ts` pins the list.
 */
export type TourStopId =
  | 'welcome'
  | 'nav'
  // One id per row of the navigation (2026-09-20). They are tour-only — the assistant never sends
  // one, because "take me to the Assessments menu item" is not a thing anybody asks.
  | 'nav-dashboard'
  | 'nav-assessments'
  | 'nav-results'
  | 'nav-recommendations'
  | 'nav-profile'
  | 'dashboard'
  | 'assessments'
  | 'results'
  | 'report-download'
  | 'recommendations'
  | 'profile'
  | 'profile-strand'
  | 'profile-grades'
  | 'assistant'
  | 'notifications'
  | 'sign-out'
  | 'tour'
  | 'finish';

/**
 * The welcome tour, in the order a student actually travels.
 *
 * ## The menu row first, then what it opens (2026-09-20)
 *
 * Every destination is now introduced **twice**: once as the row in the navigation that reaches
 * it, and once as the screen itself. That is the change this revision is, and it is the difference
 * between a student who has seen four screens and a student who can get back to them. The old tour
 * teleported — a card said "your results" and the results were suddenly there — which taught the
 * screens and not the route to them, and the route is the part a student has to reproduce
 * tomorrow without an overlay holding their hand.
 *
 * The pairs are deliberately *adjacent*, and each `nav-*` stop stays on the page the student is
 * already standing on rather than navigating anywhere. So the rhythm is: point at the row, then
 * walk through it. Nothing in the tour ever jumps backwards to a screen it has left.
 *
 * ## The length
 *
 * Fifteen stops, up from ten. That is a real cost and it was paid on purpose: five of the six new
 * stops are one short sentence pointing at a single menu row, they are the cheapest kind of stop
 * to read, and **Skip is on every one of them** at the same weight as Next.
 *
 * What is still *not* here has not changed: the two profile sub-stops and the sign-out stop are
 * reachable from the assistant and stay out of the walk, because neither is something a student
 * needs before they have taken an assessment.
 */
export const TOUR: TourStopId[] = [
  'welcome',
  'nav',
  'nav-dashboard',
  'dashboard',
  'nav-assessments',
  'assessments',
  'nav-results',
  'results',
  'report-download',
  'nav-recommendations',
  'recommendations',
  'nav-profile',
  'profile',
  'assistant',
  'finish',
];

/**
 * Bump when the tour changes enough that a student who has seen the old one should see the new
 * one. It is the version recorded against "seen", so raising it re-offers the tour exactly once.
 */
export const TOUR_VERSION = 2;

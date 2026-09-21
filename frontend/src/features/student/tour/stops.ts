import { TOUR, TOUR_VERSION, type TourStopId } from '@/features/student/tour/tourOrder';
import { paths } from '@/routes/paths';

/**
 * Re-exported so this module stays the one place the tour is read from. The definitions live in
 * `tourOrder.ts` because `stores/tourStore.ts` needs them in the static bundle and must not drag
 * the copy below in with them — see that file for the whole reasoning.
 */
export { TOUR, TOUR_VERSION, type TourStopId };

/**
 * Every place a student can be shown, and where on the screen it actually is.
 *
 * ## Two jobs, one table
 *
 * This list is read by two features that would otherwise each grow their own copy of "where is the
 * results page":
 *
 *   1. **The welcome tour** — `TOUR` (in `tourOrder.ts`) walks a student through these stops in
 *      order, on their first visit and whenever they ask for it again.
 *   2. **The assistant's *"Yes, show me"*** — the chat answers a navigation question with a
 *      destination id (`backend/src/knowledge/student-destinations.ts`), and the button resolves
 *      that id here, navigates, and points at the same element the tour points at.
 *
 * Keeping them on one table is not tidiness. It means the sentence the assistant says and the
 * thing the arrow lands on cannot drift apart, which is the only way a student finds out the
 * feature is lying.
 *
 * ## `anchors`, and why it is a list
 *
 * A stop names the `data-tour` attributes it may attach to, most preferred first, and the overlay
 * uses the first one that is **visible**. That is what makes one table work at every width: the
 * navigation is a sidebar on a laptop and a button that opens a drawer on a phone, so `nav` names
 * both and the right one wins wherever the student is.
 *
 * An empty list is a legitimate stop — the opening and closing cards have nothing to point at and
 * render centred.
 *
 * ## When the element is not there
 *
 * Often, and by design. A student with no results has no result cards; a student who has not
 * finished both assessments has no recommendations. The overlay waits briefly for a lazy route and
 * its data, then shows the card centred with its copy intact rather than skipping the stop —
 * because *"this is where your results will be"* is exactly what a student with none needs to
 * hear. `absentNote` is what it says instead.
 */

export interface TourStop {
  id: TourStopId;
  /** The card's heading. Short — it is read at a glance, over a dimmed screen. */
  title: string;
  /** What this is for, in a student's words. Two sentences at most. */
  body: string;
  /** The route this stop lives on. The overlay navigates there before looking for the anchor. */
  path: string;
  /** `data-tour` values to point at, most preferred first. Empty means a centred card. */
  anchors: string[];
  /** What the card says when the anchor is genuinely not on the page yet. */
  absentNote?: string;
}

/**
 * The stops, keyed by id.
 *
 * Written as a record rather than an array because both readers index it: the tour walks the ids in
 * `TOUR`, and the assistant arrives holding one id and nothing else.
 */
export const TOUR_STOPS: Record<TourStopId, TourStop> = {
  welcome: {
    id: 'welcome',
    title: 'Welcome to CareerLinkAI',
    body: 'This takes about a minute and shows you where everything is. You can skip it now and start it again any time — just ask the assistant to show you around.',
    path: paths.studentDashboard,
    anchors: [],
  },

  nav: {
    id: 'nav',
    title: 'Everything lives in this menu',
    body: 'Four places: your dashboard, your assessments, your results, and your recommendations. On a phone, tap this button to open it.',
    path: paths.studentDashboard,
    // The sidebar on a laptop, the drawer button on a phone — whichever is on screen.
    anchors: ['nav', 'nav-mobile'],
  },

  /*
    The five menu rows, each shown on the screen the student is already standing on so the tour
    never walks backwards. Every one falls back to the drawer button: on a phone the rows live
    inside a sheet that is closed, and pointing at the button that opens it is the true answer
    there — which is why the copy names the item rather than relying on the arrow alone.
  */
  'nav-dashboard': {
    id: 'nav-dashboard',
    title: 'Dashboard',
    body: 'The first row in the menu. It is the summary of everything else — start here when you are not sure what to do next.',
    path: paths.studentDashboard,
    anchors: ['nav-dashboard', 'nav-mobile'],
    absentNote: 'Open the menu and Dashboard is the first item in it.',
  },

  'nav-assessments': {
    id: 'nav-assessments',
    title: 'Assessments, in the menu',
    body: 'The second row. This is the one you will use most at the start — everything your counselor gives you to answer is behind it.',
    path: paths.studentDashboard,
    anchors: ['nav-assessments', 'nav-mobile'],
    absentNote: 'Open the menu and Assessments is the second item in it.',
  },

  'nav-results': {
    id: 'nav-results',
    title: 'My results, in the menu',
    body: 'The third row. Come back to it whenever you want to read your scores again — they do not disappear once you have seen them.',
    path: paths.studentAssessments,
    anchors: ['nav-results', 'nav-mobile'],
    absentNote: 'Open the menu and My results is the third item in it.',
  },

  'nav-recommendations': {
    id: 'nav-recommendations',
    title: 'My recommendations, in the menu',
    body: 'The last row, and the one everything else leads to. Careers and programs picked from your own answers.',
    path: paths.studentResults,
    anchors: ['nav-recommendations', 'nav-mobile'],
    absentNote: 'Open the menu and My recommendations is the last item in it.',
  },

  'nav-profile': {
    id: 'nav-profile',
    title: 'Your name, at the bottom',
    body: 'Not a menu row — your own name, under the four of them and above Sign out. That is the way into your profile.',
    path: paths.studentRecommendations,
    anchors: ['nav-profile', 'nav-mobile'],
    absentNote: 'Open the menu and your name is at the bottom, just above Sign out.',
  },

  dashboard: {
    id: 'dashboard',
    title: 'Your progress at a glance',
    body: 'These four boxes count what you have been assigned, what you have finished, how many results you have, and whether your recommendations are ready. Press any of them to go there.',
    path: paths.studentDashboard,
    anchors: ['dashboard-stats'],
  },

  assessments: {
    id: 'assessments',
    title: 'Take your assessments here',
    body: 'Whatever your counselor assigns you appears here. Answer honestly — nobody is grading you, there are no wrong answers, and you can stop halfway and come back.',
    path: paths.studentAssessments,
    anchors: ['assessment-list'],
    absentNote: 'Nothing has been assigned to you yet. When it is, it will appear right here.',
  },

  results: {
    id: 'results',
    title: 'Your results',
    body: 'Your RIASEC interests and your SCCT confidence, each scored out of 100. These are not marks — there is no pass or fail. They describe what you enjoy and how sure you feel.',
    path: paths.studentResults,
    anchors: ['result-cards'],
    absentNote: 'Finish an assessment and your scores will show up here.',
  },

  'report-download': {
    id: 'report-download',
    title: 'Save or print your results',
    body: 'This puts your results on one clean sheet you can show your parents or your counselor, or save as a PDF.',
    path: paths.studentResults,
    anchors: ['results-print'],
    absentNote:
      'This button appears once you have finished both the RIASEC and the SCCT assessment.',
  },

  recommendations: {
    id: 'recommendations',
    title: 'Careers and programs that fit you',
    body: 'Ranked from your own answers — not chosen by an AI. Every card tells you why it is on your list, and which colleges in Bohol offer it.',
    path: paths.studentRecommendations,
    anchors: ['recommendation-lists'],
    absentNote: 'These appear once you have finished both the RIASEC and the SCCT assessment.',
  },

  profile: {
    id: 'profile',
    title: 'Your profile',
    body: 'Your strand and your subject grades live here. Your assessment scores never depend on them, but your program recommendations do — a blank field is a match we cannot make.',
    path: paths.studentProfile,
    anchors: ['profile-form'],
  },

  'profile-strand': {
    id: 'profile-strand',
    title: 'Your strand',
    body: 'The single most important field on this page — it decides which programs are a fit for you at all. Change it, press Save, then rebuild your recommendations.',
    path: paths.studentProfile,
    anchors: ['profile-strand'],
  },

  'profile-grades': {
    id: 'profile-grades',
    title: 'Your subject grades',
    body: 'Math, Science and English. They are 10% of every program match, so filling them in sharpens your list. Leaving one blank is never counted against you.',
    path: paths.studentProfile,
    anchors: ['profile-grades'],
  },

  assistant: {
    id: 'assistant',
    title: 'Ask CareerLinkAI anything',
    body: 'This button is on every screen. Ask it why a career is on your list, what a program involves, or simply where something is — it will bring you there.',
    path: paths.studentDashboard,
    anchors: ['assistant-launcher'],
  },

  notifications: {
    id: 'notifications',
    title: 'Notifications',
    body: 'The bell tells you when an assessment is assigned to you, or when your school answers a question you asked.',
    path: paths.studentDashboard,
    anchors: ['notifications-bell'],
  },

  'sign-out': {
    id: 'sign-out',
    title: 'Signing out',
    body: 'At the bottom of the menu. Use it before you leave a shared computer — it also clears your class from this browser so the next student does not see it.',
    path: paths.studentDashboard,
    anchors: ['sign-out', 'nav-mobile'],
    absentNote: 'Open the menu and you will find Sign out at the very bottom, under your name.',
  },

  tour: {
    id: 'tour',
    title: 'The tour',
    body: 'This is it — you are on it.',
    path: paths.studentDashboard,
    anchors: [],
  },

  finish: {
    id: 'finish',
    title: 'That is everything',
    body: 'Start with your assessments; your results and recommendations follow from them. If you ever lose your way, ask the assistant — it can take you straight to any screen.',
    path: paths.studentDashboard,
    anchors: ['assistant-launcher'],
  },
};

/** A stop by id, or null — an id from the server this build does not know renders no button. */
export function stopFor(id: string): TourStop | null {
  return TOUR_STOPS[id as TourStopId] ?? null;
}

/**
 * The attribute a stop's anchors are written with, so the markup and the lookup share one string.
 * `data-tour="result-cards"` on the element, `[data-tour="result-cards"]` here.
 */
export function anchorSelector(anchor: string): string {
  return `[data-tour="${anchor}"]`;
}

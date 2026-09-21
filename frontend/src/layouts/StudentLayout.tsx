import { BookOpenCheck, ChartColumn, Compass, LayoutDashboard } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

import { ScrollHint } from '@/components/ui/scroll-hint';
import { useProfile } from '@/features/student/hooks/useAssessment';
import { ProfileGate } from '@/features/student/components/ProfileGate';
import { AppShell, type AppNavItem } from '@/layouts/AppShell';
import { paths } from '@/routes/paths';
import { useStudentClassStore } from '@/stores/studentClassStore';
import { shouldOfferTour, useTourRunning, useTourStore } from '@/stores/tourStore';

/**
 * The chat launcher arrives after the shell (2026-09-13). Imported statically, the whole assistant
 * panel was part of every student screen's cold load and pushed the student route past its 530 KiB
 * budget (`platform-gates.mjs`, audit P2).
 */
const StudentChatLauncher = lazy(async () => ({
  default: (await import('@/features/student/components/RecommendationChatPanel'))
    .StudentChatLauncher,
}));

/**
 * The welcome tour (2026-09-18), lazy for the same reason and with a stricter rule: it is mounted
 * only while a tour is actually running, so a returning student never fetches the chunk at all.
 * The decision to *start* one lives in `stores/tourStore.ts`, which is small and static.
 */
const StudentTour = lazy(async () => ({
  default: (await import('@/features/student/tour/StudentTour')).StudentTour,
}));

/**
 * The student's destinations (§37) — the same shell as staff now, so the three roles
 * share one layout system (sidebar, top bar, drawer under `lg`).
 *
 * "My recommendations" sits directly after "My results" because that is the order the student
 * actually travels: an assessment produces a result, and two results produce a recommendation. It
 * is a top-level destination rather than a tab inside the results page because a recommendation is
 * not a property of any single result — it is drawn from RIASEC *and* SCCT together (§27), and
 * filing it under one of them would misrepresent where the number came from.
 */
const nav: AppNavItem[] = [
  { to: paths.studentDashboard, label: 'Dashboard', icon: LayoutDashboard, end: true, tour: 'nav-dashboard' },
  { to: paths.studentAssessments, label: 'Assessments', icon: BookOpenCheck, tour: 'nav-assessments' },
  { to: paths.studentResults, label: 'My results', icon: ChartColumn, tour: 'nav-results' },
  {
    to: paths.studentRecommendations,
    label: 'My recommendations',
    icon: Compass,
    tour: 'nav-recommendations',
  },
];

/** Not a nav row — reached from the name in the top bar and above "Sign out", where accounts live. */
const profile = { to: paths.studentProfile, label: 'My profile' };

/**
 * Signed-in student shell (FULLPLAN §35, §37).
 *
 * Composes AppShell like the staff layouts, with two student-specific pieces: the chrome
 * shows the class they joined rather than a role badge, and signing out clears the class
 * context too — otherwise the next student on a shared lab machine would see the last
 * one's class named on the access screen.
 */
export function StudentLayout() {
  const classRoom = useStudentClassStore((state) => state.classRoom);
  const clearClass = useStudentClassStore((state) => state.clear);

  const { pathname } = useLocation();
  // The recommendations page has the assistant as a column already (AI-COVERAGE-PLAN.md Phase 4).
  const onRecommendations = pathname.startsWith(paths.studentRecommendations);

  const tourRunning = useTourRunning();
  const startTour = useTourStore((state) => state.startTour);
  // Where this shell was first rendered — not where it is now, which changes as the student moves.
  const landedOn = useRef(pathname);
  /** Answered once per mount, whenever the conditions below finally settle. */
  const offered = useRef(false);

  /**
   * The profile, read here only to answer "is the gate about to be in the way?". The query is the
   * same one `ProfileGate` uses, so this is a cache read rather than a second request.
   */
  // Not `profile` — that name is taken at module scope by the "My profile" nav destination.
  const { data: studentProfile, isError: profileFailed } = useProfile();

  /**
   * The first visit, and only the first.
   *
   * Four conditions, and each rules out a way this could go wrong:
   *
   *   * **`shouldOfferTour()`, read imperatively rather than subscribed to.** A tour that
   *     re-decides on every render is a tour that can open at any moment.
   *   * **A `ref` rather than an empty dependency list**, so the question is answered once per
   *     mount but is allowed to wait for an answer instead of being settled before there is one.
   *   * **Only on the dashboard.** The shell also hosts the assessment player, and the tour's
   *     first stop navigates to the dashboard — so without this, a student who reloaded the page
   *     halfway through sixty questions would be walked out of their own attempt by an
   *     introduction. The offer is not lost: nothing is recorded as seen, so it is made the next
   *     time they open the app on the screen it belongs on.
   *   * **Not while `ProfileGate` is up** (2026-09-20). This one was caught by
   *     `npm run audit:responsive`, in the screenshot rather than the findings: a brand-new
   *     student is both the only person the tour introduces itself to *and* the only person the
   *     gate stops, so the two opened on top of each other on the very first screen. The tour
   *     points at a dashboard the student cannot reach yet, which makes it a tour of a locked
   *     door. It waits for the profile to be complete — or for the profile request to have
   *     failed, since the gate does not render in that case either and the introduction is then
   *     the only thing on screen.
   *
   * Finishing *or* skipping records the version, which is why the dashboard also carries a "Take
   * the tour" button — once dismissed, the tour has to be askable for. The assistant answers
   * "show me around" with the same thing.
   */
  useEffect(() => {
    if (offered.current) return;
    if (landedOn.current !== paths.studentDashboard) return;

    // `undefined` is "not known yet", which is not the same as "complete" — so it waits.
    const gateIsClear = profileFailed || studentProfile?.profiling.is_complete === true;

    if (!gateIsClear) return;

    offered.current = true;

    if (shouldOfferTour()) startTour();
  }, [studentProfile, profileFailed, startTour]);

  return (
    <>
    {onRecommendations ? null : (
      <Suspense fallback={null}>
        <StudentChatLauncher />
      </Suspense>
    )}
    {tourRunning ? (
      <Suspense fallback={null}>
        <StudentTour />
      </Suspense>
    ) : null}
    {/*
      The profile gate, on every student route, replacing the `ProfilingBanner` strip that used to
      sit under the top bar (2026-09-20). It renders nothing once the required fields are filled
      in, so a complete profile costs an already-cached query and no layout at all — and while it
      is up, nothing behind it is reachable. See `ProfileGate` for why that is the point.
    */}
    <ProfileGate />
    {/*
      Remounted per route, which is the whole of how it re-offers itself.

      The hint retires as soon as the student scrolls, and it has to: a chevron that stays put
      while the page moves under it is noise. But "they have scrolled" is a fact about the screen
      they scrolled, not about the session — the dashboard being read to the bottom says nothing
      about whether the results page below the fold will be. A `key` on the path is the shortest
      honest way to say that.
    */}
    <ScrollHint key={pathname} />
    <AppShell
      title="Student"
      nav={nav}
      profile={profile}
      onSignedOut={clearClass}
      headerBadge={
        classRoom ? (
          <span className="hidden truncate rounded-none bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground/80 sm:block">
            {classRoom.name}
          </span>
        ) : null
      }
    />
    </>
  );
}

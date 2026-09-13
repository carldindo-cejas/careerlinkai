import { BookOpenCheck, ChartColumn, Compass, LayoutDashboard } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { useLocation } from 'react-router-dom';

import { ProfilingBanner } from '@/features/student/components/ProfilingBanner';
import { AppShell, type AppNavItem } from '@/layouts/AppShell';
import { paths } from '@/routes/paths';
import { useStudentClassStore } from '@/stores/studentClassStore';

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
  { to: paths.studentDashboard, label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: paths.studentAssessments, label: 'Assessments', icon: BookOpenCheck },
  { to: paths.studentResults, label: 'My results', icon: ChartColumn },
  { to: paths.studentRecommendations, label: 'My recommendations', icon: Compass },
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

  // The recommendations page has the assistant as a column already (AI-COVERAGE-PLAN.md Phase 4).
  const onRecommendations = useLocation().pathname.startsWith(paths.studentRecommendations);

  return (
    <>
    {onRecommendations ? null : (
      <Suspense fallback={null}>
        <StudentChatLauncher />
      </Suspense>
    )}
    <AppShell
      title="Student"
      nav={nav}
      profile={profile}
      onSignedOut={clearClass}
      /**
       * The profiling warning, on every student route (v1.6). It renders nothing once the required
       * fields are filled in, so this costs an already-cached query and no layout.
       */
      banner={<ProfilingBanner />}
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

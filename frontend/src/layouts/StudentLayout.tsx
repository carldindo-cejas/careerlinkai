import { BookOpenCheck, ChartColumn, Compass, LayoutDashboard, UserRound } from 'lucide-react';

import { ProfilingBanner } from '@/features/student/components/ProfilingBanner';
import { AppShell, type AppNavItem } from '@/layouts/AppShell';
import { paths } from '@/routes/paths';
import { useStudentClassStore } from '@/stores/studentClassStore';

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
  { to: paths.studentProfile, label: 'My profile', icon: UserRound },
];

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

  return (
    <AppShell
      title="Student"
      nav={nav}
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
  );
}

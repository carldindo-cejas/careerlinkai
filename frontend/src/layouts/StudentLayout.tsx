import { LogOut } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';

import { Logo } from '@/components/brand/Logo';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { useLogout } from '@/features/auth/hooks/useAuth';
import { NotificationBell } from '@/features/notifications/components/NotificationBell';
import { paths } from '@/routes/paths';
import { useAuthStore } from '@/stores/authStore';
import { useStudentClassStore } from '@/stores/studentClassStore';

/**
 * The student's destinations (§37). Deliberately flat and short — this is a shell a
 * seventeen-year-old uses three times in a year, not a console.
 *
 * "My recommendations" sits directly after "My results" because that is the order the student
 * actually travels: an assessment produces a result, and two results produce a recommendation. It
 * is a top-level destination rather than a tab inside the results page because a recommendation is
 * not a property of any single result — it is drawn from RIASEC *and* SCCT together (§27), and
 * filing it under one of them would misrepresent where the number came from.
 */
const nav = [
  { to: paths.studentAssessments, label: 'Assessments' },
  { to: paths.studentResults, label: 'My results' },
  { to: paths.studentRecommendations, label: 'My recommendations' },
  { to: paths.studentProfile, label: 'My profile' },
];

/**
 * Signed-in student shell (FULLPLAN §35, §37).
 *
 * Not a StaffLayout with a different title: the student chrome shows the class they joined
 * rather than a role badge, and signing out has to clear the class context too — otherwise
 * the next student on a shared lab machine would see the last one's class named on the
 * access screen. The student keeps a top bar rather than the staff sidebar: four
 * destinations do not need a rail.
 */
export function StudentLayout() {
  const user = useAuthStore((state) => state.user);
  const classRoom = useStudentClassStore((state) => state.classRoom);
  const clearClass = useStudentClassStore((state) => state.clear);

  const logout = useLogout();

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-card/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <Logo />
            {classRoom ? (
              <span className="hidden truncate rounded-full bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground/80 sm:block">
                {classRoom.name}
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-2 sm:gap-4">
            {/* Phase 6 (§44): "Notifications" is a named student destination in §37. */}
            <NotificationBell />

            {user ? (
              <span className="hidden text-sm text-foreground/80 md:block">{user.name}</span>
            ) : null}

            <Button
              variant="ghost"
              size="sm"
              onClick={() => logout.mutate(undefined, { onSettled: clearClass })}
              loading={logout.isPending}
            >
              <LogOut className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>

        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 sm:px-6">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  '-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
                  isActive
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl p-4 sm:p-6">
        <Outlet />
      </main>
    </div>
  );
}

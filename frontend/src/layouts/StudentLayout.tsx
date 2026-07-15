import { LogOut } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { useLogout } from '@/features/auth/hooks/useAuth';
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
 * access screen.
 */
export function StudentLayout() {
  const user = useAuthStore((state) => state.user);
  const classRoom = useStudentClassStore((state) => state.classRoom);
  const clearClass = useStudentClassStore((state) => state.clear);

  const logout = useLogout();

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-baseline gap-3">
            <span className="text-base font-semibold text-slate-900">CareerLinkAI</span>
            {classRoom ? <span className="text-sm text-slate-500">{classRoom.name}</span> : null}
          </div>

          <div className="flex items-center gap-4">
            {user ? <span className="text-sm text-slate-600">{user.name}</span> : null}

            <Button
              variant="ghost"
              size="sm"
              onClick={() => logout.mutate(undefined, { onSettled: clearClass })}
              loading={logout.isPending}
            >
              <LogOut className="size-4" aria-hidden="true" />
              Sign out
            </Button>
          </div>
        </div>

        <nav className="mx-auto flex max-w-6xl gap-1 px-6">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                [
                  '-mb-px border-b-2 px-3 py-2.5 text-sm font-medium transition',
                  isActive
                    ? 'border-slate-900 text-slate-900'
                    : 'border-transparent text-slate-500 hover:text-slate-800',
                ].join(' ')
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl p-6">
        <Outlet />
      </main>
    </div>
  );
}

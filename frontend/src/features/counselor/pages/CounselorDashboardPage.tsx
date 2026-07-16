import { ArrowRight, BookOpen, Compass, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useCounselorDashboard } from '@/features/counselor/hooks/useDashboard';
import { classDetailPath, paths } from '@/routes/paths';
import { useAuthStore } from '@/stores/authStore';

/**
 * Counselor dashboard (FULLPLAN §37, §54 — Phase 6): the caseload at a glance — classes,
 * students, what is assigned, what has come back scored, and how many students have
 * reached the point the whole platform exists for: a recommendation to talk about.
 */
export function CounselorDashboardPage() {
  const user = useAuthStore((state) => state.user);
  const profile = user?.counselor_profile;
  const { data, isLoading, isError, error } = useCounselorDashboard();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">
          Welcome back,{' '}
          {profile ? `${profile.first_name} ${profile.last_name}` : (user?.name ?? 'Counselor')}
        </h1>
        <p className="text-sm text-slate-500">Your caseload at a glance.</p>
      </div>

      {isLoading ? <p className="text-sm text-slate-500">Gathering your numbers…</p> : null}

      {isError ? <Alert>We could not load the dashboard. {error.message}</Alert> : null}

      {data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard
              icon={<Users className="size-4" aria-hidden="true" />}
              label="Classes · Students"
              value={`${data.totals.classes} · ${data.totals.students}`}
            />
            <StatCard
              icon={<BookOpen className="size-4" aria-hidden="true" />}
              label="Active assignments"
              value={data.totals.active_assignments}
            />
            <StatCard
              icon={<Compass className="size-4" aria-hidden="true" />}
              label="Students with recommendations"
              value={data.students_with_recommendations}
            />
          </div>

          {data.classes.length === 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>No classes yet</CardTitle>
                <CardDescription>
                  Create a class to get a join code for your students — they sign in with just
                  that code and a username.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Link
                  to={paths.counselorClasses}
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-900 hover:underline"
                >
                  Create a class
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Your classes</CardTitle>
                  <Link
                    to={paths.counselorClasses}
                    className="text-sm font-medium text-slate-500 hover:text-slate-900 hover:underline"
                  >
                    Manage classes
                  </Link>
                </div>
                <CardDescription>
                  {data.attempts.scored} scored attempt{data.attempts.scored === 1 ? '' : 's'}
                  {data.attempts.in_progress > 0
                    ? ` · ${data.attempts.in_progress} still in progress`
                    : ''}
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-400">
                        <th className="px-6 py-3 font-medium">Class</th>
                        <th className="px-4 py-3 font-medium">Students</th>
                        <th className="px-4 py-3 font-medium">Active assignments</th>
                        <th className="px-4 py-3 font-medium">Scored attempts</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.classes.map((row) => (
                        <tr key={row.id} className="border-b border-slate-50 last:border-b-0">
                          <td className="px-6 py-3">
                            <Link
                              to={classDetailPath(row.id)}
                              className="font-medium text-slate-900 hover:underline"
                            >
                              {row.name}
                            </Link>
                          </td>
                          <td className="px-4 py-3 tabular-nums text-slate-600">
                            {row.students_count}
                          </td>
                          <td className="px-4 py-3 tabular-nums text-slate-600">
                            {row.active_assignments}
                          </td>
                          <td className="px-4 py-3 tabular-nums text-slate-600">
                            {row.scored_attempts}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      ) : null}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: number | string;
}) {
  return (
    <Card className="h-full">
      <CardContent className="flex flex-col gap-1 p-5">
        <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-400">
          {icon}
          {label}
        </span>
        <span className="text-2xl font-semibold tabular-nums text-slate-900">{value}</span>
      </CardContent>
    </Card>
  );
}

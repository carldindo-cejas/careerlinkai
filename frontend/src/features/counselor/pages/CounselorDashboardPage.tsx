import {
  ArrowRight,
  BellRing,
  BookOpen,
  ClipboardList,
  Compass,
  GraduationCap,
  Plus,
  Users,
} from 'lucide-react';
import { Link } from 'react-router-dom';

import { BarList } from '@/components/charts/BarList';
import { chartColors } from '@/components/charts/colors';
import { DonutChart } from '@/components/charts/DonutChart';
import { Meter } from '@/components/charts/Meter';
import { StatCard } from '@/components/dashboard/StatCard';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useCounselorDashboard } from '@/features/counselor/hooks/useDashboard';
import { useNotifications } from '@/features/notifications/hooks/useNotifications';
import { classDetailPath, paths } from '@/routes/paths';
import { useAuthStore } from '@/stores/authStore';

/**
 * Counselor dashboard (FULLPLAN §37, §54 — Phase 6), management pass over the idea2
 * reference: the caseload at a glance — KPI row, completion tracking, per-class
 * statistics, recommendation coverage, quick actions and the latest activity. Every
 * number is pulled live from the domain tables; nothing here is a cache or a mock.
 */
export function CounselorDashboardPage() {
  const user = useAuthStore((state) => state.user);
  const profile = user?.counselor_profile;
  const { data, isLoading, isError, error } = useCounselorDashboard();
  // The same scoped feed the bell polls — reused here as "recent activity", so the two
  // never disagree and the dashboard costs no extra endpoint.
  const { data: notifications } = useNotifications();

  const attemptsTotal = data ? data.attempts.scored + data.attempts.in_progress : 0;
  const completionPercent =
    data && attemptsTotal > 0 ? (data.attempts.scored / attemptsTotal) * 100 : null;
  const recommendationPercent =
    data && data.totals.students > 0
      ? (data.students_with_recommendations / data.totals.students) * 100
      : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">
            Welcome back,{' '}
            {profile ? `${profile.first_name} ${profile.last_name}` : (user?.name ?? 'Counselor')}
          </h1>
          <p className="text-sm text-muted-foreground">Your caseload at a glance.</p>
        </div>

        {/* Quick actions — the two places a counselor's day starts. */}
        <div className="flex gap-2">
          <Link
            to={paths.counselorClasses}
            className="inline-flex h-9 items-center gap-1.5 rounded-none bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Plus className="size-4" aria-hidden="true" />
            New class
          </Link>
          <Link
            to={paths.counselorAssessmentTemplates}
            className="inline-flex h-9 items-center gap-1.5 rounded-none border border-border bg-transparent px-4 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
          >
            <ClipboardList className="size-4" aria-hidden="true" />
            Assessments
          </Link>
        </div>
      </div>

      {isLoading ? <p className="text-sm text-muted-foreground">Gathering your numbers…</p> : null}

      {isError ? <Alert>We could not load the dashboard. {error.message}</Alert> : null}

      {data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              icon={<GraduationCap className="size-4" aria-hidden="true" />}
              label="Classes"
              value={data.totals.classes}
              to={paths.counselorClasses}
            />
            <StatCard
              icon={<Users className="size-4" aria-hidden="true" />}
              label="Students"
              value={data.totals.students}
            />
            <StatCard
              icon={<BookOpen className="size-4" aria-hidden="true" />}
              label="Active assignments"
              value={data.totals.active_assignments}
              hint={
                data.attempts.in_progress > 0
                  ? `${data.attempts.in_progress} attempts in progress`
                  : undefined
              }
            />
            <StatCard
              icon={<Compass className="size-4" aria-hidden="true" />}
              label="With recommendations"
              value={data.students_with_recommendations}
              hint={`of ${data.totals.students} students`}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle>Completion tracking</CardTitle>
                <CardDescription>
                  {attemptsTotal > 0
                    ? 'Every attempt across your classes, by status.'
                    : 'Once students start their assessments, progress shows here.'}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-5">
                <DonutChart
                  segments={[
                    { label: 'Scored', value: data.attempts.scored, color: chartColors.primary },
                    {
                      label: 'In progress',
                      value: data.attempts.in_progress,
                      color: chartColors.accent,
                    },
                  ]}
                  centerValue={String(attemptsTotal)}
                  centerLabel={attemptsTotal === 1 ? 'attempt' : 'attempts'}
                />
                {completionPercent !== null ? (
                  <Meter percent={completionPercent} label="scored" remainderLabel="in progress" />
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Scored attempts by class</CardTitle>
                <CardDescription>
                  {data.classes.length > 0
                    ? 'Which classes have results coming back.'
                    : 'Create a class to start tracking.'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {data.classes.length > 0 ? (
                  <BarList
                    items={data.classes.map((row) => ({
                      label: row.name,
                      value: row.scored_attempts,
                    }))}
                  />
                ) : (
                  <ChartPlaceholder />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Recommendation coverage</CardTitle>
                <CardDescription>
                  Students who have reached the point the platform exists for: a recommendation
                  to talk about.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {recommendationPercent !== null ? (
                  <Meter
                    percent={recommendationPercent}
                    label="covered"
                    remainderLabel="not yet"
                  />
                ) : (
                  <ChartPlaceholder />
                )}
                <p className="text-sm text-muted-foreground">
                  A student gets recommendations after completing both RIASEC and SCCT with a
                  complete profile (§27).
                </p>
              </CardContent>
            </Card>
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
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground hover:underline"
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
                    className="text-sm font-medium text-muted-foreground hover:text-foreground hover:underline"
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
                      <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-6 py-3 font-medium">Class</th>
                        <th className="px-4 py-3 font-medium">Students</th>
                        <th className="px-4 py-3 font-medium">Active assignments</th>
                        <th className="px-4 py-3 font-medium">Scored attempts</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.classes.map((row) => (
                        <tr key={row.id} className="border-b border-border last:border-b-0">
                          <td className="px-6 py-3">
                            <Link
                              to={classDetailPath(row.id)}
                              className="font-medium text-foreground hover:underline"
                            >
                              {row.name}
                            </Link>
                          </td>
                          <td className="px-4 py-3 tabular-nums text-muted-foreground">
                            {row.students_count}
                          </td>
                          <td className="px-4 py-3 tabular-nums text-muted-foreground">
                            {row.active_assignments}
                          </td>
                          <td className="px-4 py-3 tabular-nums text-muted-foreground">
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

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <BellRing className="size-4 text-muted-foreground" aria-hidden="true" />
                <CardTitle>Recent activity</CardTitle>
              </div>
              <CardDescription>The latest notifications scoped to you.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {notifications && notifications.items.length > 0 ? (
                <ul>
                  {notifications.items.slice(0, 5).map((notification) => (
                    <li
                      key={notification.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-6 py-2.5 text-sm first:border-t-0"
                    >
                      <span className="font-medium text-foreground">{notification.title}</span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {notification.message}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {notification.created_at
                          ? new Date(notification.created_at).toLocaleString()
                          : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-6 pb-5 text-sm text-muted-foreground">Nothing yet.</p>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

/** The graceful no-data state: an honest sentence-sized gap, not fake bars. */
function ChartPlaceholder() {
  return (
    <div className="flex h-24 items-center justify-center rounded-none border border-dashed border-border text-sm text-muted-foreground">
      No data yet
    </div>
  );
}

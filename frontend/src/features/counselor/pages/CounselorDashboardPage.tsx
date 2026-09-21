import {
  ArrowRight,
  BookOpen,
  ClipboardList,
  Compass,
  GraduationCap,
  Plus,
  Users,
} from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';

import { BarList } from '@/components/charts/BarList';
import { chartColors } from '@/components/charts/colors';
import { DonutChart } from '@/components/charts/DonutChart';
import { Meter } from '@/components/charts/Meter';
import { StatCard } from '@/components/dashboard/StatCard';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useCounselorDashboard } from '@/features/counselor/hooks/useDashboard';
import { classDetailPath, paths } from '@/routes/paths';
import { useAuthStore } from '@/stores/authStore';

/**
 * Counselor dashboard (FULLPLAN §37, §54 — Phase 6), management pass over the idea2
 * reference: the caseload at a glance — KPI row, completion tracking, per-class
 * statistics, recommendation coverage, quick actions and the classes themselves. Every
 * number is pulled live from the domain tables; nothing here is a cache or a mock.
 *
 * **"Recent activity" was removed on 2026-09-20** (prompt-driven). It rendered the same scoped
 * feed the bell in the top bar polls, five rows of it, at the very bottom of the longest screen
 * in this shell — so it was a second copy of a control that is already one click away on every
 * page, placed where a counselor scrolls past everything else to reach it. The bell is the feed;
 * this screen is the numbers.
 */
export function CounselorDashboardPage() {
  const user = useAuthStore((state) => state.user);
  const profile = user?.counselor_profile;
  const { data, isLoading, isError, error } = useCounselorDashboard();
  const navigate = useNavigate();

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
            className="inline-flex h-11 items-center gap-1.5 rounded-none bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 sm:h-9"
          >
            <Plus className="size-4" aria-hidden="true" />
            New class
          </Link>
          <Link
            to={paths.counselorAssessmentTemplates}
            className="inline-flex h-11 items-center gap-1.5 rounded-none border border-border bg-transparent px-4 text-sm font-medium text-foreground transition-colors hover:bg-secondary sm:h-9"
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
          {/*
            `grid-cols-2` from 0px up (prompt-driven, 2026-09-20), matching the student
            dashboard's KPI row. Stacked one-per-row these four tiles were most of a phone
            screen's height before a single chart came into view, and a stat tile is a label, a
            number and one short line — it fits in a half column, which `StatCard` is built for
            and pins in its own notes.
          */}
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
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
                    className="inline-flex min-h-11 items-center text-sm font-medium text-muted-foreground hover:text-foreground hover:underline sm:min-h-0"
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
                        /*
                          The whole row opens the class (prompt-driven, 2026-09-20). The name is
                          still a real `<Link>` and still the only focusable thing in the row —
                          that is what keyboard and screen-reader users follow, and what a
                          middle-click or "open in new tab" acts on. The row handler is a
                          convenience layered over it for the pointer, not a replacement: a `<tr>`
                          with a `role="link"` and a tabindex would be a worse link than the one
                          already inside it.
                        */
                        <tr
                          key={row.id}
                          onClick={(event) => {
                            // The name inside is a real link and has already done this. Without
                            // the guard, clicking it navigates twice to the same route — harmless
                            // today, and exactly the kind of thing that stops being harmless the
                            // first time one of these rows links somewhere else.
                            if ((event.target as HTMLElement).closest('a')) return;

                            void navigate(classDetailPath(row.id));
                          }}
                          className="cursor-pointer border-b border-border transition-colors last:border-b-0 hover:bg-muted/40"
                        >
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

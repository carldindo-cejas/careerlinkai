import {
  BookOpenCheck,
  ChartColumn,
  CheckCircle2,
  Compass,
  Sparkles,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { chartColors } from '@/components/charts/colors';
import { DonutChart } from '@/components/charts/DonutChart';
import { Meter } from '@/components/charts/Meter';
import { StatCard } from '@/components/dashboard/StatCard';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAssignments, useResults } from '@/features/student/hooks/useAssessment';
import { useStudentDashboard } from '@/features/student/hooks/useDashboard';
import { paths } from '@/routes/paths';
import { useAuthStore } from '@/stores/authStore';
import { useStudentClassStore } from '@/stores/studentClassStore';
import { useTourStore } from '@/stores/tourStore';
import type { AssessmentResult } from '@/types/assessment';

/**
 * The student's landing page (FULLPLAN §37): a KPI row, then the two cards that answer the one
 * question this screen exists to answer first — *what should I do next?* Every number is real
 * when it exists and says plainly what is missing when it does not, never a zero pretending to
 * be a measurement.
 *
 * **"Your RIASEC profile" and "Match confidence" were removed on 2026-09-20** (prompt-driven).
 * Both were duplicates wearing a chart: the interest bars are the whole subject of "My results",
 * which renders them from the same data with the bands and the Holland code that make them
 * readable, and the confidence histogram restated a distribution the recommendations page already
 * shows per row and in order. A dashboard that repeats the next screen's content is a dashboard a
 * student learns to scroll past — and on a phone those two cards were most of the page.
 */
export function StudentDashboardPage() {
  const user = useAuthStore((state) => state.user);
  const classRoom = useStudentClassStore((state) => state.classRoom);

  const { data: assignments, isError: assignmentsFailed, error: assignmentsError } = useAssignments();
  const { data: results } = useResults();
  // Phase 6: the aggregate view — used for the one fact the other queries cannot answer,
  // "do I have recommendations waiting?" (§27 needs both RIASEC and SCCT before any exist).
  const { data: dashboard } = useStudentDashboard();
  const navigate = useNavigate();
  const startTour = useTourStore((state) => state.startTour);

  const all = assignments ?? [];
  const scored = all.filter((a) => a.my_attempt?.status === 'SCORED');
  const inProgress = all.filter((a) => a.my_attempt?.status === 'IN_PROGRESS');
  const notStarted = all.filter((a) => !a.my_attempt || a.my_attempt.status === 'EXPIRED');
  const todo = all.filter((a) => a.my_attempt?.status !== 'SCORED');
  const done = results ?? [];

  const completionPercent = all.length > 0 ? (scored.length / all.length) * 100 : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">
            Welcome, {user?.name ?? 'student'}
          </h1>
          {classRoom ? (
            <p className="text-sm text-muted-foreground">
              {classRoom.name} · {classRoom.academic_year}
              {classRoom.grade_level ? ` · ${classRoom.grade_level}` : null}
            </p>
          ) : null}
        </div>

        {/*
          The way back into the tour, and the reason skipping it is safe to offer so plainly.

          The tour runs unprompted exactly once, and both finishing and skipping record that. Without
          somewhere to start it again, "Skip" would be a decision a student makes in their first ten
          seconds and cannot revisit — so the control is here, on the screen they land on, rather
          than buried in a profile page nobody opens. The assistant answers "show me around" with
          the same thing, for the student who asks instead of looking.
        */}
        <Button variant="ghost" size="sm" onClick={startTour}>
          <Compass className="size-4" aria-hidden="true" />
          Take the tour
        </Button>
      </div>

      {/*
        The profiling warning used to live here, then moved to a banner in the shell, and is now
        `ProfileGate` — a modal over every student route (2026-09-20). Nothing about an incomplete
        profile renders on this page any more, because a student with one cannot reach this page.
      */}

      {/*
        KPI row — real counts, no teasers.

        **Two across on a phone, not one** (prompt-driven, 2026-09-20). Stacked full-width, four
        tiles were four scrolls of a single number each and pushed "You have work to do" — the
        only thing on this page a student can act on — entirely below the fold on a 360px screen.
        Paired, the whole row is two rows deep and the call to action is visible on arrival.
        `grid-cols-2` from 0px up: a stat tile is a label, a number and one short line, which fits
        in 160px, and the tiles carry no touch target of their own beyond the whole card.
      */}
      <div data-tour="dashboard-stats" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          icon={<BookOpenCheck className="size-4" aria-hidden="true" />}
          label="Assessments"
          value={all.length}
          hint={todo.length > 0 ? `${todo.length} still to finish` : 'all done'}
          to={paths.studentAssessments}
        />
        <StatCard
          icon={<CheckCircle2 className="size-4" aria-hidden="true" />}
          label="Completed"
          value={scored.length}
          hint={inProgress.length > 0 ? `${inProgress.length} in progress` : undefined}
        />
        <StatCard
          icon={<ChartColumn className="size-4" aria-hidden="true" />}
          label="Results"
          value={dashboard?.results_count ?? done.length}
          to={paths.studentResults}
        />
        <StatCard
          icon={<Compass className="size-4" aria-hidden="true" />}
          label="Recommendations"
          value={dashboard?.recommendations_ready ? 'Ready' : '—'}
          hint={
            dashboard?.recommendations_ready
              ? 'drawn from RIASEC and SCCT'
              : 'finish both assessments first'
          }
          to={dashboard?.recommendations_ready ? paths.studentRecommendations : undefined}
        />
      </div>

      {/*
        Deviation D11, and this card is the reason D11 was written down.

        During the Steps 1-3 browser pass this dashboard cheerfully rendered "Nothing to do yet —
        your counselor will assign you an assessment" while `GET /student/assignments` was
        returning **404**. The screen had no isError branch, so a total failure of the endpoint and
        a student with an empty list produced pixel-identical output. It was harmless only while
        the endpoint genuinely did not exist. It became a lie the day Step 4 shipped it.

        So the failure gets its own branch, and the empty state is gated on the data having
        actually arrived. "We could not load this" is not a synonym for "there is nothing here",
        and this is the one screen where confusing the two costs a student their assessment.
      */}
      {assignmentsFailed ? (
        <Alert>
          We could not load your assessments. {assignmentsError.message} Try refreshing — if it
          keeps happening, tell your counselor.
        </Alert>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>{todo.length > 0 ? 'You have work to do' : 'Nothing to do yet'}</CardTitle>
              <CardDescription>
                {todo.length > 0
                  ? `${todo.length} ${todo.length === 1 ? 'assessment is' : 'assessments are'} waiting for you.`
                  : 'Your counselor will assign you an assessment. It will show up here.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {todo.length > 0 ? (
                <Button onClick={() => navigate(paths.studentAssessments)} className="w-fit">
                  {inProgress.length > 0 ? 'Continue where I left off' : 'Start'}
                </Button>
              ) : null}

              {/* Phase 6: only rendered once recommendations actually exist — never as a teaser. */}
              {dashboard?.recommendations_ready ? (
                <div className="rounded-none bg-primary/5 p-4">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                    <Sparkles className="size-4 text-primary" aria-hidden="true" />
                    Your recommendations are ready
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Ranked careers and programs, drawn from your RIASEC and SCCT results together.
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-3"
                    onClick={() => navigate(paths.studentRecommendations)}
                  >
                    See my recommendations
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Assessment progress</CardTitle>
              <CardDescription>
                {all.length > 0
                  ? 'Where each assigned assessment stands.'
                  : 'Once something is assigned, your progress shows here.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <DonutChart
                segments={[
                  { label: 'Completed', value: scored.length, color: chartColors.primary },
                  { label: 'In progress', value: inProgress.length, color: chartColors.accent },
                  { label: 'Not started', value: notStarted.length, color: chartColors.amber },
                ]}
                centerValue={String(all.length)}
                centerLabel={all.length === 1 ? 'assessment' : 'assessments'}
              />
              {completionPercent !== null ? (
                <Meter percent={completionPercent} label="complete" remainderLabel="to go" />
              ) : null}
            </CardContent>
          </Card>
        </div>
      )}

      {done.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>
              {done.length} {done.length === 1 ? 'assessment' : 'assessments'} completed.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <ul>
              {[...done]
                .sort(bySubmittedAtDesc)
                .slice(0, 5)
                .map((result) => (
                  <li
                    key={result.attempt_id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-6 py-2.5 text-sm first:border-t-0"
                  >
                    <span className="font-medium text-foreground">
                      {result.assessment?.title ?? 'Assessment'}
                    </span>
                    {result.result?.result_code ? (
                      <span className="rounded-none bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground/80">
                        {result.result.result_code}
                      </span>
                    ) : null}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {result.submitted_at ? new Date(result.submitted_at).toLocaleDateString() : ''}
                    </span>
                  </li>
                ))}
            </ul>
            <div className="border-t border-border px-6 py-3">
              <Button variant="secondary" size="sm" onClick={() => navigate(paths.studentResults)}>
                See all my results
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function bySubmittedAtDesc(a: AssessmentResult, b: AssessmentResult): number {
  return (b.submitted_at ?? '').localeCompare(a.submitted_at ?? '');
}

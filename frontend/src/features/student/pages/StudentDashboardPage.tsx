import {
  BookOpenCheck,
  ChartColumn,
  CheckCircle2,
  Compass,
  Sparkles,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { BarList } from '@/components/charts/BarList';
import { chartColors } from '@/components/charts/colors';
import { ColumnChart } from '@/components/charts/ColumnChart';
import { DonutChart } from '@/components/charts/DonutChart';
import { Meter } from '@/components/charts/Meter';
import { StatCard } from '@/components/dashboard/StatCard';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAssignments, useProfile, useResults } from '@/features/student/hooks/useAssessment';
import { useStudentDashboard } from '@/features/student/hooks/useDashboard';
import { useMyRecommendations } from '@/features/student/hooks/useRecommendations';
import { paths } from '@/routes/paths';
import { useAuthStore } from '@/stores/authStore';
import { useStudentClassStore } from '@/stores/studentClassStore';
import type { AssessmentResult } from '@/types/assessment';

/**
 * The student's landing page (FULLPLAN §37) — analytics pass over the idea1 reference:
 * a KPI row, then chart cards (progress donut, RIASEC profile, recommendation
 * confidence) around the one question the page still answers first: *what should I do
 * next?* Every chart renders real data when it exists and says plainly what is missing
 * when it does not — never a zero pretending to be a measurement.
 */
export function StudentDashboardPage() {
  const user = useAuthStore((state) => state.user);
  const classRoom = useStudentClassStore((state) => state.classRoom);

  const { data: assignments, isError: assignmentsFailed, error: assignmentsError } = useAssignments();
  const { data: results } = useResults();
  const { data: profile } = useProfile();
  // Phase 6: the aggregate view — used for the one fact the other queries cannot answer,
  // "do I have recommendations waiting?" (§27 needs both RIASEC and SCCT before any exist).
  const { data: dashboard } = useStudentDashboard();
  const { data: recommendations } = useMyRecommendations();
  const navigate = useNavigate();

  const all = assignments ?? [];
  const scored = all.filter((a) => a.my_attempt?.status === 'SCORED');
  const inProgress = all.filter((a) => a.my_attempt?.status === 'IN_PROGRESS');
  const notStarted = all.filter((a) => !a.my_attempt || a.my_attempt.status === 'EXPIRED');
  const todo = all.filter((a) => a.my_attempt?.status !== 'SCORED');
  const done = results ?? [];

  const completionPercent = all.length > 0 ? (scored.length / all.length) * 100 : null;
  const riasec = latestRiasecResult(done);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Welcome, {user?.name ?? 'student'}</h1>
        {classRoom ? (
          <p className="text-sm text-muted-foreground">
            {classRoom.name} · {classRoom.academic_year}
            {classRoom.grade_level ? ` · ${classRoom.grade_level}` : null}
          </p>
        ) : null}
      </div>

      {/* §27 consumes strand and GWA. Naming the consequence beats "complete your profile". */}
      {profile && !profile.is_complete_for_recommendations ? (
        <Alert tone="warning">
          We need your strand and general weighted average before we can recommend a program.{' '}
          <button className="font-medium underline" onClick={() => navigate(paths.studentProfile)}>
            Complete your profile
          </button>
        </Alert>
      ) : null}

      {/* KPI row — real counts, no teasers. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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

          <Card>
            <CardHeader>
              <CardTitle>Your RIASEC profile</CardTitle>
              <CardDescription>
                {riasec
                  ? riasec.result?.result_code
                    ? `Holland code ${riasec.result.result_code} — how strongly each interest area showed up.`
                    : 'How strongly each interest area showed up.'
                  : 'Take the RIASEC assessment to see your interest profile here.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {riasec ? (
                <BarList
                  max={100}
                  items={riasec.dimensions.map((dimension) => ({
                    label: dimension.name,
                    value: Number.parseFloat(dimension.normalized_score),
                    display: Number.parseFloat(dimension.normalized_score).toFixed(0),
                  }))}
                />
              ) : (
                <ChartPlaceholder />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Match confidence</CardTitle>
              <CardDescription>
                {recommendations
                  ? 'How your career and program match scores are distributed.'
                  : 'Your match-score spread appears once recommendations exist.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {recommendations ? (
                <ColumnChart items={confidenceBuckets(recommendations)} />
              ) : (
                <ChartPlaceholder />
              )}
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

/** The newest RIASEC result that actually carries dimension scores. */
function latestRiasecResult(results: AssessmentResult[]): AssessmentResult | null {
  return (
    [...results]
      .filter((r) => r.assessment?.category === 'RIASEC' && r.dimensions.length > 0)
      .sort(bySubmittedAtDesc)[0] ?? null
  );
}

function bySubmittedAtDesc(a: AssessmentResult, b: AssessmentResult): number {
  return (b.submitted_at ?? '').localeCompare(a.submitted_at ?? '');
}

/**
 * Match scores bucketed for the distribution chart. Careers and programs are pooled:
 * the question the widget answers is "how confident are my matches overall", not a
 * cross-type ranking (§27 forbids comparing a career's score with a program's).
 */
function confidenceBuckets(set: {
  careers: { match_score: number }[];
  programs: { match_score: number }[];
}): { label: string; value: number }[] {
  const scores = [...set.careers, ...set.programs].map((r) => r.match_score);
  const buckets = [
    { label: '<50', min: 0, max: 50 },
    { label: '50–64', min: 50, max: 65 },
    { label: '65–79', min: 65, max: 80 },
    { label: '80+', min: 80, max: 101 },
  ];

  return buckets.map((bucket) => ({
    label: bucket.label,
    value: scores.filter((score) => score >= bucket.min && score < bucket.max).length,
  }));
}

/** The graceful no-data state: an honest sentence-sized gap, not fake bars. */
function ChartPlaceholder() {
  return (
    <div className="flex h-24 items-center justify-center rounded-none border border-dashed border-border text-sm text-muted-foreground">
      No data yet
    </div>
  );
}

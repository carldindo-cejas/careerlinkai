import { useNavigate } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  useAssignments,
  useProfile,
  useStartAttempt,
} from '@/features/student/hooks/useAssessment';
import { paths, playerPath, resultPath } from '@/routes/paths';
import type { AssessmentAssignment } from '@/types/assessment';

/**
 * "My assessments" (FULLPLAN §37: *"Assigned assessments list — RIASEC, SCCT, and any
 * counselor-assigned custom assessments together"*).
 *
 * One list, not three. A student does not think in instrument categories; they think "what do I
 * have to do".
 */
export function AssessmentListPage() {
  const { data: assignments, isLoading } = useAssignments();
  const { data: profile } = useProfile();
  const start = useStartAttempt();
  const navigate = useNavigate();

  if (isLoading) return <p className="text-sm text-slate-500">Loading your assessments…</p>;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">My assessments</h1>
        <p className="text-sm text-slate-500">
          Answer honestly — there are no right or wrong answers, and nobody is grading you.
        </p>
      </div>

      {/*
        The profile nudge, and why it says *why*.

        §27 cannot recommend a program without knowing the student's strand and GWA — those are
        inputs to the engine, not decoration. "Complete your profile" is a chore a student will
        ignore; naming the consequence is the difference between a nag and a reason.
      */}
      {profile && !profile.is_complete_for_recommendations ? (
        <Alert tone="warning">
          Your results will be ready as soon as you finish an assessment — but we cannot recommend a{' '}
          <em>program</em> until we know your{' '}
          {profile.missing_for_recommendations.includes('strand') ? 'strand' : null}
          {profile.missing_for_recommendations.length === 2 ? ' and ' : null}
          {profile.missing_for_recommendations.includes('gwa') ? 'general weighted average' : null}.{' '}
          <button className="font-medium underline" onClick={() => navigate(paths.studentProfile)}>
            Complete your profile
          </button>
        </Alert>
      ) : null}

      {(assignments ?? []).length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Nothing to do yet</CardTitle>
            <CardDescription>
              Your counselor will assign you an assessment. It will show up here.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <div className="flex flex-col gap-4">
        {(assignments ?? []).map((assignment) => (
          <AssignmentCard
            key={assignment.id}
            assignment={assignment}
            starting={start.isPending}
            onStart={() =>
              start.mutate(assignment.id, {
                onSuccess: (attempt) => navigate(playerPath(attempt.id)),
              })
            }
            onResume={(attemptId) => navigate(playerPath(attemptId))}
            onSeeResult={(attemptId) => navigate(resultPath(attemptId))}
          />
        ))}
      </div>
    </div>
  );
}

function AssignmentCard({
  assignment,
  starting,
  onStart,
  onResume,
  onSeeResult,
}: {
  assignment: AssessmentAssignment;
  starting: boolean;
  onStart: () => void;
  onResume: (attemptId: string) => void;
  onSeeResult: (attemptId: string) => void;
}) {
  const attempt = assignment.my_attempt;
  const done = attempt?.status === 'SCORED';
  const inProgress = attempt?.status === 'IN_PROGRESS';

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            {assignment.assessment.title}
            {done ? <Badge tone="success">Done</Badge> : null}
            {inProgress ? <Badge tone="warning">In progress</Badge> : null}
          </CardTitle>
          <CardDescription>{assignment.assessment.description}</CardDescription>
        </div>
      </CardHeader>

      <CardContent className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm text-slate-500">
          {assignment.assessment.question_count} questions
          {assignment.assessment.duration_minutes
            ? ` · about ${assignment.assessment.duration_minutes} minutes`
            : null}
          {assignment.deadline
            ? ` · due ${new Date(assignment.deadline).toLocaleDateString()}`
            : null}
        </p>

        {done && attempt ? (
          <Button variant="secondary" onClick={() => onSeeResult(attempt.id)}>
            See my result
          </Button>
        ) : inProgress && attempt ? (
          <Button onClick={() => onResume(attempt.id)}>Continue</Button>
        ) : (
          <Button onClick={onStart} disabled={starting}>
            {starting ? 'Starting…' : 'Start'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

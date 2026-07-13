import { useNavigate } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAssignments, useProfile, useResults } from '@/features/student/hooks/useAssessment';
import { paths } from '@/routes/paths';
import { useAuthStore } from '@/stores/authStore';
import { useStudentClassStore } from '@/stores/studentClassStore';

/**
 * The student's landing page (FULLPLAN §37).
 *
 * It answers one question — *what should I do next?* — and then gets out of the way. A dashboard
 * that presents a student with five equal-weight cards has not decided anything on their behalf,
 * which is the one thing a landing page is for.
 */
export function StudentDashboardPage() {
  const user = useAuthStore((state) => state.user);
  const classRoom = useStudentClassStore((state) => state.classRoom);

  const { data: assignments } = useAssignments();
  const { data: results } = useResults();
  const { data: profile } = useProfile();
  const navigate = useNavigate();

  const todo = (assignments ?? []).filter((a) => a.my_attempt?.status !== 'SCORED');
  const done = results ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Welcome, {user?.name ?? 'student'}</h1>
        {classRoom ? (
          <p className="text-sm text-slate-500">
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

      <Card>
        <CardHeader>
          <CardTitle>{todo.length > 0 ? 'You have work to do' : 'Nothing to do yet'}</CardTitle>
          <CardDescription>
            {todo.length > 0
              ? `${todo.length} ${todo.length === 1 ? 'assessment is' : 'assessments are'} waiting for you.`
              : 'Your counselor will assign you an assessment. It will show up here.'}
          </CardDescription>
        </CardHeader>

        {todo.length > 0 ? (
          <CardContent>
            <Button onClick={() => navigate(paths.studentAssessments)}>
              {todo.some((a) => a.my_attempt?.status === 'IN_PROGRESS')
                ? 'Continue where I left off'
                : 'Start'}
            </Button>
          </CardContent>
        ) : null}
      </Card>

      {done.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Your results</CardTitle>
            <CardDescription>
              {done.length} {done.length === 1 ? 'assessment' : 'assessments'} completed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="secondary" onClick={() => navigate(paths.studentResults)}>
              See my results
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

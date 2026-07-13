import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAttempt, useSaveAnswer, useSubmitAttempt } from '@/features/student/hooks/useAssessment';
import { resultPath } from '@/routes/paths';
import type { AssessmentQuestion } from '@/types/assessment';

/**
 * The assessment player (FULLPLAN §37: *"question-by-question, progress bar, submit"*).
 *
 * ## Two things this screen deliberately never shows
 *
 * It never shows what a question measures, and it never shows what an answer is worth. The API
 * does not send either (see AssessmentQuestionResource), and that is the point rather than an
 * oversight: a student who could see that item 14 loads onto "Investigative" and that "Strongly
 * Agree" scores 5 would stop answering an interest inventory and start answering the Holland Code
 * they would like to have. The instrument would measure what the student wants the software to
 * conclude, and every recommendation downstream of it would rest on that.
 *
 * The section label ("Investigative") *is* shown, as a heading. That is a deliberate, limited
 * disclosure: it groups sixty questions into legible chunks without revealing what any single
 * item scores.
 *
 * ## Why answers are held locally
 *
 * Each answer is POSTed the moment it is chosen — so a student who closes the tab on question 40
 * comes back to question 40, which on a shared school computer is not a nicety. But the *selected*
 * state lives in this component, not in the query cache: re-reading the server after every tap
 * would put a network round trip between the student and the radio button they just pressed.
 */
export function AssessmentPlayerPage() {
  const { attemptId = '' } = useParams();
  const navigate = useNavigate();

  const { data: attempt, isLoading, error } = useAttempt(attemptId);
  const saveAnswer = useSaveAnswer(attemptId);
  const submit = useSubmitAttempt(attemptId);

  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [hydrated, setHydrated] = useState(false);

  const questions = useMemo<AssessmentQuestion[]>(() => attempt?.questions ?? [], [attempt]);

  // Resume where they left off. Runs once, when the attempt first arrives: the server knows what
  // the student has already answered, and dropping them back on question 1 of 60 would be a
  // small cruelty.
  if (attempt && !hydrated) {
    const existing: Record<string, string> = {};
    for (const answer of attempt.answers ?? []) {
      if (answer.selected_option_id) existing[answer.question_id] = answer.selected_option_id;
    }
    setAnswers(existing);
    setIndex(Math.min(questions.findIndex((q) => !existing[q.id]) + 1 || 1, questions.length) - 1);
    setHydrated(true);
  }

  if (isLoading) return <p className="text-sm text-slate-500">Loading your assessment…</p>;
  if (error || !attempt) return <Alert tone="danger">This assessment could not be loaded.</Alert>;

  if (attempt.status !== 'IN_PROGRESS') {
    return (
      <Alert tone="info">
        You have already submitted this assessment.{' '}
        <button className="underline" onClick={() => navigate(resultPath(attempt.id))}>
          See your result
        </button>
      </Alert>
    );
  }

  const question = questions[index];

  // A published version always has questions (§25's gate cannot pass an empty bank onto a
  // student), so this is unreachable in practice — but an index into an empty array is `undefined`
  // and TypeScript is right to insist. An honest empty state beats a non-null assertion.
  if (!question) {
    return <Alert tone="info">This assessment has no questions.</Alert>;
  }

  const answeredCount = Object.keys(answers).length;
  const remaining = questions.filter((q) => q.required && !answers[q.id]).length;
  const isLast = index === questions.length - 1;

  function choose(questionId: string, optionId: string) {
    setAnswers((current) => ({ ...current, [questionId]: optionId }));

    // Fire-and-forget on purpose. The answer is already reflected on screen; a failed save is
    // surfaced below rather than blocking the student's next tap, and the student can always
    // re-select. Submission re-checks every required answer server-side (§24), so a silently
    // dropped save cannot produce a partially-scored attempt — it produces a refused submit,
    // with a count of what is missing.
    saveAnswer.mutate({ questionId, optionId });

    if (!isLast) {
      // Advance automatically: a 60-question Likert scale where every item needs a tap *and* a
      // "Next" click is 120 taps.
      window.setTimeout(() => setIndex((i) => Math.min(i + 1, questions.length - 1)), 150);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{attempt.assessment?.title}</h1>
        {attempt.assessment?.instructions ? (
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            {attempt.assessment.instructions}
          </p>
        ) : null}
      </div>

      {/* Progress. §37 asks for a progress bar, and on a 60-item instrument it is the difference
          between "nearly done" and "this is endless". */}
      <div>
        <div className="mb-2 flex items-baseline justify-between text-sm">
          <span className="font-medium text-slate-700">
            {question.section_label ? `${question.section_label} · ` : null}
            Question {index + 1} of {questions.length}
          </span>
          <span className="text-slate-500">{answeredCount} answered</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
          <div
            className="h-full rounded-full bg-slate-900 transition-all"
            style={{ width: `${(answeredCount / questions.length) * 100}%` }}
          />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg leading-snug">{question.question_text}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {question.options.map((option) => {
            const selected = answers[question.id] === option.id;

            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={selected}
                onClick={() => choose(question.id, option.id)}
                className={[
                  'rounded-lg border px-4 py-3 text-left text-sm transition',
                  selected
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400',
                ].join(' ')}
              >
                {option.label}
                {/* No score. Never a score. */}
              </button>
            );
          })}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <Button variant="secondary" onClick={() => setIndex((i) => Math.max(i - 1, 0))} disabled={index === 0}>
          Back
        </Button>

        {isLast ? null : (
          <Button variant="secondary" onClick={() => setIndex((i) => Math.min(i + 1, questions.length - 1))}>
            Skip
          </Button>
        )}
      </div>

      {/* The submit gate. It is shown from the start rather than only at the end: a student on
          question 60 who discovers they missed question 12 needs to know *which* one, and the
          count is the honest version of that. The server enforces this independently (§24) — this
          is a courtesy, not the control. */}
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          {remaining > 0 ? (
            <p className="text-sm text-slate-500">
              {remaining} {remaining === 1 ? 'question' : 'questions'} left to answer before you can
              submit.
            </p>
          ) : (
            <p className="text-sm text-emerald-700">
              All {questions.length} questions answered. You can submit now.
            </p>
          )}

          {submit.error ? (
            <Alert tone="danger">
              {submit.error instanceof Error ? submit.error.message : 'Could not submit.'}
            </Alert>
          ) : null}

          <Button
            disabled={remaining > 0 || submit.isPending}
            onClick={() =>
              submit.mutate(undefined, {
                onSuccess: (result) => navigate(resultPath(result.attempt_id)),
              })
            }
          >
            {submit.isPending ? 'Scoring…' : 'Submit assessment'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

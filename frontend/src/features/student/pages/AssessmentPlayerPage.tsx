import { useCallback, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAttempt, useSaveAnswer, useSubmitAttempt } from '@/features/student/hooks/useAssessment';
import { paths, resultPath, type ResultPageState } from '@/routes/paths';
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
 *
 * ## Advancing is a transaction, not a state update
 *
 * This screen previously auto-advanced on a 150 ms `setTimeout` and offered a **Skip** button that
 * moved on unconditionally. Both were ways to leave a required question unanswered, and the timer
 * made it a race: two taps inside one timeout window queued two advances, so a student could land
 * two questions further on than they had answered — and then be refused at submit, with no clue
 * which item they had missed.
 *
 * The fix has three parts, and all three are needed:
 *
 *   1. **Saves are serialized** through one promise chain (`saveChain`). Answers to the same
 *      question can be changed as fast as a student can tap; the *last* one is still the one the
 *      server ends up holding, because the next POST does not start until the previous one has
 *      settled. Two unordered in-flight upserts could otherwise land in either order.
 *   2. **Advancing awaits that chain**, so the answer is durable before the question leaves the
 *      screen — which is what makes resume-where-you-left-off honest.
 *   3. **A synchronous ref latches the advance.** `disabled` on the button is not sufficient on
 *      its own: React state is applied asynchronously, so a double-click delivered inside one
 *      frame passes a state-based guard twice before the first render disables anything. The ref
 *      flips in the same tick as the click.
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

  /** Which question is mid-save, for the button's disabled/loading state. Null when idle. */
  const [savingQuestionId, setSavingQuestionId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Set when Finish is pressed with required questions still open — names what is missing. */
  const [gateMessage, setGateMessage] = useState<string | null>(null);

  /**
   * The serialization primitive. Every save is appended to this chain rather than fired
   * independently, so N rapid taps on one question produce N ordered POSTs whose last write is
   * the student's last choice. `advance` awaits it before moving on.
   *
   * **It never rejects.** A rejecting chain would be an unhandled rejection every time a save
   * failed while the student sat still, since nothing is awaiting it between clicks. Failure is
   * reported out of band through `saveFailed` instead, which `advance` reads after the await.
   *
   * A ref rather than state on purpose: it is read and written inside event handlers that must
   * see the current value immediately, and nothing about it should trigger a render.
   */
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  /** Did the most recent save fail? Read by `advance` once the chain has drained. */
  const saveFailed = useRef(false);
  /** The synchronous half of the double-click guard. See the class doc, point 3. */
  const advancing = useRef(false);

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

  /**
   * Record a choice and queue its save.
   *
   * The selection lands in local state synchronously — the student sees the option fill
   * immediately, which is the whole reason the answer state is local. The POST is appended to
   * the chain; the *button*, not this handler, is what waits for it.
   */
  const choose = useCallback(
    (questionId: string, optionId: string) => {
      setAnswers((current) => ({ ...current, [questionId]: optionId }));
      setSaveError(null);
      setGateMessage(null);
      setSavingQuestionId(questionId);
      saveFailed.current = false;

      saveChain.current = saveChain.current.then(async () => {
        try {
          await saveAnswer.mutateAsync({ questionId, optionId });
          saveFailed.current = false;
        } catch (cause) {
          // Recorded, not rethrown. An answer that did not reach the server is not an answered
          // question, and `advance` refuses on this flag — but the chain itself stays resolved
          // so a later save is not poisoned by an earlier failure.
          saveFailed.current = true;
          setSaveError(
            cause instanceof Error
              ? cause.message
              : 'That answer could not be saved. Select it again.',
          );
        } finally {
          setSavingQuestionId(null);
        }
      });
    },
    [saveAnswer],
  );

  /**
   * Move to `target`, but only once the pending save has actually landed.
   *
   * Returns false when it refused — which the caller uses to decide whether to submit.
   */
  const advance = useCallback(async (target: number): Promise<boolean> => {
    if (advancing.current) return false;
    advancing.current = true;

    try {
      await saveChain.current;

      if (saveFailed.current) {
        // `choose` has already surfaced the reason; refusing to advance is the rest of the
        // response. The student stays on the question whose answer did not save.
        return false;
      }

      setIndex(target);

      return true;
    } finally {
      advancing.current = false;
    }
  }, []);

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading your assessment…</p>;
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
  const firstUnansweredIndex = questions.findIndex((q) => q.required && !answers[q.id]);
  const remaining = questions.filter((q) => q.required && !answers[q.id]).length;
  const isLast = index === questions.length - 1;

  const isSaving = savingQuestionId !== null;
  /**
   * The validation the brief asks for, stated once and used by both the button's `disabled` and
   * the handlers' own guard. An **optional** question may be passed unanswered — `required` is a
   * per-question property (§13.4), not an assessment-wide one, and treating every question as
   * required would refuse to let a student past an item the author marked skippable.
   */
  const answeredCurrent = Boolean(answers[question.id]);
  const canLeaveQuestion = !question.required || answeredCurrent;

  async function onNext() {
    if (!canLeaveQuestion || isSaving) return;

    await advance(Math.min(index + 1, questions.length - 1));
  }

  async function onBack() {
    // Back is not gated on an answer — going back to *check* something must always work — but it
    // still waits for the in-flight save, so the answer state cannot be left mid-flight.
    if (index === 0) return;

    await advance(Math.max(index - 1, 0));
  }

  async function onFinish() {
    if (!canLeaveQuestion || isSaving || submit.isPending) return;

    // Wait for the last answer to land before asking the server to score it. Without this the
    // submit can outrun the final POST and the server refuses with "1 required question is
    // unanswered" for a question the student can see they answered.
    const settled = await advance(index);

    if (!settled) return;

    // The client-side half of the §24 gate. The server enforces it independently; this exists so
    // a student is *shown which question* is missing rather than handed a count they cannot act on.
    if (firstUnansweredIndex !== -1) {
      setGateMessage(
        `Question ${firstUnansweredIndex + 1} still needs an answer before you can finish.`,
      );
      setIndex(firstUnansweredIndex);

      return;
    }

    submit.mutate(undefined, {
      onSuccess: (result) => {
        // `replace` on purpose: the attempt is submitted and the player refuses to reopen it, so
        // leaving it on the history stack means Back lands on a dead screen. Replacing puts the
        // results page where the player was, and Back goes to wherever the student came *from*.
        navigate(resultPath(result.attempt_id), {
          replace: true,
          state: {
            from: paths.studentAssessments,
            fromLabel: 'My assessments',
          } satisfies ResultPageState,
        });
      },
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{attempt.assessment?.title}</h1>
        {attempt.assessment?.instructions ? (
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {attempt.assessment.instructions}
          </p>
        ) : null}
      </div>

      {/* Progress. §37 asks for a progress bar, and on a 60-item instrument it is the difference
          between "nearly done" and "this is endless". */}
      <div>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
          <span className="font-medium text-foreground/80">
            {question.section_label ? `${question.section_label} · ` : null}
            Question {index + 1} of {questions.length}
          </span>
          <span className="text-muted-foreground">{answeredCount} answered</span>
        </div>
        <div className="h-2 w-full overflow-hidden border border-border bg-secondary">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${(answeredCount / questions.length) * 100}%` }}
          />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg leading-snug">
            {question.question_text}
            {question.required ? null : (
              <span className="ml-2 text-sm font-normal text-muted-foreground">(optional)</span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {/*
            One option list for all three question types (§13.4: LIKERT, MULTIPLE_CHOICE,
            BOOLEAN). That is not a simplification — all three are single-select over
            `question_options` on the wire, so the player has one control and the validation
            below applies identically to every one of them. A type that ever needs free text
            would need a branch here *and* a second field in `saveAnswer`; neither exists.
          */}
          {question.options.map((option) => {
            const selected = answers[question.id] === option.id;

            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={selected}
                // Selecting is never blocked by an in-flight save: the new choice is queued
                // behind it and wins, which is what a student changing their mind expects.
                onClick={() => choose(question.id, option.id)}
                className={[
                  'rounded-none border px-4 py-3 text-left text-sm transition',
                  // Selected is the one filled object on the screen — the same steel block the
                  // primary button uses. Unselected is a hairline outline on the ground.
                  selected
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-transparent text-foreground/80 hover:border-primary',
                ].join(' ')}
              >
                {option.label}
                {/* No score. Never a score. */}
              </button>
            );
          })}
        </CardContent>
      </Card>

      {saveError ? (
        <Alert tone="danger">
          {saveError} Your answer was not saved, so this question is still open — select it again.
        </Alert>
      ) : null}

      {gateMessage ? <Alert tone="info">{gateMessage}</Alert> : null}

      {submit.error ? (
        <Alert tone="danger">
          {submit.error instanceof Error ? submit.error.message : 'Could not submit.'}
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="secondary" onClick={() => void onBack()} disabled={index === 0 || isSaving}>
          Back
        </Button>

        <div className="flex items-center gap-3">
          {/*
            The count of what is left, kept from the previous design because it is the honest
            answer to "why can't I finish?". It is no longer attached to a second submit button:
            one screen, one way to finish.
          */}
          <span className="text-sm text-muted-foreground">
            {remaining > 0
              ? `${remaining} ${remaining === 1 ? 'question' : 'questions'} left`
              : 'All questions answered'}
          </span>

          {isLast ? (
            <Button
              onClick={() => void onFinish()}
              disabled={!canLeaveQuestion || isSaving || submit.isPending}
              loading={isSaving || submit.isPending}
            >
              {submit.isPending ? 'Scoring…' : 'Finish assessment'}
            </Button>
          ) : (
            <Button
              onClick={() => void onNext()}
              disabled={!canLeaveQuestion || isSaving}
              loading={isSaving}
            >
              Next
            </Button>
          )}
        </div>
      </div>

      {/*
        The one remaining hint, and only when it can be acted on: a student on question 60 who
        discovers they missed question 12 needs to know *which* one. It is a jump, not a second
        submit path.
      */}
      {isLast && firstUnansweredIndex !== -1 ? (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
            <p className="text-sm text-muted-foreground">
              You still have {remaining} unanswered {remaining === 1 ? 'question' : 'questions'}.
            </p>
            <Button variant="secondary" onClick={() => void advance(firstUnansweredIndex)}>
              Go to question {firstUnansweredIndex + 1}
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

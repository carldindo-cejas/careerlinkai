import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { AssessmentPlayerPage } from '@/features/student/pages/AssessmentPlayerPage';
import { studentAssessmentApi } from '@/services/assessmentApi';
import type { AssessmentAttempt, AssessmentQuestion } from '@/types/assessment';

vi.mock('@/services/assessmentApi');

const ATTEMPT_ID = '44444444-4444-4444-8444-444444444444';

function question(n: number, section: string): AssessmentQuestion {
  return {
    id: `q${n}`,
    question_text: `Question number ${n}?`,
    question_type: 'LIKERT',
    section_label: section,
    order_number: n,
    required: true,
    options: [
      { id: `q${n}-o1`, label: 'Strongly Disagree', value: '1', order_number: 1 },
      { id: `q${n}-o5`, label: 'Strongly Agree', value: '5', order_number: 5 },
    ],
  };
}

function attempt(overrides: Partial<AssessmentAttempt> = {}): AssessmentAttempt {
  return {
    id: ATTEMPT_ID,
    assignment_id: 'assignment-1',
    status: 'IN_PROGRESS',
    started_at: '2026-07-13T09:00:00+00:00',
    submitted_at: null,
    assessment: {
      version_id: 'version-1',
      title: 'RIASEC Interest Inventory',
      category: 'RIASEC',
      instructions: 'Answer honestly.',
      duration_minutes: 20,
    },
    questions: [question(1, 'Realistic'), question(2, 'Realistic')],
    answers: [],
    ...overrides,
  };
}

function renderPlayer() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[`/student/attempts/${ATTEMPT_ID}`]}>
        <Routes>
          <Route path="/student/attempts/:attemptId" element={<AssessmentPlayerPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AssessmentPlayerPage', () => {
  beforeEach(() => {
    vi.mocked(studentAssessmentApi.getAttempt).mockResolvedValue(attempt());
    vi.mocked(studentAssessmentApi.saveAnswer).mockResolvedValue(undefined);
    vi.mocked(studentAssessmentApi.submit).mockResolvedValue({
      attempt_id: ATTEMPT_ID,
      submitted_at: '2026-07-13T09:20:00+00:00',
      result: { result_code: 'RIA', overall_summary: null, generated_at: null },
      dimensions: [],
    });
  });

  /**
   * **The integrity invariant of the whole player**, and the reason this test exists at all.
   *
   * The server never sends a question's dimension or an option's score
   * (AssessmentQuestionResource). This test asserts the UI does not reintroduce either — because
   * the tempting "improvement" is real: showing "Investigative · 5 points" next to an answer looks
   * like helpful transparency, and it would quietly destroy the instrument. A student who can see
   * the scoring key stops answering an interest inventory and starts answering the Holland Code
   * they would like to have.
   *
   * If this test ever fails, the fix is never to change the test.
   */
  it('never reveals what a question measures or what an answer is worth', async () => {
    renderPlayer();

    await screen.findByText('Question number 1?');

    // The option is offered by its label alone. No score, no point value, anywhere on the page.
    expect(screen.getByRole('button', { name: 'Strongly Agree' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\b5 points?\b/i);
    expect(document.body.textContent).not.toMatch(/Investigative|dimension|weight/i);
  });

  /**
   * Each answer is POSTed as it is chosen — a student who closes the tab on question 40 comes back
   * to question 40, which on a shared school computer is not a nicety. Advancing is now an
   * explicit act, so the save and the move are two separate events.
   */
  it('saves each answer as it is chosen, and advances only when Next is pressed', async () => {
    const user = userEvent.setup();
    renderPlayer();

    await screen.findByText('Question number 1?');
    await user.click(screen.getByRole('button', { name: 'Strongly Agree' }));

    await waitFor(() =>
      expect(studentAssessmentApi.saveAnswer).toHaveBeenCalledWith(ATTEMPT_ID, 'q1', 'q1-o5'),
    );

    // No auto-advance: the student is still looking at the question they just answered.
    expect(screen.getByText('Question number 1?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Question number 2?');
  });

  /**
   * **The bug this screen was rewritten for.**
   *
   * Next is refused while the current *required* question is unanswered — no timer, no Skip, no
   * way past it. Previously a "Skip" button moved on unconditionally and an auto-advance timer
   * could fire twice inside one window, landing a student two questions ahead of what they had
   * answered and leaving them refused at submit with no idea which item was missing.
   */
  it('refuses to advance past an unanswered required question', async () => {
    const user = userEvent.setup();
    renderPlayer();

    await screen.findByText('Question number 1?');

    const next = screen.getByRole('button', { name: 'Next' });
    expect(next).toBeDisabled();

    // Not merely styled as disabled — clicking it does nothing at all.
    await user.click(next);
    expect(screen.getByText('Question number 1?')).toBeInTheDocument();

    // There is no escape hatch beside it either.
    expect(screen.queryByRole('button', { name: /skip/i })).not.toBeInTheDocument();
  });

  /**
   * Rapid taps cannot outrun the guard. Five clicks on Next advance exactly one question — the
   * synchronous `advancing` ref is what makes this true, because `disabled` alone is applied on
   * the next render and a burst delivered inside one frame passes a state-based check repeatedly.
   */
  it('advances exactly one question however fast Next is clicked', async () => {
    // Five questions, the first already answered — so the player opens on question 2 and there
    // is room ahead for an over-advance to actually show up. On a two-question attempt the
    // index clamp would hide the bug rather than the guard preventing it.
    vi.mocked(studentAssessmentApi.getAttempt).mockResolvedValue(
      attempt({
        questions: [1, 2, 3, 4, 5].map((n) => question(n, 'Realistic')),
        answers: [{ question_id: 'q1', selected_option_id: 'q1-o5', answer_text: null }],
      }),
    );

    const user = userEvent.setup();
    renderPlayer();

    await screen.findByText('Question number 2?');
    await user.click(screen.getByRole('button', { name: 'Strongly Agree' }));

    const next = await screen.findByRole('button', { name: 'Next' });
    await waitFor(() => expect(next).toBeEnabled());

    await Promise.all([
      user.click(next),
      user.click(next),
      user.click(next),
      user.click(next),
      user.click(next),
    ]);

    await screen.findByText('Question number 3?');

    // The whole point: question 3 is unanswered, so nothing may have carried the student past it.
    expect(screen.queryByText('Question number 4?')).not.toBeInTheDocument();
    expect(screen.queryByText('Question number 5?')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  /**
   * An answer that has not reached the server is not an answered question. Next waits for the
   * in-flight save and refuses to move on if it fails, rather than advancing over a lost answer.
   */
  it('does not advance when the answer fails to save', async () => {
    const user = userEvent.setup();
    vi.mocked(studentAssessmentApi.saveAnswer).mockRejectedValue(new Error('Network is down.'));

    renderPlayer();

    await screen.findByText('Question number 1?');
    await user.click(screen.getByRole('button', { name: 'Strongly Agree' }));

    await screen.findByText(/Network is down\./);

    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.getByText('Question number 1?')).toBeInTheDocument();
  });

  /**
   * Submission is blocked until every required question is answered, and the screen says *how
   * many* are left rather than simply refusing. The server enforces this independently (§24) —
   * this is the courtesy, not the control.
   */
  it('blocks finishing until every required question is answered, and says how many remain', async () => {
    const user = userEvent.setup();
    renderPlayer();

    await screen.findByText('Question number 1?');
    expect(screen.getByText('2 questions left')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Strongly Agree' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await screen.findByText('Question number 2?');

    expect(screen.getByText('1 question left')).toBeInTheDocument();
    // On the last question, Finish replaces Next — and is refused while this one is unanswered.
    expect(screen.getByRole('button', { name: 'Finish assessment' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Strongly Agree' }));

    await screen.findByText('All questions answered');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Finish assessment' })).toBeEnabled(),
    );
  });

  /**
   * Finishing submits and lands on the result — replacing the player in history rather than
   * stacking on it, so Back from the result does not return to an attempt that refuses to reopen.
   */
  it('submits from the final question and hands over to the result page', async () => {
    const user = userEvent.setup();
    vi.mocked(studentAssessmentApi.getAttempt).mockResolvedValue(
      attempt({
        answers: [{ question_id: 'q1', selected_option_id: 'q1-o5', answer_text: null }],
      }),
    );

    renderPlayer();

    await screen.findByText('Question number 2?');
    await user.click(screen.getByRole('button', { name: 'Strongly Agree' }));

    const finish = await screen.findByRole('button', { name: 'Finish assessment' });
    await waitFor(() => expect(finish).toBeEnabled());
    await user.click(finish);

    await waitFor(() => expect(studentAssessmentApi.submit).toHaveBeenCalledWith(ATTEMPT_ID));
  });

  /**
   * An **optional** question is passable. `required` is a per-question property (§13.4), so
   * treating every question as mandatory would refuse to let a student past an item the author
   * deliberately marked skippable.
   */
  it('allows an optional question to be passed unanswered', async () => {
    vi.mocked(studentAssessmentApi.getAttempt).mockResolvedValue(
      attempt({
        questions: [
          { ...question(1, 'Realistic'), required: false },
          question(2, 'Realistic'),
        ],
      }),
    );

    const user = userEvent.setup();
    renderPlayer();

    await screen.findByText('Question number 1?');

    const next = screen.getByRole('button', { name: 'Next' });
    expect(next).toBeEnabled();

    await user.click(next);
    await screen.findByText('Question number 2?');
  });

  /**
   * A student who left off part-way through is put back where they were, not at question 1 of 60.
   */
  it('resumes at the first unanswered question', async () => {
    vi.mocked(studentAssessmentApi.getAttempt).mockResolvedValue(
      attempt({
        answers: [{ question_id: 'q1', selected_option_id: 'q1-o5', answer_text: null }],
      }),
    );

    renderPlayer();

    await screen.findByText('Question number 2?');
    expect(screen.getByText('1 answered')).toBeInTheDocument();
  });

  /**
   * §13.5: answers are write-once after submission. The player must not offer to change one.
   */
  it('refuses to reopen a submitted attempt', async () => {
    vi.mocked(studentAssessmentApi.getAttempt).mockResolvedValue(attempt({ status: 'SCORED' }));

    renderPlayer();

    await screen.findByText(/already submitted this assessment/i);
    expect(screen.queryByRole('button', { name: 'Strongly Agree' })).not.toBeInTheDocument();
  });

  /**
   * All three §13.4 question types are single-select over `question_options` on the wire, so the
   * player has one control and one validation rule for all of them. This asserts that rather
   * than assuming it: a type that gained a free-text field would need a branch in the player and
   * a second field in `saveAnswer`, and this test is where that would first be noticed.
   */
  describe.each([
    { type: 'LIKERT' as const, label: 'Strongly Agree', optionId: 'q1-o5' },
    { type: 'MULTIPLE_CHOICE' as const, label: 'Designing a bridge', optionId: 'q1-mc' },
    { type: 'BOOLEAN' as const, label: 'Yes', optionId: 'q1-bool' },
  ])('$type questions', ({ type, label, optionId }) => {
    it('gate Next until answered, then save and advance', async () => {
      vi.mocked(studentAssessmentApi.getAttempt).mockResolvedValue(
        attempt({
          questions: [
            {
              ...question(1, 'Realistic'),
              question_type: type,
              options: [{ id: optionId, label, value: '1', order_number: 1 }],
            },
            question(2, 'Realistic'),
          ],
        }),
      );

      const user = userEvent.setup();
      renderPlayer();

      await screen.findByText('Question number 1?');
      expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

      await user.click(screen.getByRole('button', { name: label }));

      await waitFor(() =>
        expect(studentAssessmentApi.saveAnswer).toHaveBeenCalledWith(ATTEMPT_ID, 'q1', optionId),
      );

      const next = screen.getByRole('button', { name: 'Next' });
      await waitFor(() => expect(next).toBeEnabled());
      await user.click(next);

      await screen.findByText('Question number 2?');
    });
  });
});

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
   * to question 40, which on a shared school computer is not a nicety.
   */
  it('saves each answer as it is chosen and advances', async () => {
    const user = userEvent.setup();
    renderPlayer();

    await screen.findByText('Question number 1?');
    await user.click(screen.getByRole('button', { name: 'Strongly Agree' }));

    await waitFor(() =>
      expect(studentAssessmentApi.saveAnswer).toHaveBeenCalledWith(ATTEMPT_ID, 'q1', 'q1-o5'),
    );

    // ...and moves on, rather than making a 60-item scale cost 120 taps.
    await screen.findByText('Question number 2?');
  });

  /**
   * Submission is blocked until every required question is answered, and the button says *how
   * many* are left rather than simply refusing. The server enforces this independently (§24) —
   * this is the courtesy, not the control.
   */
  it('blocks submission until every required question is answered, and says how many remain', async () => {
    const user = userEvent.setup();
    renderPlayer();

    await screen.findByText('Question number 1?');

    expect(screen.getByText('2 questions left to answer before you can submit.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit assessment' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Strongly Agree' }));
    await screen.findByText('Question number 2?');

    expect(screen.getByText('1 question left to answer before you can submit.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit assessment' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Strongly Agree' }));

    await screen.findByText('All 2 questions answered. You can submit now.');
    expect(screen.getByRole('button', { name: 'Submit assessment' })).toBeEnabled();
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
});

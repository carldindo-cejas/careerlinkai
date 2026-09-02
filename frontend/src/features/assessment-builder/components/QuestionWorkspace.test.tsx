import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { QuestionWorkspace } from '@/features/assessment-builder/components/QuestionWorkspace';
import { builderApi } from '@/services/builderApi';
import type { AuthorQuestion, BuilderDimension, VersionReview } from '@/types/builder';

vi.mock('@/services/builderApi');

/**
 * The builder workspace (prompt-driven, v1.6).
 *
 * Three things are worth pinning here, and they are the three that would be silently wrong rather
 * than visibly broken:
 *
 *   * **Auto-save coalesces.** Typing must produce one request carrying the final text, not one per
 *     keystroke and not a stale one. The debounce is the mechanism; "one call, with the last value"
 *     is the property.
 *   * **A published version is read-only.** Invariant 1 (§12) freezes a published version forever.
 *     The server enforces it — `test/assessment/question-editing.test.ts` covers that — and the UI
 *     must not offer controls the server is going to refuse.
 *   * **Option scores are visible to the author and absent from the preview.** The player payload
 *     omits them on purpose (a student who can see "Agree = 5" stops answering honestly), and the
 *     preview's whole job is to show what the student will actually see.
 */

const DIMENSIONS: BuilderDimension[] = [
  { code: 'TM', name: 'Time Management', description: null },
  { code: 'FOCUS', name: 'Focus', description: null },
];

function question(overrides: Partial<AuthorQuestion> = {}): AuthorQuestion {
  return {
    id: 'qq000000-0000-4000-8000-000000000001',
    question_text: 'I review my notes within a day of each class.',
    question_type: 'LIKERT',
    section_label: null,
    order_number: 1,
    required: true,
    source: 'MANUAL',
    source_ai_request_id: null,
    options: [
      { id: 'op1', label: 'Disagree', value: '1', score: 1, order_number: 1 },
      { id: 'op2', label: 'Agree', value: '2', score: 2, order_number: 2 },
    ],
    dimensions: [
      {
        mapping_id: 'mp1',
        code: 'TM',
        name: 'Time Management',
        weight: 1,
        confirmed: true,
        confirmed_at: '2026-07-01T00:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

function review(overrides: Partial<VersionReview> = {}): VersionReview {
  return {
    id: 'vv000000-0000-4000-8000-000000000001',
    version_number: 1,
    status: 'DRAFT',
    instructions: null,
    duration_minutes: null,
    scoring_algorithm: 'WEIGHTED_COMPOSITE',
    created_at: '2026-07-01T00:00:00.000Z',
    published_at: null,
    template: { id: 'tt1', title: 'Study Habits', category: 'CUSTOM' },
    publish_readiness: { total: 1, confirmed: 1, remaining: 0 },
    questions: [question()],
    ...overrides,
  };
}

function renderWorkspace(
  props: Partial<React.ComponentProps<typeof QuestionWorkspace>> = {},
) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <QuestionWorkspace
        review={review()}
        dimensions={DIMENSIONS}
        editable
        {...props}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(builderApi).updateQuestion = vi.fn().mockImplementation(async (_id, patch) => ({
    ...question(),
    ...patch,
  }));
  vi.mocked(builderApi).duplicateQuestion = vi
    .fn()
    .mockResolvedValue(question({ id: 'qq2', order_number: 2 }));
  vi.mocked(builderApi).deleteQuestion = vi.fn().mockResolvedValue({ id: 'qq1' });
  vi.mocked(builderApi).addQuestions = vi.fn().mockResolvedValue({ question_ids: ['qq2'] });
  vi.mocked(builderApi).reorderQuestions = vi.fn().mockResolvedValue({ question_ids: [] });
  vi.mocked(builderApi).confirmMapping = vi.fn().mockResolvedValue({
    mapping_id: 'mp1',
    confirmed: true,
    publish_readiness: { total: 1, confirmed: 1, remaining: 0 },
  });
});

describe('auto-save', () => {
  /**
   * The property, not the timer: however many keystrokes, one request, carrying the text as it
   * finally stood. A per-keystroke implementation fails on the call count; one that sent a stale
   * closure fails on the payload.
   */
  it('coalesces typing into one request carrying the final text', async () => {
    const user = userEvent.setup();

    renderWorkspace();

    const field = screen.getByLabelText(/^question$/i);

    await user.clear(field);
    await user.type(field, 'Reworded item.');

    /**
     * **Wait for the save carrying the final text — not for "a call".**
     *
     * The previous spelling waited on `toHaveBeenCalledTimes(1)` and then asserted the payload
     * separately, which is a race the machine decides. `clear()` starts the `DEBOUNCE_MS` window;
     * on a loaded machine the typing can outlast it, at which point the product correctly saves the
     * *empty* field, the count reaches one, the wait is satisfied by that save, and the payload
     * assertion reads a request nobody was describing. Reproduced exactly that way under load —
     * `question_text: ""` where `"Reworded item."` was expected. The product was right and the test
     * was measuring the clock.
     *
     * Fake timers were tried first and abandoned: freezing `setTimeout` deadlocks the render, with
     * or without `delay: null` on userEvent, and a test that hangs for fifteen seconds is a worse
     * instrument than one that waits.
     *
     * `toHaveBeenLastCalledWith` is the stale-closure guard the doc comment above asks for: whatever
     * else was sent on the way, the edit must *settle* on the text as it finally stood.
     */
    await waitFor(() =>
      expect(builderApi.updateQuestion).toHaveBeenLastCalledWith(
        'qq000000-0000-4000-8000-000000000001',
        expect.objectContaining({ question_text: 'Reworded item.' }),
      ),
    );

    /**
     * And the coalescing half: fourteen keystrokes did not become fourteen requests.
     *
     * Deliberately not `toBe(1)`. A pause longer than `DEBOUNCE_MS` mid-edit makes an extra save
     * *correct* — that is what the debounce is for — and pinning the exact count is precisely what
     * made this test flaky. A per-keystroke implementation lands at fourteen or more and still
     * fails this decisively, which is the regression the assertion exists to catch.
     */
    expect(vi.mocked(builderApi.updateQuestion).mock.calls.length).toBeLessThan(5);
  });

  it('shows unsaved, then saved', async () => {
    const user = userEvent.setup();

    renderWorkspace();

    await user.type(screen.getByLabelText(/^question$/i), '!');

    expect(await screen.findByText(/unsaved changes/i)).toBeInTheDocument();
    expect(await screen.findByText(/^saved$/i)).toBeInTheDocument();
  });

  /** A toggle has no pause in typing to wait for, so it must not sit in the debounce. */
  it('saves the required toggle immediately', async () => {
    const user = userEvent.setup();

    renderWorkspace();

    await user.click(screen.getByRole('checkbox', { name: /required/i }));

    await waitFor(() =>
      expect(builderApi.updateQuestion).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ required: false }),
      ),
    );
  });

  /**
   * The author's change is still on screen after a failure, and the message says so. Silently
   * dropping the patch would leave the editor showing text the server does not have — the one
   * outcome auto-save must never produce.
   */
  it('keeps the text and explains when a save fails', async () => {
    const user = userEvent.setup();

    vi.mocked(builderApi.updateQuestion).mockRejectedValue(new Error('Network unreachable.'));

    renderWorkspace();

    const field = screen.getByLabelText(/^question$/i);

    await user.clear(field);
    await user.type(field, 'Survives the failure.');

    expect(await screen.findByText(/network unreachable/i)).toBeInTheDocument();
    expect(screen.getByText(/do not retype it/i)).toBeInTheDocument();
    expect(field).toHaveValue('Survives the failure.');
  });
});

describe('editing the question', () => {
  it('replaces the options when the type changes', async () => {
    const user = userEvent.setup();

    renderWorkspace();

    await user.selectOptions(screen.getByLabelText(/question type/i), 'BOOLEAN');

    await waitFor(() =>
      expect(builderApi.updateQuestion).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          question_type: 'BOOLEAN',
          options: [
            { label: 'No', value: 'no', score: 0 },
            { label: 'Yes', value: 'yes', score: 1 },
          ],
        }),
      ),
    );
  });

  /** The author must see the scores — they cannot author an instrument without them. */
  it('shows each option’s score', () => {
    renderWorkspace();

    expect(screen.getByLabelText(/option 1 score/i)).toHaveValue(1);
    expect(screen.getByLabelText(/option 2 score/i)).toHaveValue(2);
  });

  /** Two is the server's floor; refusing here avoids firing a request that can only 422. */
  it('refuses to drop below two options', async () => {
    const user = userEvent.setup();

    renderWorkspace();

    await user.click(screen.getByRole('button', { name: /remove option 1/i }));

    expect(builderApi.updateQuestion).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ options: expect.any(Array) }),
    );
  });

  it('saves a changed dimension mapping', async () => {
    const user = userEvent.setup();

    renderWorkspace();

    await user.click(screen.getByRole('checkbox', { name: /measures focus/i }));

    await waitFor(() =>
      expect(builderApi.updateQuestion).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ dimension_codes: ['TM', 'FOCUS'] }),
      ),
    );
  });
});

describe('add, duplicate and delete', () => {
  it('adds a question', async () => {
    const user = userEvent.setup();

    renderWorkspace();

    await user.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() => expect(builderApi.addQuestions).toHaveBeenCalled());
  });

  it('duplicates a question', async () => {
    const user = userEvent.setup();

    renderWorkspace();

    await user.click(screen.getByRole('button', { name: /duplicate this question/i }));

    await waitFor(() =>
      expect(builderApi.duplicateQuestion).toHaveBeenCalledWith(
        'qq000000-0000-4000-8000-000000000001',
      ),
    );
  });

  it('confirms before deleting, and does not delete when refused', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    renderWorkspace();

    await user.click(screen.getByRole('button', { name: /remove this question/i }));

    expect(confirm).toHaveBeenCalled();
    expect(builderApi.deleteQuestion).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: /remove this question/i }));

    await waitFor(() => expect(builderApi.deleteQuestion).toHaveBeenCalled());

    confirm.mockRestore();
  });
});

describe('the §25 confirmation gate', () => {
  it('marks an unconfirmed mapping and offers a per-mapping confirm', async () => {
    const user = userEvent.setup();

    renderWorkspace({
      review: review({
        publish_readiness: { total: 1, confirmed: 0, remaining: 1 },
        questions: [
          question({
            source: 'AI_GENERATED',
            dimensions: [
              {
                mapping_id: 'mp1',
                code: 'TM',
                name: 'Time Management',
                weight: 1,
                confirmed: false,
                confirmed_at: null,
              },
            ],
          }),
        ],
      }),
    });

    expect(screen.getByText(/cannot publish until a person confirms/i)).toBeInTheDocument();

    // One button per mapping, and no "confirm all" anywhere on the screen (§31).
    await user.click(screen.getByRole('button', { name: /confirm .Time Management./i }));

    await waitFor(() => expect(builderApi.confirmMapping).toHaveBeenCalledWith('mp1'));
    expect(screen.queryByRole('button', { name: /confirm all/i })).not.toBeInTheDocument();
  });

  it('flags the unconfirmed question in the navigator', () => {
    renderWorkspace({
      review: review({
        questions: [
          question({
            dimensions: [
              {
                mapping_id: 'mp1',
                code: 'TM',
                name: 'Time Management',
                weight: 1,
                confirmed: false,
                confirmed_at: null,
              },
            ],
          }),
        ],
      }),
    });

    // The navigator is the publish gate made visible — the list of what still needs a human.
    expect(screen.getByLabelText(/scoring mapping not confirmed/i)).toBeInTheDocument();
  });
});

describe('a published version is frozen', () => {
  /**
   * Invariant 1 (§12). The server refuses every one of these; the UI must not offer them, or the
   * author is invited to make an edit that will fail.
   */
  it('renders read-only, with no editing controls at all', () => {
    renderWorkspace({ review: review({ status: 'PUBLISHED' }), editable: false });

    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^question$/i)).toBeDisabled();
    expect(screen.getByLabelText(/question type/i)).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /required/i })).toBeDisabled();
    expect(screen.getByLabelText(/option 1 score/i)).toBeDisabled();

    expect(screen.queryByRole('button', { name: /^add$/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /duplicate this question/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /remove this question/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove option 1/i })).not.toBeInTheDocument();
    // No drag handle either: reordering is a write.
    expect(screen.queryByRole('button', { name: /reorder question/i })).not.toBeInTheDocument();
  });
});

describe('the live preview', () => {
  /**
   * The preview's job is to show what the *student* sees — and `serializeQuestion` omits option
   * scores and dimensions from the player payload on purpose. A preview that showed them would be
   * previewing the wrong screen.
   */
  it('shows the student’s view without scores or dimensions', async () => {
    const user = userEvent.setup();

    renderWorkspace();

    await user.click(screen.getByRole('button', { name: /^preview$/i }));

    const preview = await screen.findByText(/student’s view/i);
    const panel = preview.parentElement!;

    expect(within(panel).getByText('Disagree')).toBeInTheDocument();
    // The score inputs are gone, and so is the mapping editor.
    expect(screen.queryByLabelText(/option 1 score/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /measures time management/i })).not.toBeInTheDocument();
    expect(
      within(panel).getByText(/never sent to a student/i),
    ).toBeInTheDocument();
  });

  it('goes back to editing', async () => {
    const user = userEvent.setup();

    renderWorkspace();

    await user.click(screen.getByRole('button', { name: /^preview$/i }));
    await user.click(await screen.findByRole('button', { name: /back to editing/i }));

    expect(await screen.findByLabelText(/^question$/i)).toBeInTheDocument();
  });
});

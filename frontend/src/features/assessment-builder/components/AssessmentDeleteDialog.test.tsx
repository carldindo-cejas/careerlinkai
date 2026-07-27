import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { AssessmentDeleteDialog } from '@/features/assessment-builder/components/AssessmentDeleteDialog';
import { assessmentAdminApi } from '@/services/assessmentAdminApi';
import { ApiRequestError } from '@/types/api';
import type { AssessmentDeletability, AssessmentRow } from '@/types/assessmentAdmin';

vi.mock('@/services/assessmentAdminApi');

/**
 * The GitHub-style delete confirmation (v1.6).
 *
 * What is under test is the **gate**, not the request: the button must be unreachable until the
 * administrator has typed the assessment's exact name, and unreachable *at all* when the server
 * says the assessment cannot be deleted. Those are two independent locks, and a test that only
 * checked the happy path would not notice either one coming off.
 *
 * The server enforces the guards itself (`test/assessment/lifecycle.test.ts` covers that side), so
 * these tests are deliberately about what the dialog does with the answer — including the case the
 * list row cannot cover, where the live re-check disagrees with the snapshot the table was rendered
 * from because something started using the assessment while the dialog sat open.
 */

function row(overrides: Partial<AssessmentRow> = {}): AssessmentRow {
  return {
    id: 'aa000000-0000-4000-8000-000000000001',
    title: 'Study Habits Survey',
    description: null,
    category: 'CUSTOM',
    ownership: 'GLOBAL',
    status: 'ACTIVE',
    is_published: true,
    is_archived: false,
    type: null,
    scorings: [],
    versions: [],
    published_version: null,
    assignment: { scope: null, class_count: 0 },
    ai_generatable: true,
    can_delete: true,
    delete_blockers: [],
    delete_blocked_reason: null,
    response_count: 0,
    active_assignment_count: 0,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-02T00:00:00.000Z',
    published_at: '2026-07-02T00:00:00.000Z',
    first_published_at: '2026-07-02T00:00:00.000Z',
    ...overrides,
  };
}

function deletability(overrides: Partial<AssessmentDeletability> = {}): AssessmentDeletability {
  return {
    can_delete: true,
    blockers: [],
    reason: null,
    response_count: 0,
    active_assignment_count: 0,
    ...overrides,
  };
}

function renderDialog(props: Partial<React.ComponentProps<typeof AssessmentDeleteDialog>> = {}) {
  const onDelete = vi.fn().mockResolvedValue({});
  const onClose = vi.fn();

  render(
    <QueryClientProvider client={createQueryClient()}>
      <AssessmentDeleteDialog
        row={row()}
        onClose={onClose}
        onDelete={onDelete}
        isDeleting={false}
        {...props}
      />
    </QueryClientProvider>,
  );

  return { onDelete, onClose };
}

const confirmButton = () => screen.getByRole('button', { name: /delete this assessment/i });

beforeEach(() => {
  vi.mocked(assessmentAdminApi).deletability = vi.fn().mockResolvedValue(deletability());
});

describe('the type-the-name gate', () => {
  it('keeps the delete button disabled until the name matches exactly', async () => {
    const user = userEvent.setup();

    renderDialog();

    await waitFor(() => expect(assessmentAdminApi.deletability).toHaveBeenCalled());
    expect(confirmButton()).toBeDisabled();

    const field = screen.getByLabelText(/to confirm, type/i);

    await user.type(field, 'Study Habits');
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByText(/does not match yet/i)).toBeInTheDocument();

    await user.type(field, ' Survey');
    await waitFor(() => expect(confirmButton()).toBeEnabled());
  });

  /** A title differing only in case is a different assessment, so the match is case-sensitive. */
  it('does not accept a different case', async () => {
    const user = userEvent.setup();

    renderDialog();

    await user.type(screen.getByLabelText(/to confirm, type/i), 'study habits survey');

    expect(confirmButton()).toBeDisabled();
  });

  /** A trailing space from a copy-paste is not a different intention. */
  it('tolerates surrounding whitespace', async () => {
    const user = userEvent.setup();

    renderDialog();

    await user.type(screen.getByLabelText(/to confirm, type/i), '  Study Habits Survey  ');

    await waitFor(() => expect(confirmButton()).toBeEnabled());
  });

  it('deletes once armed, and closes', async () => {
    const user = userEvent.setup();
    const { onDelete, onClose } = renderDialog();

    await user.type(screen.getByLabelText(/to confirm, type/i), 'Study Habits Survey');
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    await user.click(confirmButton());

    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('when the assessment cannot be deleted', () => {
  it('explains why, in the server’s words, and refuses to arm', async () => {
    const user = userEvent.setup();

    vi.mocked(assessmentAdminApi.deletability).mockResolvedValue(
      deletability({
        can_delete: false,
        blockers: ['HAS_RESPONSES'],
        reason:
          'This assessment cannot be deleted: 12 student responses exist for it, and assessment history is never deleted — archive it instead.',
        response_count: 12,
      }),
    );

    const { onDelete } = renderDialog({
      row: row({
        can_delete: false,
        delete_blockers: ['HAS_RESPONSES'],
        delete_blocked_reason: 'This assessment cannot be deleted: 12 student responses exist.',
        response_count: 12,
      }),
    });

    expect(await screen.findByText(/archive it instead/i)).toBeInTheDocument();

    // The field is disabled too, so there is no way to reach the armed state at all.
    expect(screen.getByLabelText(/to confirm, type/i)).toBeDisabled();
    expect(confirmButton()).toBeDisabled();

    await user.click(confirmButton());
    expect(onDelete).not.toHaveBeenCalled();
  });

  /**
   * The case the list row cannot cover. The table said this was deletable; between then and now a
   * class started it. The live re-check is what turns that into a refusal *before* the delete
   * rather than a 422 after it.
   */
  it('trusts the live re-check over the row’s snapshot', async () => {
    vi.mocked(assessmentAdminApi.deletability).mockResolvedValue(
      deletability({
        can_delete: false,
        blockers: ['HAS_ACTIVE_ASSIGNMENTS'],
        reason: 'This assessment cannot be deleted: it is currently assigned to 2 classes.',
        active_assignment_count: 2,
      }),
    );

    // The row still says it can be deleted — it was fetched before the assignment happened.
    renderDialog({ row: row({ can_delete: true }) });

    expect(await screen.findByText(/currently assigned to 2 classes/i)).toBeInTheDocument();
    expect(confirmButton()).toBeDisabled();
  });

  /**
   * The narrower race the re-check itself can lose: something starts using the assessment between
   * the check and the click. The server refuses, and the dialog shows the reason rather than a
   * generic failure.
   */
  it('surfaces a server refusal that beat the re-check', async () => {
    const user = userEvent.setup();

    const onDelete = vi.fn().mockRejectedValue(
      new ApiRequestError('This assessment cannot be deleted.', 422, {
        assessment: ['This assessment cannot be deleted: 1 student response exists for it.'],
      }),
    );

    render(
      <QueryClientProvider client={createQueryClient()}>
        <AssessmentDeleteDialog
          row={row()}
          onClose={vi.fn()}
          onDelete={onDelete}
          isDeleting={false}
        />
      </QueryClientProvider>,
    );

    await user.type(screen.getByLabelText(/to confirm, type/i), 'Study Habits Survey');
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    await user.click(confirmButton());

    expect(await screen.findByText(/1 student response exists for it/i)).toBeInTheDocument();
  });
});

describe('what the dialog tells the administrator', () => {
  /**
   * An administrator choosing between Archive and Delete deserves to know the difference rather
   * than infer it from two similarly-shaped buttons.
   */
  it('names archiving as the reversible alternative', async () => {
    renderDialog();

    expect(await screen.findByText(/Archive/)).toBeInTheDocument();
    expect(screen.getByText(/no Restore button for it/i)).toBeInTheDocument();
  });

  it('states that nothing is lost when the delete is permitted', async () => {
    renderDialog();

    expect(await screen.findByText(/no student has responded/i)).toBeInTheDocument();
  });
});

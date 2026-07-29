import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { CounselorClassesPanel } from '@/features/admin/components/CounselorClassesPanel';
import { classApi } from '@/services/classApi';
import { counselorManagementApi } from '@/services/counselorManagementApi';
import { useToastStore } from '@/stores/toastStore';
import type { ClassRoom } from '@/types/class';
import type { ManagedCounselor } from '@/types/platform';

vi.mock('@/services/classApi');
vi.mock('@/services/counselorManagementApi');

/**
 * Class reassignment (audit F5, plan P3-6).
 *
 * `classes.counselor_id` was set at creation and writable by nothing, so a departing counselor took
 * their classes' ownership with them: the rows stayed, pointing at a removed account, and no
 * replacement could ever be given them. This panel is the **only** caller of the endpoint that
 * moves one — an endpoint with no caller being the F1/F2 defect this plan opens by naming.
 */

const LEAVING = 'c-leaving';

function classRoom(id: string, name: string, status: ClassRoom['status'] = 'active'): ClassRoom {
  return {
    id,
    counselor_id: LEAVING,
    name,
    academic_year: '2026-2027',
    grade_level_id: null,
    shs_strand_id: null,
    grade_level: null,
    shs_strand: null,
    join_code: 'ABCD-2345',
    join_code_expires_at: null,
    status,
    created_at: null,
    updated_at: null,
  };
}

function counselor(id: string, name: string): ManagedCounselor {
  return {
    id,
    name,
    email: `${id}@school.test`,
    role: 'counselor',
    status: 'active',
    must_change_password: false,
    counselor_profile: null,
    classes_count: 0,
    students_count: 0,
    created_at: null,
    updated_at: null,
  } as unknown as ManagedCounselor;
}

const REPLACEMENT = counselor('c-replacement', 'Ana Reyes');
const OTHER = counselor('c-other', 'Ben Cruz');

function page<T>(items: T[], total = items.length) {
  return {
    items,
    pagination: { current_page: 1, per_page: 20, total, last_page: 1 },
  };
}

function renderPanel() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <CounselorClassesPanel counselorId={LEAVING} counselorName="Departing Counselor" />
    </QueryClientProvider>,
  );

  return userEvent.setup();
}

/** Open the target picker and choose a counselor by name. */
async function chooseTarget(user: ReturnType<typeof userEvent.setup>, name: string | RegExp) {
  await user.click(await screen.findByLabelText(/hand a class to/i));
  await user.click(await screen.findByRole('option', { name }));
}

function toasts() {
  return useToastStore.getState().toasts;
}

describe('CounselorClassesPanel — reassignment (audit F5)', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });

    vi.mocked(classApi.listForCounselor).mockReset();
    vi.mocked(classApi.reassign).mockReset();
    vi.mocked(counselorManagementApi.list).mockReset();

    vi.mocked(classApi.listForCounselor).mockResolvedValue(
      page([classRoom('cl-1', 'Grade 12 STEM A'), classRoom('cl-2', 'Grade 11 HUMSS B')]),
    );
    vi.mocked(counselorManagementApi.list).mockResolvedValue(page([REPLACEMENT, OTHER]));
    vi.mocked(classApi.reassign).mockResolvedValue(classRoom('cl-1', 'Grade 12 STEM A'));
  });

  it('lists the counselor’s classes', async () => {
    renderPanel();

    expect(await screen.findByText('Grade 12 STEM A')).toBeInTheDocument();
    expect(screen.getByText('Grade 11 HUMSS B')).toBeInTheDocument();
  });

  /** The P2-1 / P3-2 guarantee: a picker costs a request when it is used, not when it is drawn. */
  it('fetches no candidates until the picker is opened', async () => {
    const user = renderPanel();

    await screen.findByText('Grade 12 STEM A');

    expect(counselorManagementApi.list).not.toHaveBeenCalled();

    await user.click(screen.getByLabelText(/hand a class to/i));

    await waitFor(() => expect(counselorManagementApi.list).toHaveBeenCalled());
  });

  it('reassigns one class to the chosen counselor', async () => {
    const user = renderPanel();

    await chooseTarget(user, 'Ana Reyes');
    await user.click(await screen.findByRole('button', { name: /reassign grade 12 stem a/i }));

    await waitFor(() =>
      expect(classApi.reassign).toHaveBeenCalledWith('cl-1', REPLACEMENT.id),
    );
    // One press, one class: the other row is not swept along by a target chosen once.
    expect(classApi.reassign).toHaveBeenCalledTimes(1);
  });

  /**
   * The target is chosen once and each row moves on its own press, so a leaver's load can be split
   * between two people without re-picking per row — and cannot be moved *accidentally* in bulk.
   */
  it('keeps the chosen target across rows, so several classes can be handed over in turn', async () => {
    const user = renderPanel();

    await chooseTarget(user, 'Ana Reyes');
    await user.click(await screen.findByRole('button', { name: /reassign grade 12 stem a/i }));
    await waitFor(() => expect(classApi.reassign).toHaveBeenCalledTimes(1));

    await user.click(await screen.findByRole('button', { name: /reassign grade 11 humss b/i }));

    await waitFor(() => expect(classApi.reassign).toHaveBeenCalledTimes(2));
    expect(classApi.reassign).toHaveBeenLastCalledWith('cl-2', REPLACEMENT.id);
  });

  /** Pressing Reassign with nothing chosen would be a request with no target — so it cannot be. */
  it('disables Reassign until a counselor is chosen', async () => {
    renderPanel();

    expect(await screen.findByRole('button', { name: /reassign grade 12 stem a/i })).toBeDisabled();
  });

  /**
   * **Every row's button is otherwise called "Reassign".**
   *
   * Two classes present two identically-named buttons to a screen reader, with nothing to say which
   * one is about to change hands — the same defect P3-2a found on the canonical-programme rows,
   * where nine entries offered nine identical "Merge" buttons.
   */
  it('names the class in each row’s button, so the buttons are distinguishable', async () => {
    renderPanel();

    expect(
      await screen.findByRole('button', { name: 'Reassign Grade 12 STEM A' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reassign Grade 11 HUMSS B' })).toBeInTheDocument();
  });

  /** Handing a class back to the counselor who already owns it is a button that does nothing. */
  it('never offers the current owner as a target', async () => {
    vi.mocked(counselorManagementApi.list).mockResolvedValue(
      page([REPLACEMENT, counselor(LEAVING, 'Departing Counselor')]),
    );

    const user = renderPanel();

    await user.click(await screen.findByLabelText(/hand a class to/i));

    expect(await screen.findByRole('option', { name: 'Ana Reyes' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Departing Counselor' })).not.toBeInTheDocument();
  });

  /**
   * F3's lesson applied to a picker: the silence about the rest is what makes a truncation
   * invisible. 40 active counselors and 20 shown has to say so.
   */
  it('says when the candidate list is truncated', async () => {
    vi.mocked(counselorManagementApi.list).mockResolvedValue(page([REPLACEMENT, OTHER], 40));

    const user = renderPanel();

    await user.click(await screen.findByLabelText(/hand a class to/i));

    expect(await screen.findByText(/showing 2 of 40/i)).toBeInTheDocument();
  });

  /** A counselor with nothing to hand over is one the admin can remove — say so, on this screen. */
  it('says the account can be removed when there are no classes', async () => {
    vi.mocked(classApi.listForCounselor).mockResolvedValue(page([]));

    renderPanel();

    expect(await screen.findByText(/can be removed/i)).toBeInTheDocument();
  });

  it('reports a failed reassignment rather than looking like it worked', async () => {
    vi.mocked(classApi.reassign).mockRejectedValue(new Error('That counselor is suspended.'));

    const user = renderPanel();

    await chooseTarget(user, 'Ana Reyes');
    await user.click(await screen.findByRole('button', { name: /reassign grade 12 stem a/i }));

    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0]!.tone).toBe('error');
    // The server's reason, not a generic one: "that counselor is suspended" tells the admin to pick
    // somebody else, and "the change failed" tells them to try the same thing again.
    expect(toasts()[0]!.message).toContain('That counselor is suspended.');
  });

  it('confirms a successful reassignment, naming the class that moved', async () => {
    const user = renderPanel();

    await chooseTarget(user, 'Ana Reyes');
    await user.click(await screen.findByRole('button', { name: /reassign grade 12 stem a/i }));

    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0]!.tone).toBe('success');
    expect(toasts()[0]!.message).toContain('Grade 12 STEM A');
  });
});

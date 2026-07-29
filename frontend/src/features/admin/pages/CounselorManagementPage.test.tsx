import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { CounselorManagementPage } from '@/features/admin/pages/CounselorManagementPage';
import { counselorManagementApi } from '@/services/counselorManagementApi';
import { useToastStore } from '@/stores/toastStore';
import { ApiRequestError } from '@/types/api';
import type { CreatedCounselor, ManagedCounselor } from '@/types/platform';

vi.mock('@/services/counselorManagementApi');

/**
 * Admin password reset (audit C2, P1-4).
 *
 * The backend side of C2 has nine tests, including one that signs in with the issued password. The
 * control on top of it had none, and the three things that can go wrong here are all UI-side:
 *
 *   1. **It is confirmed, not immediate.** Resetting invalidates a password the counselor may be
 *      using perfectly well right now and signs them out of every session. On a dense list, an
 *      unconfirmed button one row away from "Remove" locks a working account out mid-lesson.
 *   2. **The temporary password reaches the banner.** It is returned exactly once, is not stored,
 *      not logged and not retrievable — so a reset whose password never reaches the screen has
 *      destroyed the account it was pressed to recover. Nothing else in the system can recover it.
 *   3. **Confirmation is per row.** Arming one counselor's reset must not arm another's; a list
 *      that shared this state would put "Confirm reset" under a row the admin never touched.
 */

function counselor(id: string, name: string, email: string): ManagedCounselor {
  return {
    id,
    name,
    email,
    role: 'counselor',
    status: 'active',
    must_change_password: false,
    email_verified_at: null,
    last_login_at: '2026-07-20T01:00:00Z',
    created_at: '2026-06-01T00:00:00Z',
    classes_count: 2,
    students_count: 31,
  };
}

const MARIA = counselor('11111111-1111-4111-8111-111111111111', 'Maria Santos', 'maria@school.ph');
const RUEL = counselor('22222222-2222-4222-8222-222222222222', 'Ruel Aquino', 'ruel@school.ph');

function issued(from: ManagedCounselor, temporaryPassword: string): CreatedCounselor {
  return { ...from, must_change_password: true, temporary_password: temporaryPassword };
}

function page<T>(items: T[]) {
  return {
    items,
    pagination: { current_page: 1, per_page: 20, total: items.length, last_page: 1 },
  };
}

function renderPage() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <CounselorManagementPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return userEvent.setup();
}

/**
 * The one row belonging to this counselor, so "Confirm reset" is never matched across rows.
 *
 * Anchored on the row's link — the name sits inside it, and its parent is the card body holding
 * both the link and that row's action buttons. Structural rather than class-based, so a restyle
 * does not silently widen the query to the whole list.
 */
function row(name: string) {
  return screen.getByText(name).closest('a')!.parentElement!;
}

function toasts() {
  return useToastStore.getState().toasts;
}

describe('CounselorManagementPage — reset password', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });

    vi.mocked(counselorManagementApi.list).mockReset().mockResolvedValue(page([MARIA, RUEL]));
    vi.mocked(counselorManagementApi.resetPassword).mockReset();
  });

  it('asks for confirmation instead of resetting on the first click', async () => {
    const user = renderPage();

    await user.click((await screen.findAllByRole('button', { name: /reset password/i }))[0]!);

    expect(screen.getByRole('button', { name: /confirm reset/i })).toBeInTheDocument();
    // The whole point of the confirmation: the first click is inert.
    expect(counselorManagementApi.resetPassword).not.toHaveBeenCalled();
  });

  it('abandons the reset on Cancel, leaving the account untouched', async () => {
    const user = renderPage();

    await user.click((await screen.findAllByRole('button', { name: /reset password/i }))[0]!);
    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(screen.queryByRole('button', { name: /confirm reset/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^reset password$/i })).toHaveLength(2);
    expect(counselorManagementApi.resetPassword).not.toHaveBeenCalled();
  });

  /** **The one that matters.** A password that does not reach the screen is a password that is gone. */
  it('shows the issued temporary password once, against the counselor it belongs to', async () => {
    vi.mocked(counselorManagementApi.resetPassword).mockResolvedValue(issued(MARIA, 'Kd7-Rt9-Wm2'));

    const user = renderPage();

    await user.click((await screen.findAllByRole('button', { name: /reset password/i }))[0]!);
    await user.click(screen.getByRole('button', { name: /confirm reset/i }));

    const banner = await screen.findByRole('status');

    expect(within(banner).getByText('Kd7-Rt9-Wm2')).toBeInTheDocument();
    expect(banner).toHaveTextContent('maria@school.ph');
    // Said plainly, because it is true and cannot be undone by the admin who misses it.
    expect(banner).toHaveTextContent(/shown only this once and cannot be retrieved/i);

    expect(counselorManagementApi.resetPassword).toHaveBeenCalledExactlyOnceWith(MARIA.id);
  });

  it('closes the confirmation once the password has been issued', async () => {
    vi.mocked(counselorManagementApi.resetPassword).mockResolvedValue(issued(MARIA, 'Kd7-Rt9-Wm2'));

    const user = renderPage();

    await user.click((await screen.findAllByRole('button', { name: /reset password/i }))[0]!);
    await user.click(screen.getByRole('button', { name: /confirm reset/i }));

    await screen.findByRole('status');

    // A confirmation left armed invites a second reset that would invalidate the password still
    // being read off the banner above it.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /confirm reset/i })).not.toBeInTheDocument(),
    );
  });

  it('arms one row at a time', async () => {
    const user = renderPage();

    await screen.findByText('Maria Santos');
    await user.click(within(row('Maria Santos')).getByRole('button', { name: /reset password/i }));

    expect(within(row('Maria Santos')).getByRole('button', { name: /confirm reset/i })).toBeInTheDocument();
    expect(
      within(row('Ruel Aquino')).queryByRole('button', { name: /confirm reset/i }),
    ).not.toBeInTheDocument();
  });

  it('reports a failed reset and shows no banner, so nothing implies a password was issued', async () => {
    vi.mocked(counselorManagementApi.resetPassword).mockRejectedValue(
      new ApiRequestError('That counselor has been removed.', 404),
    );

    const user = renderPage();

    await user.click((await screen.findAllByRole('button', { name: /reset password/i }))[0]!);
    await user.click(screen.getByRole('button', { name: /confirm reset/i }));

    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0]).toMatchObject({ tone: 'error' });
    expect(toasts()[0]?.message).toBe('That counselor has been removed.');

    // No banner: the admin must not be left believing a credential exists that does not.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

/**
 * The F5 removal guard, from the screen's side (plan P3-6).
 *
 * The server now refuses `DELETE /admin/counselors/{id}` while the counselor still holds live
 * classes, because deleting them used to leave those classes pointing at an account that no longer
 * exists — permanently, since `counselor_id` was writable by nothing. A refusal is only half an
 * answer, though: what makes it a fix rather than an obstruction is that the admin is told *how
 * many* and pointed at the one screen that can move them.
 */
describe('CounselorManagementPage — the F5 removal guard', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });

    vi.mocked(counselorManagementApi.list).mockReset().mockResolvedValue(page([MARIA, RUEL]));
    vi.mocked(counselorManagementApi.remove).mockReset();
  });

  it('shows the server’s reason and a link to reassign, rather than a bare failure', async () => {
    vi.mocked(counselorManagementApi.remove).mockRejectedValue(
      new ApiRequestError('This counselor still has classes.', 422, {
        classes: ['This counselor still has 2 classes. Reassign them to another counselor first, or delete them.'],
      }),
    );

    const user = renderPage();

    await screen.findByText('Maria Santos');

    await user.click(within(row('Maria Santos')).getByRole('button', { name: /remove/i }));
    await user.click(within(row('Maria Santos')).getByRole('button', { name: /confirm removal/i }));

    expect(await screen.findByText(/still has 2 classes/i)).toBeInTheDocument();

    // The remedy, and it goes to the counselor whose classes they are — a link to the wrong
    // detail page would be worse than no link.
    const link = screen.getByRole('link', { name: /reassign their classes/i });

    expect(link).toHaveAttribute('href', `/admin/counselors/${MARIA.id}`);
  });

  /** Any other failure keeps the old message: only F5 has somewhere for the admin to go. */
  it('falls back to the plain message for a failure that is not about classes', async () => {
    vi.mocked(counselorManagementApi.remove).mockRejectedValue(
      new ApiRequestError('Counselor not found.', 404),
    );

    const user = renderPage();

    await screen.findByText('Maria Santos');

    await user.click(within(row('Maria Santos')).getByRole('button', { name: /remove/i }));
    await user.click(within(row('Maria Santos')).getByRole('button', { name: /confirm removal/i }));

    expect(await screen.findByText('Counselor not found.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /reassign their classes/i })).not.toBeInTheDocument();
  });
});

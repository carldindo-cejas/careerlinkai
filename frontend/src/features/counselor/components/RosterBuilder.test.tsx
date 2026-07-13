import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { RosterBuilder } from '@/features/counselor/components/RosterBuilder';
import { rosterApi } from '@/services/rosterApi';
import { ApiRequestError } from '@/types/api';
import type { PreviewedStudent, RosterEntry } from '@/types/class';

vi.mock('@/services/rosterApi');

const CLASS_ID = '33333333-3333-4333-8333-333333333333';

function previewed(overrides: Partial<PreviewedStudent> & { first_name: string }): PreviewedStudent {
  return {
    name: overrides.first_name,
    last_name: null,
    username: overrides.first_name.toLowerCase(),
    ...overrides,
  };
}

function enrolled(username: string): RosterEntry {
  return {
    id: `enrollment-${username}`,
    class_id: CLASS_ID,
    student_id: `student-${username}`,
    username,
    status: 'active',
    joined_at: '2026-07-13T09:14:02+00:00',
    removed_at: null,
    first_name: 'Juan',
    last_name: 'Dela Cruz',
  };
}

function renderBuilder(onConfirmed = vi.fn()) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RosterBuilder classId={CLASS_ID} onConfirmed={onConfirmed} />
    </QueryClientProvider>,
  );

  return { onConfirmed };
}

async function paste(names: string) {
  const user = userEvent.setup();

  await user.type(screen.getByLabelText(/student names/i), names);
  await user.click(screen.getByRole('button', { name: /generate usernames/i }));

  return user;
}

describe('RosterBuilder', () => {
  beforeEach(() => {
    vi.mocked(rosterApi.preview).mockReset();
    vi.mocked(rosterApi.confirm).mockReset();
  });

  /**
   * The §57 demo, as a single interaction: paste names, review what the server proposed,
   * edit a username, confirm. Preview must not create anything — that is the whole reason
   * it is a separate request.
   */
  it('previews pasted names, lets the counselor edit a username, and confirms the edit', async () => {
    vi.mocked(rosterApi.preview).mockResolvedValue([
      previewed({ first_name: 'Juan', last_name: 'Dela Cruz', username: 'juan.delacruz' }),
      previewed({ first_name: 'Juan', last_name: 'Dela Cruz', username: 'juan.delacruz2' }),
    ]);
    vi.mocked(rosterApi.confirm).mockResolvedValue([enrolled('juan.delacruz')]);

    const { onConfirmed } = renderBuilder();
    const user = await paste('Juan Dela Cruz\nJuan Dela Cruz');

    const secondUsername = await screen.findByLabelText(/^username$/i, { selector: '#username-1' });
    expect(secondUsername).toHaveValue('juan.delacruz2');

    // Nothing is written until confirm — this is a proposal on screen, not a roster.
    expect(rosterApi.confirm).not.toHaveBeenCalled();

    await user.clear(secondUsername);
    await user.type(secondUsername, 'juan.delacruz.jr');

    await user.click(screen.getByRole('button', { name: /confirm 2 students/i }));

    await waitFor(() => {
      expect(rosterApi.confirm).toHaveBeenCalledWith(CLASS_ID, [
        { first_name: 'Juan', last_name: 'Dela Cruz', username: 'juan.delacruz' },
        { first_name: 'Juan', last_name: 'Dela Cruz', username: 'juan.delacruz.jr' },
      ]);
    });

    expect(onConfirmed).toHaveBeenCalledWith(1);
  });

  /**
   * A rejected batch creates nothing at all (§13.2), so a single message at the top of a
   * 40-row list is useless. The server reports positionally — `students.1.username` — and
   * the error has to land on the row that caused it.
   */
  it('renders a per-row 422 against the row that caused it', async () => {
    vi.mocked(rosterApi.preview).mockResolvedValue([
      previewed({ first_name: 'Maria', last_name: 'Santos', username: 'maria.santos' }),
      previewed({ first_name: 'Juan', last_name: 'Dela Cruz', username: 'juan.delacruz' }),
    ]);

    vi.mocked(rosterApi.confirm).mockRejectedValue(
      new ApiRequestError('Validation failed.', 422, {
        'students.1.username': ['The username "juan.delacruz" is already taken in this class.'],
      }),
    );

    renderBuilder();
    const user = await paste('Maria Santos\nJuan Dela Cruz');

    await user.click(await screen.findByRole('button', { name: /confirm 2 students/i }));

    expect(await screen.findByText(/already taken in this class/i)).toBeInTheDocument();

    // The message is attached to the offending row's username box, not floating above the
    // list — and the row that was fine is not flagged.
    expect(screen.getByLabelText(/^username$/i, { selector: '#username-1' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByLabelText(/^username$/i, { selector: '#username-0' })).toHaveAttribute(
      'aria-invalid',
      'false',
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/no accounts were created/i);
  });

  /**
   * A mononym is a name, not an error (§13.1, v1.2). "Madonna" previews with no last name,
   * and confirms with the last name left as NULL — the counselor is not asked to invent a
   * surname the student does not have.
   */
  it('confirms a one-word name with no last name', async () => {
    vi.mocked(rosterApi.preview).mockResolvedValue([
      previewed({ first_name: 'Madonna', last_name: null, username: 'madonna' }),
    ]);
    vi.mocked(rosterApi.confirm).mockResolvedValue([enrolled('madonna')]);

    renderBuilder();
    const user = await paste('Madonna');

    expect(await screen.findByLabelText(/^last name$/i)).toHaveValue('');

    await user.click(screen.getByRole('button', { name: /confirm 1 student/i }));

    await waitFor(() => {
      expect(rosterApi.confirm).toHaveBeenCalledWith(CLASS_ID, [
        { first_name: 'Madonna', last_name: null, username: 'madonna' },
      ]);
    });
  });

  it('refuses to send a batch over the 200-name cap', async () => {
    const names = Array.from({ length: 201 }, (_, i) => `Student ${i}`).join('\n');

    renderBuilder();

    const user = userEvent.setup();
    await user.click(screen.getByLabelText(/student names/i));
    await user.paste(names);

    expect(screen.getByText(/over the limit of 200/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /generate usernames/i })).toBeDisabled();
    expect(rosterApi.preview).not.toHaveBeenCalled();
  });
});

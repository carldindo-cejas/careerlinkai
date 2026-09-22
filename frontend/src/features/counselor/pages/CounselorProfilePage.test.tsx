import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { CounselorProfilePage } from '@/features/counselor/pages/CounselorProfilePage';
import { accountApi } from '@/services/accountApi';
import { authApi } from '@/services/authApi';
import { useAuthStore } from '@/stores/authStore';
import { ApiRequestError } from '@/types/api';
import type { User } from '@/types/user';

vi.mock('@/services/accountApi');
vi.mock('@/services/authApi');

const counselor: User = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Test Counselor',
  email: 'counselor@school.test',
  role: 'counselor',
  status: 'active',
  must_change_password: false,
  email_verified_at: null,
  last_login_at: null,
  created_at: null,
  counselor_profile: {
    id: '44444444-4444-4444-8444-444444444444',
    first_name: 'Test',
    last_name: 'Counselor',
    phone: null,
    employee_number: null,
    specialization: null,
    bio: null,
  },
};

const admin: User = {
  id: '99999999-9999-4999-8999-999999999999',
  name: 'Test Admin',
  email: 'admin@school.test',
  role: 'admin',
  status: 'active',
  must_change_password: false,
  email_verified_at: null,
  last_login_at: null,
  created_at: null,
};

function renderPage(user: User) {
  useAuthStore.setState({ token: 'token', user });

  const person = userEvent.setup();

  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <CounselorProfilePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return person;
}

describe('CounselorProfilePage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useAuthStore.setState({ token: null, user: null });
    // Asked for on every mount — the page has to know whether it is in the middle of an email
    // change before it can decide which card belongs in that slot.
    vi.mocked(accountApi.pendingEmailChange).mockResolvedValue(null);
  });

  /** Walk step one: type the address, confirm the password, land on the code card. */
  async function stageEmailChange(person: UserEvent, email = 'new@school.test') {
    await person.type(await screen.findByLabelText('New email address'), email);
    await person.click(screen.getByRole('button', { name: /update email/i }));

    const dialog = await screen.findByRole('dialog');

    await person.type(screen.getByLabelText('Your current password'), 'CorrectHorse1');
    await person.click(within(dialog).getByRole('button', { name: /send code/i }));
  }

  it('sends only the details card, with an emptied optional field cleared rather than blanked', async () => {
    vi.mocked(accountApi.updateAccount).mockResolvedValue({
      ...counselor,
      name: 'Maria Reyes',
      counselor_profile: { ...counselor.counselor_profile!, first_name: 'Maria', last_name: 'Reyes' },
    });

    const person = renderPage(counselor);

    await person.clear(screen.getByLabelText('First name'));
    await person.type(screen.getByLabelText('First name'), 'Maria');
    await person.clear(screen.getByLabelText('Last name'));
    await person.type(screen.getByLabelText('Last name'), 'Reyes');
    await person.click(screen.getByRole('button', { name: /save details/i }));

    await waitFor(() => expect(accountApi.updateAccount).toHaveBeenCalledTimes(1));

    expect(vi.mocked(accountApi.updateAccount).mock.calls[0]![0]).toEqual({
      first_name: 'Maria',
      last_name: 'Reyes',
      // Untouched and already empty: `null` is a clear, and `''` would store a blank string that
      // looks filled in to anything checking for one.
      phone: null,
      employee_number: null,
      specialization: null,
      bio: null,
    });
    // No password was asked for, and none was sent — a name is a label, not a way in.
    expect(authApi.changePassword).not.toHaveBeenCalled();
  });

  it('writes the new name straight into the session, so the shell does not lag behind', async () => {
    vi.mocked(accountApi.updateAccount).mockResolvedValue({ ...counselor, name: 'Maria Reyes' });

    const person = renderPage(counselor);

    await person.clear(screen.getByLabelText('First name'));
    await person.type(screen.getByLabelText('First name'), 'Maria');
    await person.click(screen.getByRole('button', { name: /save details/i }));

    await waitFor(() => expect(useAuthStore.getState().user?.name).toBe('Maria Reyes'));
  });

  it('asks for the password in a prompt, not on the card, and only stages the change', async () => {
    vi.mocked(accountApi.requestEmailChange).mockResolvedValue({
      pending_email: 'new@school.test',
      expires_in_minutes: 15,
    });

    const person = renderPage(counselor);

    // The card carries the address and nothing else — no password box for a browser to fill in.
    expect(await screen.findByLabelText('New email address')).toHaveValue('');
    expect(screen.queryByLabelText('Your current password')).not.toBeInTheDocument();

    await person.type(screen.getByLabelText('New email address'), 'new@school.test');
    await person.click(screen.getByRole('button', { name: /update email/i }));

    // Nothing is sent yet: the prompt is the next step, and it opens empty.
    expect(accountApi.requestEmailChange).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('new@school.test');
    expect(screen.getByLabelText('Your current password')).toHaveValue('');

    await person.type(screen.getByLabelText('Your current password'), 'CorrectHorse1');
    await person.click(within(dialog).getByRole('button', { name: /send code/i }));

    await waitFor(() =>
      expect(accountApi.requestEmailChange).toHaveBeenCalledWith({
        email: 'new@school.test',
        current_password: 'CorrectHorse1',
      }),
    );

    // Step one moves nothing: the session still holds the old address.
    expect(useAuthStore.getState().user?.email).toBe('counselor@school.test');
    expect(accountApi.verifyEmailChange).not.toHaveBeenCalled();
  });

  it('swaps the form for a code card naming the address the code went to', async () => {
    vi.mocked(accountApi.requestEmailChange).mockResolvedValue({
      pending_email: 'new@school.test',
      expires_in_minutes: 15,
    });

    const person = renderPage(counselor);

    await stageEmailChange(person);

    expect(await screen.findByLabelText('Six-digit code')).toBeInTheDocument();
    expect(screen.getByText(/new@school.test/)).toBeInTheDocument();
    expect(screen.getByText(/expires in 15 minutes/i)).toBeInTheDocument();
    // One input in that slot at a time — an address box under a code box is how somebody types
    // the wrong thing into the wrong one.
    expect(screen.queryByLabelText('New email address')).not.toBeInTheDocument();
  });

  it('moves the address only once the code is confirmed', async () => {
    vi.mocked(accountApi.requestEmailChange).mockResolvedValue({
      pending_email: 'new@school.test',
      expires_in_minutes: 15,
    });
    vi.mocked(accountApi.verifyEmailChange).mockResolvedValue({
      ...counselor,
      email: 'new@school.test',
    });

    const person = renderPage(counselor);

    await stageEmailChange(person);

    await person.type(await screen.findByLabelText('Six-digit code'), '123456');
    await person.click(screen.getByRole('button', { name: /confirm email/i }));

    await waitFor(() => expect(accountApi.verifyEmailChange).toHaveBeenCalledWith('123456'));
    // Written into the session from the response, so the shell does not lag behind.
    await waitFor(() => expect(useAuthStore.getState().user?.email).toBe('new@school.test'));
    // Done with: the slot goes back to the address form.
    expect(await screen.findByLabelText('New email address')).toBeInTheDocument();
  });

  it('refuses to send anything that is not six digits', async () => {
    vi.mocked(accountApi.requestEmailChange).mockResolvedValue({
      pending_email: 'new@school.test',
      expires_in_minutes: 15,
    });

    const person = renderPage(counselor);

    await stageEmailChange(person);

    await person.type(await screen.findByLabelText('Six-digit code'), '12ab');
    await person.click(screen.getByRole('button', { name: /confirm email/i }));

    expect(
      await screen.findByText('Enter the six-digit code from your email.'),
    ).toBeInTheDocument();
    expect(accountApi.verifyEmailChange).not.toHaveBeenCalled();
  });

  it('keeps the code card up when the code is rejected', async () => {
    vi.mocked(accountApi.requestEmailChange).mockResolvedValue({
      pending_email: 'new@school.test',
      expires_in_minutes: 15,
    });
    vi.mocked(accountApi.verifyEmailChange).mockRejectedValue(
      new ApiRequestError('The given data was invalid.', 422, {
        code: ['That code is invalid or has expired. Ask for a new one.'],
      }),
    );

    const person = renderPage(counselor);

    await stageEmailChange(person);

    await person.type(await screen.findByLabelText('Six-digit code'), '000000');
    await person.click(screen.getByRole('button', { name: /confirm email/i }));

    expect(
      await screen.findByText('That code is invalid or has expired. Ask for a new one.'),
    ).toBeInTheDocument();
    // Still staged: a mistyped digit must not cost the code that did arrive.
    expect(screen.getByLabelText('Six-digit code')).toBeInTheDocument();
    expect(useAuthStore.getState().user?.email).toBe('counselor@school.test');
  });

  it('asks for a new code and empties the box for it', async () => {
    vi.mocked(accountApi.requestEmailChange).mockResolvedValue({
      pending_email: 'new@school.test',
      expires_in_minutes: 15,
    });
    vi.mocked(accountApi.resendEmailChangeCode).mockResolvedValue({
      pending_email: 'new@school.test',
      expires_in_minutes: 15,
    });

    const person = renderPage(counselor);

    await stageEmailChange(person);

    await person.type(await screen.findByLabelText('Six-digit code'), '111111');
    await person.click(screen.getByRole('button', { name: /send a new code/i }));

    await waitFor(() => expect(accountApi.resendEmailChangeCode).toHaveBeenCalledTimes(1));
    // The old code is dead on the server, so leaving it in the box would only invite a 422.
    await waitFor(() => expect(screen.getByLabelText('Six-digit code')).toHaveValue(''));
  });

  it('gives the address form back when the change is abandoned', async () => {
    vi.mocked(accountApi.requestEmailChange).mockResolvedValue({
      pending_email: 'typo@school.test',
      expires_in_minutes: 15,
    });
    vi.mocked(accountApi.cancelEmailChange).mockResolvedValue(null);

    const person = renderPage(counselor);

    await stageEmailChange(person, 'typo@school.test');

    await person.click(
      await screen.findByRole('button', { name: /use a different address/i }),
    );

    await waitFor(() => expect(accountApi.cancelEmailChange).toHaveBeenCalledTimes(1));
    // Back to step one, and empty — the address that was staged is the one being corrected.
    expect(await screen.findByLabelText('New email address')).toHaveValue('');
  });

  it('lands back on the code card after a reload, rather than starting again', async () => {
    // The code arrives on a phone while the form is on a desktop; the tab gets reloaded on the
    // way back. Remembering this in component state would forget it here.
    vi.mocked(accountApi.pendingEmailChange).mockResolvedValue({
      pending_email: 'waiting@school.test',
      expires_in_minutes: 9,
    });

    renderPage(counselor);

    expect(await screen.findByLabelText('Six-digit code')).toBeInTheDocument();
    expect(screen.getByText(/waiting@school.test/)).toBeInTheDocument();
    expect(screen.queryByLabelText('New email address')).not.toBeInTheDocument();
  });

  it('shows the server field error against the field it belongs to', async () => {
    vi.mocked(accountApi.requestEmailChange).mockRejectedValue(
      new ApiRequestError('The given data was invalid.', 422, {
        email: ['This email address is already in use.'],
      }),
    );

    const person = renderPage(counselor);

    await stageEmailChange(person, 'taken@school.test');

    // The address is what has to change, so the prompt gets out of the way of the message.
    expect(
      await screen.findByText('This email address is already in use.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByLabelText('New email address')).toBeInTheDocument();
  });

  it('says a password change signs you out before it is submitted', () => {
    renderPage(counselor);

    expect(screen.getByText(/signs you out of every device/i)).toBeInTheDocument();
  });

  it('offers an administrator a single display name, having no counselor profile', () => {
    renderPage(admin);

    expect(screen.getByLabelText('Display name')).toHaveValue('Test Admin');
    expect(screen.queryByLabelText('First name')).not.toBeInTheDocument();
  });
});

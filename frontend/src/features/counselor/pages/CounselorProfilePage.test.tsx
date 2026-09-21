import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  });

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

  it('requires the current password to move the sign-in address', async () => {
    vi.mocked(accountApi.changeEmail).mockResolvedValue({ ...counselor, email: 'new@school.test' });

    const person = renderPage(counselor);

    await person.type(screen.getByLabelText('New email address'), 'new@school.test');
    await person.click(screen.getByRole('button', { name: /update email/i }));

    // Submitted with the password box empty: the form refuses before the request is made.
    expect(accountApi.changeEmail).not.toHaveBeenCalled();
    expect(await screen.findByText('Your current password is required.')).toBeInTheDocument();

    await person.type(screen.getByLabelText('Your current password'), 'CorrectHorse1');
    await person.click(screen.getByRole('button', { name: /update email/i }));

    await waitFor(() =>
      expect(accountApi.changeEmail).toHaveBeenCalledWith({
        email: 'new@school.test',
        current_password: 'CorrectHorse1',
      }),
    );
  });

  it('shows the server field error against the field it belongs to', async () => {
    vi.mocked(accountApi.changeEmail).mockRejectedValue(
      new ApiRequestError('The given data was invalid.', 422, {
        email: ['This email address is already in use.'],
      }),
    );

    const person = renderPage(counselor);

    await person.type(screen.getByLabelText('New email address'), 'taken@school.test');
    await person.type(screen.getByLabelText('Your current password'), 'CorrectHorse1');
    await person.click(screen.getByRole('button', { name: /update email/i }));

    expect(
      await screen.findByText('This email address is already in use.'),
    ).toBeInTheDocument();
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

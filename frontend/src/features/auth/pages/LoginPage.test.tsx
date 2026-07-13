import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { LoginPage } from '@/features/auth/pages/LoginPage';
import { authApi } from '@/services/authApi';
import { useAuthStore } from '@/stores/authStore';
import { ApiRequestError } from '@/types/api';
import type { User } from '@/types/user';

vi.mock('@/services/authApi');

const counselor: User = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Maria Santos',
  email: 'counselor@careerlinkai.test',
  role: 'counselor',
  status: 'active',
  must_change_password: false,
  email_verified_at: null,
  last_login_at: null,
  created_at: null,
};

function renderLoginPage() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    vi.mocked(authApi.login).mockReset();
  });

  it('stores the token and user after a successful sign in', async () => {
    vi.mocked(authApi.login).mockResolvedValue({ user: counselor, token: 'test-token' });

    const user = userEvent.setup();
    renderLoginPage();

    await user.type(screen.getByLabelText(/email/i), 'counselor@careerlinkai.test');
    await user.type(screen.getByLabelText(/password/i), 'ChangeMe123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(useAuthStore.getState().token).toBe('test-token');
    });

    expect(useAuthStore.getState().user).toEqual(counselor);
    expect(authApi.login).toHaveBeenCalledWith({
      email: 'counselor@careerlinkai.test',
      password: 'ChangeMe123',
    });
  });

  it('shows the server message when the credentials are rejected', async () => {
    vi.mocked(authApi.login).mockRejectedValue(
      new ApiRequestError('Invalid credentials.', 401),
    );

    const user = userEvent.setup();
    renderLoginPage();

    await user.type(screen.getByLabelText(/email/i), 'counselor@careerlinkai.test');
    await user.type(screen.getByLabelText(/password/i), 'WrongPassword1');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid credentials.');
    expect(useAuthStore.getState().token).toBeNull();
  });

  it('surfaces the lockout message returned after too many failed attempts', async () => {
    vi.mocked(authApi.login).mockRejectedValue(
      new ApiRequestError('Validation failed.', 429, {
        email: ['Too many failed login attempts. Try again in 900 seconds.'],
      }),
    );

    const user = userEvent.setup();
    renderLoginPage();

    await user.type(screen.getByLabelText(/email/i), 'counselor@careerlinkai.test');
    await user.type(screen.getByLabelText(/password/i), 'WrongPassword1');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/too many failed login attempts/i)).toBeInTheDocument();
  });

  it('validates the form client-side before calling the API', async () => {
    const user = userEvent.setup();
    renderLoginPage();

    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/enter a valid email address/i)).toBeInTheDocument();
    expect(authApi.login).not.toHaveBeenCalled();
  });

  it('has no password field for students — staff only (§38)', () => {
    renderLoginPage();

    expect(screen.getByText(/for counselors and administrators/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/class code/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/username/i)).not.toBeInTheDocument();
  });
});

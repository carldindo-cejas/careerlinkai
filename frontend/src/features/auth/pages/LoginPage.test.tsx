import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { AdminLoginPage } from '@/features/auth/pages/AdminLoginPage';
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

const admin: User = {
  ...counselor,
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Ana Reyes',
  email: 'admin@careerlinkai.test',
  role: 'admin',
};

function renderPage(page: React.ReactElement) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>{page}</MemoryRouter>
    </QueryClientProvider>,
  );
}

async function signIn(email: string, password: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/email/i), email);
  await user.type(screen.getByLabelText(/password/i), password);
  await user.click(screen.getByRole('button', { name: /sign in/i }));
}

describe('LoginPage (counselor login)', () => {
  beforeEach(() => {
    vi.mocked(authApi.login).mockReset();
    vi.mocked(authApi.revoke).mockReset();
  });

  it('stores the token and user after a successful counselor sign in', async () => {
    vi.mocked(authApi.login).mockResolvedValue({ user: counselor, token: 'test-token' });

    renderPage(<LoginPage />);
    await signIn('counselor@careerlinkai.test', 'ChangeMe123');

    await waitFor(() => {
      expect(useAuthStore.getState().token).toBe('test-token');
    });

    expect(useAuthStore.getState().user).toEqual(counselor);
    expect(authApi.login).toHaveBeenCalledWith({
      email: 'counselor@careerlinkai.test',
      password: 'ChangeMe123',
    });
  });

  it('refuses admin credentials and revokes the issued token (§38 — separate doors)', async () => {
    vi.mocked(authApi.login).mockResolvedValue({ user: admin, token: 'admin-token' });
    vi.mocked(authApi.revoke).mockResolvedValue(undefined);

    renderPage(<LoginPage />);
    await signIn('admin@careerlinkai.test', 'AdminPass123');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This login is for counselors only.',
    );
    expect(authApi.revoke).toHaveBeenCalledWith('admin-token');
    expect(useAuthStore.getState().token).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('shows the server message when the credentials are rejected', async () => {
    vi.mocked(authApi.login).mockRejectedValue(
      new ApiRequestError('Invalid credentials.', 401),
    );

    renderPage(<LoginPage />);
    await signIn('counselor@careerlinkai.test', 'WrongPassword1');

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid credentials.');
    expect(useAuthStore.getState().token).toBeNull();
  });

  it('surfaces the lockout message returned after too many failed attempts', async () => {
    vi.mocked(authApi.login).mockRejectedValue(
      new ApiRequestError('Validation failed.', 429, {
        email: ['Too many failed login attempts. Try again in 900 seconds.'],
      }),
    );

    renderPage(<LoginPage />);
    await signIn('counselor@careerlinkai.test', 'WrongPassword1');

    expect(await screen.findByText(/too many failed login attempts/i)).toBeInTheDocument();
  });

  it('validates the form client-side before calling the API', async () => {
    const user = userEvent.setup();
    renderPage(<LoginPage />);

    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/enter a valid email address/i)).toBeInTheDocument();
    expect(authApi.login).not.toHaveBeenCalled();
  });

  it('is the counselor door — no student fields, no admin mention (§38)', () => {
    renderPage(<LoginPage />);

    expect(screen.getByText('Counselor Login')).toBeInTheDocument();
    expect(screen.queryByText(/administrator/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/class code/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/username/i)).not.toBeInTheDocument();
  });
});

describe('AdminLoginPage', () => {
  beforeEach(() => {
    vi.mocked(authApi.login).mockReset();
    vi.mocked(authApi.revoke).mockReset();
  });

  it('signs an administrator in', async () => {
    vi.mocked(authApi.login).mockResolvedValue({ user: admin, token: 'admin-token' });

    renderPage(<AdminLoginPage />);
    await signIn('admin@careerlinkai.test', 'AdminPass123');

    await waitFor(() => {
      expect(useAuthStore.getState().token).toBe('admin-token');
    });
    expect(useAuthStore.getState().user).toEqual(admin);
  });

  it('refuses counselor credentials and revokes the issued token', async () => {
    vi.mocked(authApi.login).mockResolvedValue({ user: counselor, token: 'c-token' });
    vi.mocked(authApi.revoke).mockResolvedValue(undefined);

    renderPage(<AdminLoginPage />);
    await signIn('counselor@careerlinkai.test', 'ChangeMe123');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This login is for administrators only.',
    );
    expect(authApi.revoke).toHaveBeenCalledWith('c-token');
    expect(useAuthStore.getState().token).toBeNull();
  });
});

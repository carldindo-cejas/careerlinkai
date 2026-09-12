import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { GuestRoute } from '@/routes/GuestRoute';
import { authApi } from '@/services/authApi';
import { useAuthStore } from '@/stores/authStore';
import { ApiRequestError } from '@/types/api';
import type { User } from '@/types/user';

vi.mock('@/services/authApi');

const admin: User = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Ana Reyes',
  email: 'admin@careerlinkai.test',
  role: 'admin',
  status: 'active',
  must_change_password: false,
  email_verified_at: null,
  last_login_at: null,
  created_at: null,
};

function renderLogin() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route element={<GuestRoute />}>
            <Route path="/login" element={<h1>Counselor Login</h1>} />
          </Route>
          <Route path="/admin" element={<h1>Admin dashboard</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('GuestRoute', () => {
  beforeEach(() => {
    vi.mocked(authApi.me).mockReset();
  });

  it('shows the sign-in form to someone with no session', () => {
    renderLogin();

    expect(screen.getByRole('heading', { name: 'Counselor Login' })).toBeInTheDocument();
    expect(authApi.me).not.toHaveBeenCalled();
  });

  /**
   * The bug this exists for: a new tab has the persisted token but not the user, and the form
   * used to render — letting a second account sign in over the first.
   */
  it('sends a tab that already holds a live session to its dashboard, never the form', async () => {
    useAuthStore.setState({ token: 'admin-token', user: null });
    vi.mocked(authApi.me).mockResolvedValue(admin);

    renderLogin();

    expect(screen.queryByRole('heading', { name: 'Counselor Login' })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Admin dashboard' })).toBeInTheDocument();
  });

  it('shows the form when the stored token is rejected', async () => {
    useAuthStore.setState({ token: 'revoked-token', user: null });
    vi.mocked(authApi.me).mockRejectedValue(new ApiRequestError('Unauthenticated.', 401));

    renderLogin();

    expect(await screen.findByRole('heading', { name: 'Counselor Login' })).toBeInTheDocument();
  });
});

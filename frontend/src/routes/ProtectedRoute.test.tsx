import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { ProtectedRoute } from '@/routes/ProtectedRoute';
import { authApi } from '@/services/authApi';
import { useAuthStore } from '@/stores/authStore';
import { ApiRequestError } from '@/types/api';
import type { User } from '@/types/user';

vi.mock('@/services/authApi');

/**
 * **What counts as being signed out** (incident 2026-09-18).
 *
 * This guard used to send a student to the sign-in screen on *any* failure of `/auth/me` — a 500,
 * a 429, a phone that lost school wifi for a second — because `isError` did not distinguish a
 * rejected token from a request that did not arrive. That is half of why the incident read as a
 * capacity problem: under load, transient failures rose, and every one of them presented to a
 * student as being thrown out of the system. They then signed in again, which ended somebody
 * else's session, which put *that* student on the sign-in screen.
 *
 * A 401 still ends the session, and must: the http client clears the token, which lands in the
 * `!token` branch. Everything else keeps the session and says so.
 */

const student: User = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Juan Dela Cruz',
  email: null,
  role: 'student',
  status: 'active',
  must_change_password: false,
  email_verified_at: null,
  last_login_at: null,
  created_at: null,
};

function renderGuarded() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/student']}>
        <Routes>
          <Route element={<ProtectedRoute allow={['student']} />}>
            <Route path="/student" element={<h1>Student dashboard</h1>} />
          </Route>
          <Route path="/join" element={<h1>Join your class</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProtectedRoute — a failed request is not a sign-out', () => {
  it('keeps the student signed in when the server cannot be reached', async () => {
    useAuthStore.setState({ token: 'student-token' });
    // Status 0 is what the http client reports for a request that never arrived.
    vi.mocked(authApi.me).mockRejectedValue(new ApiRequestError('Network Error', 0));

    renderGuarded();

    expect(await screen.findByRole('alert')).toHaveTextContent(/still signed in/i);
    expect(screen.queryByText('Join your class')).not.toBeInTheDocument();
    expect(useAuthStore.getState().token).toBe('student-token');
  });

  it('keeps the student signed in when the server is rate limiting them', async () => {
    useAuthStore.setState({ token: 'student-token' });
    vi.mocked(authApi.me).mockRejectedValue(new ApiRequestError('Too many requests.', 429));

    renderGuarded();

    expect(await screen.findByRole('alert')).toHaveTextContent(/still signed in/i);
    expect(useAuthStore.getState().token).toBe('student-token');
  });

  it('recovers without a sign-in when the next attempt succeeds', async () => {
    useAuthStore.setState({ token: 'student-token' });
    vi.mocked(authApi.me).mockRejectedValue(new ApiRequestError('Service unavailable.', 503));

    renderGuarded();
    await screen.findByRole('alert');

    // The outage ends. Retrying must put the student back where they were, not at a sign-in form.
    vi.mocked(authApi.me).mockResolvedValue(student);
    await userEvent.setup().click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByText('Student dashboard')).toBeInTheDocument();
  });

  it('still sends a student away once the token itself is rejected', async () => {
    // A 401 is cleared by the http client interceptor, which this test stands in for — what is
    // asserted here is that the guard follows a cleared token to the door.
    useAuthStore.setState({ token: null });
    vi.mocked(authApi.me).mockRejectedValue(new ApiRequestError('Unauthenticated.', 401));

    renderGuarded();

    await waitFor(() => expect(screen.getByText('Join your class')).toBeInTheDocument());
  });
});

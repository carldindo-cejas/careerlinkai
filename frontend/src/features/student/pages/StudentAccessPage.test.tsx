import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { StudentAccessPage } from '@/features/student/pages/StudentAccessPage';
import { studentAccessApi } from '@/services/studentAccessApi';
import { useAuthStore } from '@/stores/authStore';
import { useStudentClassStore } from '@/stores/studentClassStore';
import { ApiRequestError } from '@/types/api';
import type { User } from '@/types/user';

vi.mock('@/services/studentAccessApi');

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

const classRoom = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Grade 12 STEM A',
  academic_year: '2026-2027',
  grade_level: 'Grade 12',
};

/** The one message every failed join returns, whatever actually went wrong (§38). */
const GENERIC_ERROR = 'The class code or username is incorrect.';

function renderAccessPage() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <StudentAccessPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function submit(code: string, username: string) {
  const user = userEvent.setup();

  await user.type(screen.getByLabelText(/class code/i), code);
  await user.type(screen.getByLabelText(/username/i), username);
  await user.click(screen.getByRole('button', { name: /sign in/i }));
}

describe('StudentAccessPage', () => {
  beforeEach(() => {
    vi.mocked(studentAccessApi.join).mockReset();
  });

  it('signs a student in with a class code and a username, and remembers the class', async () => {
    vi.mocked(studentAccessApi.join).mockResolvedValue({
      user: student,
      class: classRoom,
      username: 'juan.delacruz',
      token: 'student-token',
    });

    renderAccessPage();
    await submit('HVJE-5977', 'juan.delacruz');

    await waitFor(() => {
      expect(useAuthStore.getState().token).toBe('student-token');
    });

    expect(useAuthStore.getState().user).toEqual(student);

    // Phase 1 has no endpoint a student can call to ask which class they are in, so the
    // join response is the only source of it.
    expect(useStudentClassStore.getState().classRoom).toEqual(classRoom);
    expect(useStudentClassStore.getState().username).toBe('juan.delacruz');

    expect(studentAccessApi.join).toHaveBeenCalledWith({
      class_code: 'HVJE-5977',
      username: 'juan.delacruz',
    });
  });

  /**
   * The §38 control that keeps this endpoint from being used to enumerate a roster. The
   * server returns one identical 401 for all six failure modes, and the UI must not
   * helpfully "improve" on it by guessing which one it was.
   */
  it('shows the generic failure verbatim and never explains which part was wrong', async () => {
    vi.mocked(studentAccessApi.join).mockRejectedValue(new ApiRequestError(GENERIC_ERROR, 401));

    renderAccessPage();
    await submit('HVJE-5977', 'nobody.here');

    expect(await screen.findByRole('alert')).toHaveTextContent(GENERIC_ERROR);

    // Nothing on the screen may hint at *which* of the two was wrong.
    expect(screen.queryByText(/no such class/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/username not found/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/expired/i)).not.toBeInTheDocument();

    expect(useAuthStore.getState().token).toBeNull();
  });

  it('surfaces the throttle message after too many failed attempts', async () => {
    vi.mocked(studentAccessApi.join).mockRejectedValue(
      new ApiRequestError('Validation failed.', 429, {
        class_code: ['Too many failed attempts. Try again in 900 seconds.'],
      }),
    );

    renderAccessPage();
    await submit('HVJE-5977', 'juan.delacruz');

    expect(await screen.findByText(/too many failed attempts/i)).toBeInTheDocument();
  });

  it('sends nothing to the server until both fields are filled in', async () => {
    const user = userEvent.setup();
    renderAccessPage();

    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/enter your class code/i)).toBeInTheDocument();
    expect(studentAccessApi.join).not.toHaveBeenCalled();
  });

  /**
   * The invariant this whole screen exists to hold: a student has no password, so there is
   * nowhere on this page to type one — and no "forgot password" link either, since there is
   * nothing to forget (§38).
   */
  it('has no password field anywhere on the page', () => {
    const { container } = renderAccessPage();

    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(screen.queryByText(/forgot/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
  });
});

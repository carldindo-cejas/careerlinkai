import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { CounselorSignupPage } from '@/features/auth/pages/CounselorSignupPage';
import { authApi } from '@/services/authApi';
import { ApiRequestError } from '@/types/api';

vi.mock('@/services/authApi');

/**
 * Counselor self-registration (migration 0034).
 *
 * Three things are worth pinning on this screen, and none of them is the form markup.
 *
 *   1. **A closed deployment shows the closure, not a form.** The server 403s every submission
 *      while registration is off, so a form rendered anyway is a form whose only possible outcome
 *      is an error — and the reader has no way to tell that from a fault in the app.
 *   2. **The code step is reached whether or not a code was issued.** The API answers a registered
 *      and an unregistered address identically (§38), and the client must not undo that by
 *      branching on the empty acknowledgement a taken address produces. A screen that skipped
 *      ahead — or said "we couldn't find that address" — would be the enumeration oracle the API
 *      refuses to be, rebuilt in the UI.
 *   3. **The password rules are enforced before the round trip.** They mirror the server's §38
 *      policy, which is the control; this is the convenience, and it is worth one test that it
 *      actually fires.
 */

function renderPage() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <CounselorSignupPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return userEvent.setup();
}

/** Fill the form with something valid, leaving the caller to override whatever it is testing. */
async function fillForm(user: ReturnType<typeof userEvent.setup>, email = 'liza@school.test') {
  await user.type(screen.getByLabelText(/first name/i), 'Liza');
  await user.type(screen.getByLabelText(/last name/i), 'Manalo');
  await user.type(screen.getByLabelText(/^email$/i), email);
  await user.type(screen.getByLabelText(/^password$/i), 'ChosenByThem1');
  await user.type(screen.getByLabelText(/confirm password/i), 'ChosenByThem1');
}

describe('CounselorSignupPage', () => {
  beforeEach(() => {
    vi.mocked(authApi.signupStatus)
      .mockReset()
      .mockResolvedValue({ counselor_signup_open: true });
    vi.mocked(authApi.counselorSignup).mockReset().mockResolvedValue(null);
    vi.mocked(authApi.verifySignupCode).mockReset().mockResolvedValue();
    vi.mocked(authApi.resendSignupCode).mockReset().mockResolvedValue(null);
  });

  it('renders the closure instead of a form when registration is off', async () => {
    vi.mocked(authApi.signupStatus).mockResolvedValue({ counselor_signup_open: false });

    renderPage();

    expect(await screen.findByText(/sign-up is closed/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^email$/i)).not.toBeInTheDocument();
    expect(authApi.counselorSignup).not.toHaveBeenCalled();
  });

  /** A status check that fails is treated exactly as a closed one — see the page's own comment. */
  it('renders the closure when the status cannot be read', async () => {
    vi.mocked(authApi.signupStatus).mockRejectedValue(new ApiRequestError('Offline.', 500));

    renderPage();

    expect(await screen.findByText(/sign-up is closed/i)).toBeInTheDocument();
  });

  it('submits the details and moves to the code step', async () => {
    const user = renderPage();

    await screen.findByLabelText(/^email$/i);
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /send verification code/i }));

    expect(await screen.findByLabelText(/verification code/i)).toBeInTheDocument();
    expect(authApi.counselorSignup).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'liza@school.test',
        first_name: 'Liza',
        last_name: 'Manalo',
        password: 'ChosenByThem1',
        password_confirmation: 'ChosenByThem1',
      }),
    );
  });

  /**
   * **The anti-enumeration test.** A registered address produces exactly the acknowledgement an
   * unregistered one does — `null` — and the screen must go on to the code step regardless, saying
   * nothing that distinguishes the two.
   */
  it('shows the same code step, and no "already registered" hint, for an address that is taken', async () => {
    vi.mocked(authApi.counselorSignup).mockResolvedValue(null);

    const user = renderPage();

    await screen.findByLabelText(/^email$/i);
    await fillForm(user, 'taken@school.test');
    await user.click(screen.getByRole('button', { name: /send verification code/i }));

    await screen.findByLabelText(/verification code/i);

    expect(screen.getByText(/taken@school.test/)).toBeInTheDocument();
    expect(screen.queryByText(/already/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not found|no account|unregistered/i)).not.toBeInTheDocument();
  });

  it('enforces the password policy before calling the API', async () => {
    const user = renderPage();

    await screen.findByLabelText(/^email$/i);
    await user.type(screen.getByLabelText(/first name/i), 'Liza');
    await user.type(screen.getByLabelText(/last name/i), 'Manalo');
    await user.type(screen.getByLabelText(/^email$/i), 'liza@school.test');
    await user.type(screen.getByLabelText(/^password$/i), 'short');
    await user.type(screen.getByLabelText(/confirm password/i), 'short');
    await user.click(screen.getByRole('button', { name: /send verification code/i }));

    // The exact error string, not a loose regex: the field's own hint also says "At least 10
    // characters…", so anything less specific matches the help text whether or not the rule fired.
    expect(await screen.findByText('Use at least 10 characters.')).toBeInTheDocument();
    expect(authApi.counselorSignup).not.toHaveBeenCalled();
  });

  it('catches a mismatched confirmation before calling the API', async () => {
    const user = renderPage();

    await screen.findByLabelText(/^email$/i);
    await user.type(screen.getByLabelText(/first name/i), 'Liza');
    await user.type(screen.getByLabelText(/last name/i), 'Manalo');
    await user.type(screen.getByLabelText(/^email$/i), 'liza@school.test');
    await user.type(screen.getByLabelText(/^password$/i), 'ChosenByThem1');
    await user.type(screen.getByLabelText(/confirm password/i), 'SomethingElse1');
    await user.click(screen.getByRole('button', { name: /send verification code/i }));

    expect(await screen.findByText(/passwords do not match/i)).toBeInTheDocument();
    expect(authApi.counselorSignup).not.toHaveBeenCalled();
  });

  it('verifies the code and sends them to sign in', async () => {
    const user = renderPage();

    await screen.findByLabelText(/^email$/i);
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /send verification code/i }));

    const codeField = await screen.findByLabelText(/verification code/i);

    await user.type(codeField, '123456');
    await user.click(screen.getByRole('button', { name: /verify and finish/i }));

    await waitFor(() =>
      expect(authApi.verifySignupCode).toHaveBeenCalledWith('liza@school.test', '123456'),
    );
  });

  it('surfaces a refused code without leaving the step', async () => {
    vi.mocked(authApi.verifySignupCode).mockRejectedValue(
      new ApiRequestError('Validation failed.', 422, {
        code: ['That code is invalid or has expired. Ask for a new one.'],
      }),
    );

    const user = renderPage();

    await screen.findByLabelText(/^email$/i);
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /send verification code/i }));

    await user.type(await screen.findByLabelText(/verification code/i), '000000');
    await user.click(screen.getByRole('button', { name: /verify and finish/i }));

    expect(await screen.findByText(/invalid or has expired/i)).toBeInTheDocument();
    // Still on the code step, with the field intact — a refused code is a retry, not a restart.
    expect(screen.getByLabelText(/verification code/i)).toBeInTheDocument();
  });

  /** Six digits or nothing: submitting a partial code would only spend a guess against the lockout. */
  it('keeps the verify button disabled until six digits are entered', async () => {
    const user = renderPage();

    await screen.findByLabelText(/^email$/i);
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /send verification code/i }));

    const codeField = await screen.findByLabelText(/verification code/i);

    await user.type(codeField, '123');
    expect(screen.getByRole('button', { name: /verify and finish/i })).toBeDisabled();

    await user.type(codeField, '456');
    expect(screen.getByRole('button', { name: /verify and finish/i })).toBeEnabled();
  });
});

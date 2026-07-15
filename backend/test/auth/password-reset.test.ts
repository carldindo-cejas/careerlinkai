import { describe, expect, it } from 'vitest';

import {
  api,
  auditActionsFor,
  backdateResetToken,
  countTokensFor,
  createStaffUser,
  createStudentUser,
  login,
} from '../helpers';

/**
 * POST /auth/forgot-password and POST /auth/reset-password (§20, deviation D7).
 *
 * v1 has no email channel (§5), so the route returns the reset token in the body **only**
 * when `APP_ENV === 'local'` — which is what makes the flow testable end to end here. The
 * acknowledgement message itself is identical either way, so the endpoint is never an
 * account-enumeration oracle.
 */

const RESET_PASSWORD = 'ResetPass123';
const GENERIC_ACK = 'If that email is registered, a password reset has been prepared for it.';

async function requestReset(email: string): Promise<string> {
  const response = await api('POST', '/auth/forgot-password', { body: { email } });

  expect(response.status).toBe(200);

  return response.body.data.reset_token as string;
}

describe('POST /auth/forgot-password', () => {
  it('issues a token for a known staff email', async () => {
    const counselor = await createStaffUser();

    const response = await api('POST', '/auth/forgot-password', {
      body: { email: counselor.email },
    });

    expect(response.status).toBe(200);
    expect(response.body.message).toBe(GENERIC_ACK);
    expect(typeof response.body.data.reset_token).toBe('string');
  });

  it('gives an unknown email the identical acknowledgement, with no token', async () => {
    const response = await api('POST', '/auth/forgot-password', {
      body: { email: 'nobody@school.test' },
    });

    expect(response.status).toBe(200);
    expect(response.body.message).toBe(GENERIC_ACK);
    expect(response.body.data).toBeNull();
  });

  it('gives a student the same acknowledgement — there is no password to reset', async () => {
    const student = await createStudentUser();

    const response = await api('POST', '/auth/forgot-password', {
      body: { email: student.email },
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toBeNull();
  });

  it('invalidates the previous token when a second reset is requested', async () => {
    const counselor = await createStaffUser();

    const first = await requestReset(counselor.email);
    const second = await requestReset(counselor.email);

    expect(first).not.toBe(second);

    const withFirst = await api('POST', '/auth/reset-password', {
      body: {
        email: counselor.email,
        token: first,
        password: RESET_PASSWORD,
        password_confirmation: RESET_PASSWORD,
      },
    });

    expect(withFirst.status).toBe(422);
  });

  it('audits the request', async () => {
    const counselor = await createStaffUser();

    await requestReset(counselor.email);

    await expect(auditActionsFor(counselor.id)).resolves.toContain(
      'STAFF_PASSWORD_RESET_REQUESTED',
    );
  });
});

describe('POST /auth/reset-password', () => {
  it('sets the new password and lets the user sign in with it', async () => {
    const counselor = await createStaffUser();
    const token = await requestReset(counselor.email);

    const response = await api('POST', '/auth/reset-password', {
      body: {
        email: counselor.email,
        token,
        password: RESET_PASSWORD,
        password_confirmation: RESET_PASSWORD,
      },
    });

    expect(response.status).toBe(200);

    const withNew = await api('POST', '/auth/login', {
      body: { email: counselor.email, password: RESET_PASSWORD },
    });
    const withOld = await api('POST', '/auth/login', {
      body: { email: counselor.email, password: counselor.password },
    });

    expect(withNew.status).toBe(200);
    expect(withOld.status).toBe(401);
  });

  it('revokes every existing session', async () => {
    const counselor = await createStaffUser();
    const liveSession = await login(counselor);
    const token = await requestReset(counselor.email);

    await api('POST', '/auth/reset-password', {
      body: {
        email: counselor.email,
        token,
        password: RESET_PASSWORD,
        password_confirmation: RESET_PASSWORD,
      },
    });

    await expect(countTokensFor(counselor.id)).resolves.toBe(0);
    await expect(api('GET', '/auth/me', { token: liveSession })).resolves.toMatchObject({
      status: 401,
    });
  });

  it('is single-use', async () => {
    const counselor = await createStaffUser();
    const token = await requestReset(counselor.email);

    const body = {
      email: counselor.email,
      token,
      password: RESET_PASSWORD,
      password_confirmation: RESET_PASSWORD,
    };

    await expect(api('POST', '/auth/reset-password', { body })).resolves.toMatchObject({
      status: 200,
    });

    const replay = await api('POST', '/auth/reset-password', { body });

    expect(replay.status).toBe(422);
    expect(replay.body.errors.token).toEqual([
      'This password reset link is invalid or has expired.',
    ]);
  });

  it('rejects a token past its 60-minute TTL', async () => {
    const counselor = await createStaffUser();
    const token = await requestReset(counselor.email);

    await backdateResetToken(counselor.email, 61);

    const response = await api('POST', '/auth/reset-password', {
      body: {
        email: counselor.email,
        token,
        password: RESET_PASSWORD,
        password_confirmation: RESET_PASSWORD,
      },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.token).toEqual([
      'This password reset link is invalid or has expired.',
    ]);
  });

  it('rejects a forged token', async () => {
    const counselor = await createStaffUser();

    await requestReset(counselor.email);

    const response = await api('POST', '/auth/reset-password', {
      body: {
        email: counselor.email,
        token: 'forged-token-value',
        password: RESET_PASSWORD,
        password_confirmation: RESET_PASSWORD,
      },
    });

    expect(response.status).toBe(422);
  });

  it('clears an active lockout, so a locked-out user can recover by resetting', async () => {
    const counselor = await createStaffUser();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await api('POST', '/auth/login', {
        body: { email: counselor.email, password: 'WrongPassword9' },
      });
    }

    await expect(
      api('POST', '/auth/login', { body: { email: counselor.email, password: counselor.password } }),
    ).resolves.toMatchObject({ status: 429 });

    const token = await requestReset(counselor.email);

    await api('POST', '/auth/reset-password', {
      body: {
        email: counselor.email,
        token,
        password: RESET_PASSWORD,
        password_confirmation: RESET_PASSWORD,
      },
    });

    const response = await api('POST', '/auth/login', {
      body: { email: counselor.email, password: RESET_PASSWORD },
    });

    expect(response.status).toBe(200);
  });

  it('enforces the password policy on the new password', async () => {
    const counselor = await createStaffUser();
    const token = await requestReset(counselor.email);

    const response = await api('POST', '/auth/reset-password', {
      body: {
        email: counselor.email,
        token,
        password: 'weak',
        password_confirmation: 'weak',
      },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.password).toContain('Use at least 10 characters.');
  });

  it('audits the completion', async () => {
    const counselor = await createStaffUser();
    const token = await requestReset(counselor.email);

    await api('POST', '/auth/reset-password', {
      body: {
        email: counselor.email,
        token,
        password: RESET_PASSWORD,
        password_confirmation: RESET_PASSWORD,
      },
    });

    await expect(auditActionsFor(counselor.id)).resolves.toContain(
      'STAFF_PASSWORD_RESET_COMPLETED',
    );
  });
});

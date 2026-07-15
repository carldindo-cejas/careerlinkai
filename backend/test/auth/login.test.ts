import { describe, expect, it } from 'vitest';

import {
  VALID_PASSWORD,
  api,
  auditActionsFor,
  createStaffUser,
  createStudentUser,
  findAuditRowByEmail,
  findUser,
  softDeleteUser,
} from '../helpers';

/**
 * POST /auth/login (FULLPLAN §20, §38).
 *
 * The contract the frontend's LoginPage test pins: a 200 carries `data.user` + `data.token`;
 * every rejected credential is an indistinguishable 401; the lockout is a 429 whose detail
 * sits under `errors.email`.
 */

describe('POST /auth/login', () => {
  it('issues a token and returns the serialized user', async () => {
    const admin = await createStaffUser({ role: 'admin' });

    const response = await api('POST', '/auth/login', {
      body: { email: admin.email, password: admin.password },
    });

    expect(response.status).toBe(200);
    expect(response.body.message).toBe('Signed in successfully.');
    expect(response.body.data.user).toMatchObject({
      id: admin.id,
      email: admin.email,
      role: 'admin',
      status: 'active',
      must_change_password: false,
    });
    expect(typeof response.body.data.token).toBe('string');
    expect(response.body.data.token.length).toBeGreaterThanOrEqual(40);
  });

  it('never serializes the password hash', async () => {
    const admin = await createStaffUser({ role: 'admin' });

    const response = await api('POST', '/auth/login', {
      body: { email: admin.email, password: admin.password },
    });

    expect(response.body.data.user).not.toHaveProperty('password');
    expect(response.body.data.user).not.toHaveProperty('deleted_at');
    expect(JSON.stringify(response.body)).not.toContain('pbkdf2');
  });

  it('attaches the counselor profile for a counselor, and not for an admin', async () => {
    const counselor = await createStaffUser({ role: 'counselor' });
    const admin = await createStaffUser({ role: 'admin' });

    const counselorLogin = await api('POST', '/auth/login', {
      body: { email: counselor.email, password: counselor.password },
    });
    const adminLogin = await api('POST', '/auth/login', {
      body: { email: admin.email, password: admin.password },
    });

    expect(counselorLogin.body.data.user.counselor_profile).toMatchObject({
      first_name: 'Test',
      last_name: 'Counselor',
    });
    expect(adminLogin.body.data.user).not.toHaveProperty('counselor_profile');
  });

  it('is case-insensitive on the email', async () => {
    const admin = await createStaffUser({ role: 'admin', email: 'boss@school.test' });

    const response = await api('POST', '/auth/login', {
      body: { email: 'BOSS@School.test', password: admin.password },
    });

    expect(response.status).toBe(200);
  });

  it('records the login time', async () => {
    const admin = await createStaffUser({ role: 'admin' });

    expect((await findUser(admin.id))?.lastLoginAt).toBeNull();

    await api('POST', '/auth/login', {
      body: { email: admin.email, password: admin.password },
    });

    expect((await findUser(admin.id))?.lastLoginAt).not.toBeNull();
  });

  it('writes a STAFF_LOGIN_SUCCESS audit entry', async () => {
    const admin = await createStaffUser({ role: 'admin' });

    await api('POST', '/auth/login', {
      body: { email: admin.email, password: admin.password },
    });

    await expect(auditActionsFor(admin.id)).resolves.toContain('STAFF_LOGIN_SUCCESS');
  });

  it('surfaces must_change_password so the frontend can force the rotation', async () => {
    const counselor = await createStaffUser({ mustChangePassword: true });

    const response = await api('POST', '/auth/login', {
      body: { email: counselor.email, password: counselor.password },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.user.must_change_password).toBe(true);
  });
});

describe('POST /auth/login — rejections', () => {
  it('returns the same generic 401 for a wrong password and an unknown email', async () => {
    const admin = await createStaffUser({ role: 'admin' });

    const wrongPassword = await api('POST', '/auth/login', {
      body: { email: admin.email, password: 'WrongPassword9' },
    });
    const unknownEmail = await api('POST', '/auth/login', {
      body: { email: 'nobody@school.test', password: VALID_PASSWORD },
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
    expect(wrongPassword.body.message).toBe('Invalid credentials.');
  });

  it('refuses a student — passwordless accounts can never come through the staff flow', async () => {
    const student = await createStudentUser();

    const response = await api('POST', '/auth/login', {
      body: { email: student.email, password: VALID_PASSWORD },
    });

    expect(response.status).toBe(401);
    expect(response.body.message).toBe('Invalid credentials.');
  });

  it('refuses a soft-deleted user', async () => {
    const admin = await createStaffUser({ role: 'admin' });

    await softDeleteUser(admin.id);

    const response = await api('POST', '/auth/login', {
      body: { email: admin.email, password: admin.password },
    });

    expect(response.status).toBe(401);
  });

  it('tells a correct-credential holder why a non-active account is refused (403, not 401)', async () => {
    const suspended = await createStaffUser({ status: 'suspended' });

    const response = await api('POST', '/auth/login', {
      body: { email: suspended.email, password: suspended.password },
    });

    expect(response.status).toBe(403);
    expect(response.body.message).toBe('Your account is not active. Contact an administrator.');
  });

  it('audits a failed attempt even when the email matches no account', async () => {
    // The audit trail is the primary security-monitoring surface (§38), so an attempt
    // against an address that resolves to nobody still has to leave a record — with a NULL
    // user_id, because there was never a user to attribute it to.
    await api('POST', '/auth/login', {
      body: { email: 'ghost@school.test', password: VALID_PASSWORD },
      ip: '198.51.100.7',
    });

    const failure = await findAuditRowByEmail('STAFF_LOGIN_FAILED', 'ghost@school.test');

    expect(failure).toBeDefined();
    expect(failure?.userId).toBeNull();
    expect(failure?.ipAddress).toBe('198.51.100.7');
  });
});

describe('POST /auth/login — lockout (§38: 5 failures, 15 minutes)', () => {
  it('locks the account on the fifth failure and keeps refusing the right password', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const wrong = { email: admin.email, password: 'WrongPassword9' };

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await api('POST', '/auth/login', { body: wrong });

      expect(response.status).toBe(401);
    }

    const fifth = await api('POST', '/auth/login', { body: wrong });

    expect(fifth.status).toBe(429);
    expect(fifth.body.message).toBe('Validation failed.');
    expect(fifth.body.errors.email[0]).toMatch(/Too many failed login attempts/);

    // The lock is on the account, not on the guess: the correct password is refused too.
    const correct = await api('POST', '/auth/login', {
      body: { email: admin.email, password: admin.password },
    });

    expect(correct.status).toBe(429);
  });

  it('charges failures only — a success inside the window clears the counter', async () => {
    const admin = await createStaffUser({ role: 'admin' });

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await api('POST', '/auth/login', {
        body: { email: admin.email, password: 'WrongPassword9' },
      });
    }

    const success = await api('POST', '/auth/login', {
      body: { email: admin.email, password: admin.password },
    });

    expect(success.status).toBe(200);

    // Counter cleared: four fresh failures are once again below the limit.
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await api('POST', '/auth/login', {
        body: { email: admin.email, password: 'WrongPassword9' },
      });

      expect(response.status).toBe(401);
    }
  });

  it('keys the lockout by email, so one account cannot lock another out', async () => {
    const target = await createStaffUser({ role: 'admin' });
    const bystander = await createStaffUser({ role: 'counselor' });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await api('POST', '/auth/login', {
        body: { email: target.email, password: 'WrongPassword9' },
      });
    }

    const response = await api('POST', '/auth/login', {
      body: { email: bystander.email, password: bystander.password },
    });

    expect(response.status).toBe(200);
  });
});

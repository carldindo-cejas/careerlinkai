import { describe, expect, it } from 'vitest';

import {
  VALID_PASSWORD,
  api,
  auditActionsFor,
  countTokensFor,
  createStaffUser,
  findUser,
  login,
} from '../helpers';

/**
 * POST /auth/change-password (§38).
 *
 * This endpoint is also the *activation* step for an admin-issued temporary password
 * (§13.1) — clearing `must_change_password` is not a side effect, it is the point.
 */

const NEW_PASSWORD = 'BrandNewPass2';

describe('POST /auth/change-password', () => {
  it('rotates the password and clears must_change_password', async () => {
    const counselor = await createStaffUser({ mustChangePassword: true });
    const token = await login(counselor);

    const response = await api('POST', '/auth/change-password', {
      token,
      body: {
        current_password: counselor.password,
        password: NEW_PASSWORD,
        password_confirmation: NEW_PASSWORD,
      },
    });

    expect(response.status).toBe(200);
    expect((await findUser(counselor.id))?.mustChangePassword).toBe(false);

    const withNew = await api('POST', '/auth/login', {
      body: { email: counselor.email, password: NEW_PASSWORD },
    });

    expect(withNew.status).toBe(200);
    expect(withNew.body.data.user.must_change_password).toBe(false);
  });

  it('refuses the old password afterwards', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);

    await api('POST', '/auth/change-password', {
      token,
      body: {
        current_password: counselor.password,
        password: NEW_PASSWORD,
        password_confirmation: NEW_PASSWORD,
      },
    });

    const withOld = await api('POST', '/auth/login', {
      body: { email: counselor.email, password: counselor.password },
    });

    expect(withOld.status).toBe(401);
  });

  it('revokes every session, including the one that made the request', async () => {
    // A rotated credential must not leave old sessions alive (§38) — which is why the
    // frontend signs itself out and re-authenticates after this call.
    const counselor = await createStaffUser();
    const laptop = await login(counselor);
    const phone = await login(counselor);

    await api('POST', '/auth/change-password', {
      token: laptop,
      body: {
        current_password: counselor.password,
        password: NEW_PASSWORD,
        password_confirmation: NEW_PASSWORD,
      },
    });

    await expect(countTokensFor(counselor.id)).resolves.toBe(0);
    await expect(api('GET', '/auth/me', { token: laptop })).resolves.toMatchObject({
      status: 401,
    });
    await expect(api('GET', '/auth/me', { token: phone })).resolves.toMatchObject({
      status: 401,
    });
  });

  it('writes a STAFF_PASSWORD_CHANGED audit entry', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);

    await api('POST', '/auth/change-password', {
      token,
      body: {
        current_password: counselor.password,
        password: NEW_PASSWORD,
        password_confirmation: NEW_PASSWORD,
      },
    });

    await expect(auditActionsFor(counselor.id)).resolves.toContain('STAFF_PASSWORD_CHANGED');
  });

  it('requires authentication', async () => {
    const response = await api('POST', '/auth/change-password', {
      body: {
        current_password: VALID_PASSWORD,
        password: NEW_PASSWORD,
        password_confirmation: NEW_PASSWORD,
      },
    });

    expect(response.status).toBe(401);
  });
});

describe('POST /auth/change-password — rejections', () => {
  it('rejects a wrong current password against the current_password field', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);

    const response = await api('POST', '/auth/change-password', {
      token,
      body: {
        current_password: 'NotMyPassword7',
        password: NEW_PASSWORD,
        password_confirmation: NEW_PASSWORD,
      },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.current_password).toEqual(['Your current password is incorrect.']);
    expect((await findUser(counselor.id))?.password).not.toBeNull();
  });

  it('enforces the §38 password policy on the new password', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);

    const response = await api('POST', '/auth/change-password', {
      token,
      body: {
        current_password: counselor.password,
        password: 'short',
        password_confirmation: 'short',
      },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.password).toContain('Use at least 10 characters.');
    expect(response.body.errors.password).toContain('Include at least one uppercase letter.');
    expect(response.body.errors.password).toContain('Include at least one number.');
  });

  it('rejects a confirmation that does not match', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);

    const response = await api('POST', '/auth/change-password', {
      token,
      body: {
        current_password: counselor.password,
        password: NEW_PASSWORD,
        password_confirmation: 'DifferentPass3',
      },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.password_confirmation).toEqual(['The passwords do not match.']);
  });

  it('refuses to “rotate” a password to the same value', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);

    const response = await api('POST', '/auth/change-password', {
      token,
      body: {
        current_password: counselor.password,
        password: counselor.password,
        password_confirmation: counselor.password,
      },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.password).toEqual([
      'Choose a password different from your current one.',
    ]);
  });
});

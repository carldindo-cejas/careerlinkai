import { describe, expect, it } from 'vitest';

import {
  api,
  auditActionsFor,
  countTokensFor,
  createStaffUser,
  expireTokensFor,
  login,
  setUserStatus,
  softDeleteUser,
} from '../helpers';

/**
 * GET /auth/me, POST /auth/logout, and the `authenticate` middleware behind them (§38).
 *
 * The middleware's job is the part worth pinning: a live token is not enough on its own —
 * the *user* must still be active, which is what stops a suspended account from working
 * until its token happens to expire (v1.2).
 */

describe('GET /auth/me', () => {
  it('returns the authenticated user', async () => {
    const counselor = await createStaffUser({ role: 'counselor' });
    const token = await login(counselor);

    const response = await api('GET', '/auth/me', { token });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: counselor.id,
      email: counselor.email,
      role: 'counselor',
    });
    expect(response.body.data.counselor_profile).toBeDefined();
    expect(response.body.data).not.toHaveProperty('password');
  });

  it('is reachable while must_change_password is still set', async () => {
    // The flagged user needs exactly this endpoint to bootstrap the frontend before they
    // are allowed anywhere else (see ensure-password-changed).
    const flagged = await createStaffUser({ mustChangePassword: true });
    const token = await login(flagged);

    const response = await api('GET', '/auth/me', { token });

    expect(response.status).toBe(200);
    expect(response.body.data.must_change_password).toBe(true);
  });
});

describe('the authenticate middleware (§38)', () => {
  it('rejects a request with no Authorization header', async () => {
    const response = await api('GET', '/auth/me');

    expect(response.status).toBe(401);
    expect(response.body.message).toBe('Unauthenticated.');
  });

  it('rejects a token that was never issued', async () => {
    const response = await api('GET', '/auth/me', { token: 'not-a-real-token' });

    expect(response.status).toBe(401);
  });

  it('rejects an expired token and deletes the row, so it cannot be replayed', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);

    await expireTokensFor(admin.id);

    const response = await api('GET', '/auth/me', { token });

    expect(response.status).toBe(401);
    await expect(countTokensFor(admin.id)).resolves.toBe(0);
  });

  it('rejects a live token whose user is no longer active', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);

    await expect(api('GET', '/auth/me', { token })).resolves.toMatchObject({ status: 200 });

    await setUserStatus(counselor.id, 'suspended');

    const response = await api('GET', '/auth/me', { token });

    expect(response.status).toBe(401);
  });

  it('rejects a live token whose user was soft-deleted', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);

    await softDeleteUser(counselor.id);

    const response = await api('GET', '/auth/me', { token });

    expect(response.status).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  it('revokes the presented token', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);

    const response = await api('POST', '/auth/logout', { token });

    expect(response.status).toBe(200);
    expect(response.body.message).toBe('Signed out successfully.');

    const afterLogout = await api('GET', '/auth/me', { token });

    expect(afterLogout.status).toBe(401);
  });

  it('revokes only that token, leaving the user’s other sessions alive', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const phone = await login(admin);
    const laptop = await login(admin);

    await api('POST', '/auth/logout', { token: phone });

    await expect(api('GET', '/auth/me', { token: phone })).resolves.toMatchObject({
      status: 401,
    });
    await expect(api('GET', '/auth/me', { token: laptop })).resolves.toMatchObject({
      status: 200,
    });
  });

  it('writes a STAFF_LOGOUT audit entry', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);

    await api('POST', '/auth/logout', { token });

    await expect(auditActionsFor(admin.id)).resolves.toContain('STAFF_LOGOUT');
  });

  it('requires authentication', async () => {
    const response = await api('POST', '/auth/logout');

    expect(response.status).toBe(401);
  });
});

import { describe, expect, it } from 'vitest';

import { api, countTokensFor, createStaffUser, login } from '../helpers';

/**
 * `POST /admin/counselors/{id}/reset-password` (audit C2) — **the staff account recovery path.**
 *
 * This endpoint exists because there previously was not one, and the resulting lockout was total.
 * Three individually reasonable decisions composed into a dead end: `/auth/forgot-password` returns
 * its token only when `APP_ENV === 'local'`, `password_reset_tokens` stores only the SHA-256 hash so
 * nobody — administrator included — can read the plaintext back out, and v1 has no email channel to
 * deliver a link through (deviation D7). A counselor who forgot their password could only be
 * recovered by hand-written SQL against production D1.
 *
 * The load-bearing claim here is the same one the counselor-creation suite makes about its own
 * generated credential, and for the same reason — this project has twice shipped a password that an
 * API *claimed* worked and did not. So the test does not assert that a string was returned; it
 * signs in with it.
 */

describe('authorization', () => {
  it('403 for a counselor — this is an admin act, not self-service', async () => {
    const target = await createStaffUser({ role: 'counselor' });
    const token = await login(await createStaffUser({ role: 'counselor' }));

    const response = await api('POST', `/admin/counselors/${target.id}/reset-password`, { token });

    expect(response.status).toBe(403);
  });

  it('401 unauthenticated', async () => {
    const target = await createStaffUser({ role: 'counselor' });

    const response = await api('POST', `/admin/counselors/${target.id}/reset-password`);

    expect(response.status).toBe(401);
  });

  it('404 for a non-counselor id — an admin or student is "not found", not "forbidden"', async () => {
    const adminToken = await login(await createStaffUser({ role: 'admin' }));
    const otherAdmin = await createStaffUser({ role: 'admin' });

    const response = await api('POST', `/admin/counselors/${otherAdmin.id}/reset-password`, {
      token: adminToken,
    });

    expect(response.status).toBe(404);
  });
});

describe('POST /admin/counselors/{id}/reset-password', () => {
  it('issues a password that really opens the account, and forces rotation', async () => {
    const adminToken = await login(await createStaffUser({ role: 'admin' }));
    const counselor = await createStaffUser({ role: 'counselor' });

    // Prove the account is in the ordinary post-activation state first, so the assertions below
    // are about what the reset did rather than about how the fixture happened to start.
    const before = await api('POST', '/auth/login', {
      body: { email: counselor.email, password: counselor.password },
    });

    expect(before.status).toBe(200);
    expect(before.body.data.user.must_change_password).toBe(false);

    const response = await api('POST', `/admin/counselors/${counselor.id}/reset-password`, {
      token: adminToken,
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: counselor.id,
      email: counselor.email,
      role: 'counselor',
      must_change_password: true,
    });

    const temporaryPassword = response.body.data.temporary_password as string;

    // §38's character classes, same contract the creation endpoint's password meets.
    expect(temporaryPassword.length).toBeGreaterThanOrEqual(10);
    expect(temporaryPassword).toMatch(/[A-Z]/);
    expect(temporaryPassword).toMatch(/[a-z]/);
    expect(temporaryPassword).toMatch(/[0-9]/);

    // The claim that matters — it is a working credential, and it lands on the rotation gate.
    const signIn = await api('POST', '/auth/login', {
      body: { email: counselor.email, password: temporaryPassword },
    });

    expect(signIn.status).toBe(200);
    expect(signIn.body.data.user.must_change_password).toBe(true);

    // …and the gate holds: the temporary credential opens nothing but the rotation itself.
    const gated = await api('GET', '/counselor/classes', { token: signIn.body.data.token });

    expect(gated.status).toBe(403);
  });

  it('the old password stops working', async () => {
    const adminToken = await login(await createStaffUser({ role: 'admin' }));
    const counselor = await createStaffUser({ role: 'counselor' });

    await api('POST', `/admin/counselors/${counselor.id}/reset-password`, { token: adminToken });

    const stale = await api('POST', '/auth/login', {
      body: { email: counselor.email, password: counselor.password },
    });

    expect(stale.status).toBe(401);
  });

  it('revokes every existing session — a rotated credential leaves no live tokens', async () => {
    const adminToken = await login(await createStaffUser({ role: 'admin' }));
    const counselor = await createStaffUser({ role: 'counselor' });

    // Two concurrent sessions, so this proves *all* tokens go rather than just the newest.
    const first = await login(counselor);
    await login(counselor);

    expect(await countTokensFor(counselor.id)).toBe(2);

    await api('POST', `/admin/counselors/${counselor.id}/reset-password`, { token: adminToken });

    expect(await countTokensFor(counselor.id)).toBe(0);

    const withOldToken = await api('GET', '/counselor/classes', { token: first });

    expect(withOldToken.status).toBe(401);
  });

  it('clears an active login lockout — the whole point is to restore access', async () => {
    const adminToken = await login(await createStaffUser({ role: 'admin' }));
    const counselor = await createStaffUser({ role: 'counselor' });

    // Trip the §38 lockout: five failures per email in fifteen minutes.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await api('POST', '/auth/login', {
        body: { email: counselor.email, password: 'WrongPassword123' },
      });
    }

    const lockedOut = await api('POST', '/auth/login', {
      body: { email: counselor.email, password: counselor.password },
    });

    expect(lockedOut.status).toBe(429);

    const response = await api('POST', `/admin/counselors/${counselor.id}/reset-password`, {
      token: adminToken,
    });

    expect(response.status).toBe(200);

    // Without the `guard.clear()` in the service this is a 429 and the reset is useless for the
    // ~15 minutes it matters most: a locked-out counselor is exactly who this endpoint is for.
    const signIn = await api('POST', '/auth/login', {
      body: { email: counselor.email, password: response.body.data.temporary_password },
    });

    expect(signIn.status).toBe(200);
  });

  it('is repeatable — the second reset supersedes the first', async () => {
    const adminToken = await login(await createStaffUser({ role: 'admin' }));
    const counselor = await createStaffUser({ role: 'counselor' });

    const first = await api('POST', `/admin/counselors/${counselor.id}/reset-password`, {
      token: adminToken,
    });
    const second = await api('POST', `/admin/counselors/${counselor.id}/reset-password`, {
      token: adminToken,
    });

    expect(second.status).toBe(200);
    expect(second.body.data.temporary_password).not.toBe(first.body.data.temporary_password);

    // Only the latest is live. An admin who resets twice by accident must not leave two working
    // credentials behind, which is the failure a naive "set a new password" would ship.
    const stale = await api('POST', '/auth/login', {
      body: { email: counselor.email, password: first.body.data.temporary_password },
    });

    expect(stale.status).toBe(401);

    const current = await api('POST', '/auth/login', {
      body: { email: counselor.email, password: second.body.data.temporary_password },
    });

    expect(current.status).toBe(200);
  });

  it('writes an audit row that never contains the plaintext', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const adminToken = await login(admin);
    const counselor = await createStaffUser({ role: 'counselor' });

    const response = await api('POST', `/admin/counselors/${counselor.id}/reset-password`, {
      token: adminToken,
    });

    const temporaryPassword = response.body.data.temporary_password as string;

    const logs = await api('GET', '/admin/audit-logs?action=COUNSELOR_PASSWORD_RESET', {
      token: adminToken,
    });

    expect(logs.status).toBe(200);

    const row = logs.body.data.items.find(
      (item: { target_id: string }) => item.target_id === counselor.id,
    );

    expect(row).toBeDefined();
    expect(row.user_id).toBe(admin.id);

    // The credential must not be recoverable from the audit trail — which is the one place a
    // careless `newValues: { password }` would quietly put it, readable by every admin forever.
    expect(JSON.stringify(row)).not.toContain(temporaryPassword);
  });
});

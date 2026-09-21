import { describe, expect, it } from 'vitest';

import { api, auditActionsFor, countTokensFor, createStaffUser, findUser, login } from '../helpers';

/**
 * The two self-service account endpoints behind `/counselor/profile` (prompt-driven, 2026-09-20).
 *
 * They are tested together because the line between them is the thing worth pinning: `/auth/profile`
 * edits labels and asks for nothing, `/auth/change-email` moves the login identifier and re-proves
 * the password first. A change that blurred that line would pass one of these suites and fail the
 * other.
 */

describe('PATCH /auth/profile', () => {
  it("derives the counselor's display name from the first and last name", async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);

    const response = await api('PATCH', '/auth/profile', {
      token,
      body: { first_name: 'Maria', last_name: 'Reyes', specialization: 'Senior High' },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.name).toBe('Maria Reyes');
    expect(response.body.data.counselor_profile.first_name).toBe('Maria');
    expect(response.body.data.counselor_profile.specialization).toBe('Senior High');
    expect((await findUser(counselor.id))?.name).toBe('Maria Reyes');
  });

  it('leaves untouched fields alone, and clears one that is sent as null', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);

    await api('PATCH', '/auth/profile', { token, body: { phone: '0917 000 0000' } });
    const cleared = await api('PATCH', '/auth/profile', { token, body: { phone: null } });

    expect(cleared.status).toBe(200);
    expect(cleared.body.data.counselor_profile.phone).toBeNull();
    // The name was never in either body and must have survived both.
    expect(cleared.body.data.name).toBe('Test Counselor');
  });

  it('edits an administrator by name, since they have no counselor profile', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);

    const response = await api('PATCH', '/auth/profile', { token, body: { name: 'Site Admin' } });

    expect(response.status).toBe(200);
    expect(response.body.data.name).toBe('Site Admin');
    expect(response.body.data.counselor_profile).toBeUndefined();
  });

  it('refuses an administrator update that names nothing', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);

    const response = await api('PATCH', '/auth/profile', { token, body: { phone: '0917' } });

    expect(response.status).toBe(422);
  });

  it('refuses a body that tries to reach a field this endpoint does not own', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);

    const response = await api('PATCH', '/auth/profile', {
      token,
      body: { first_name: 'Maria', status: 'suspended' },
    });

    expect(response.status).toBe(422);
  });

  it('writes a STAFF_PROFILE_UPDATED audit entry', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);

    await api('PATCH', '/auth/profile', { token, body: { first_name: 'Maria' } });

    await expect(auditActionsFor(counselor.id)).resolves.toContain('STAFF_PROFILE_UPDATED');
  });

  it('is refused while must_change_password is set', async () => {
    const counselor = await createStaffUser({ mustChangePassword: true });
    const token = await login(counselor);

    const response = await api('PATCH', '/auth/profile', { token, body: { first_name: 'Maria' } });

    expect(response.status).toBe(403);
  });

  it('is refused without a token', async () => {
    const response = await api('PATCH', '/auth/profile', { body: { first_name: 'Maria' } });

    expect(response.status).toBe(401);
  });
});

describe('POST /auth/change-email', () => {
  /**
   * A fresh address per test. The suite shares one database across the file, and
   * `users_email_unique` covers soft-deleted rows — so a constant here would mean every test
   * after the first one was really exercising "this address is already in use".
   */
  let issued = 0;
  const nextEmail = () => `moved.counselor.${(issued += 1)}@school.test`;

  it('moves the login identifier and leaves the session alive', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);
    const email = nextEmail();

    const response = await api('POST', '/auth/change-email', {
      token,
      body: { email: email, current_password: counselor.password },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.email).toBe(email);
    expect(response.body.data.email_verified_at).toBeNull();
    // Not a credential rotation: nothing the caller holds got less trustworthy.
    await expect(countTokensFor(counselor.id)).resolves.toBe(1);

    const withNew = await api('POST', '/auth/login', {
      body: { email: email, password: counselor.password },
    });

    expect(withNew.status).toBe(200);
  });

  it('refuses the old address for signing in afterwards', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);
    const email = nextEmail();

    await api('POST', '/auth/change-email', {
      token,
      body: { email: email, current_password: counselor.password },
    });

    const withOld = await api('POST', '/auth/login', {
      body: { email: counselor.email, password: counselor.password },
    });

    expect(withOld.status).toBe(401);
  });

  it('refuses a wrong current password and changes nothing', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);
    const email = nextEmail();

    const response = await api('POST', '/auth/change-email', {
      token,
      body: { email: email, current_password: 'NotThePassword1' },
    });

    expect(response.status).toBe(422);
    expect((await findUser(counselor.id))?.email).toBe(counselor.email);
  });

  it('refuses an address another account already holds', async () => {
    const taken = await createStaffUser();
    const counselor = await createStaffUser();
    const token = await login(counselor);

    const response = await api('POST', '/auth/change-email', {
      token,
      body: { email: taken.email, current_password: counselor.password },
    });

    expect(response.status).toBe(422);
    expect((await findUser(counselor.id))?.email).toBe(counselor.email);
  });

  it('refuses the address the account already has', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);

    const response = await api('POST', '/auth/change-email', {
      token,
      body: { email: counselor.email.toUpperCase(), current_password: counselor.password },
    });

    expect(response.status).toBe(422);
  });

  it('writes a STAFF_EMAIL_CHANGED audit entry carrying both addresses', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);
    const email = nextEmail();

    await api('POST', '/auth/change-email', {
      token,
      body: { email: email, current_password: counselor.password },
    });

    await expect(auditActionsFor(counselor.id)).resolves.toContain('STAFF_EMAIL_CHANGED');
  });

  it('is refused while must_change_password is set', async () => {
    const counselor = await createStaffUser({ mustChangePassword: true });
    const token = await login(counselor);
    const email = nextEmail();

    const response = await api('POST', '/auth/change-email', {
      token,
      body: { email: email, current_password: counselor.password },
    });

    expect(response.status).toBe(403);
  });
});

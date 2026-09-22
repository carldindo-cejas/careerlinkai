import { describe, expect, it } from 'vitest';

import {
  api,
  auditActionsFor,
  backdateEmailChangeRequest,
  countTokensFor,
  createStaffUser,
  findEmailChangeRequest,
  findUser,
  login,
  notificationsFor,
  VALID_PASSWORD,
} from '../helpers';

/**
 * The two self-service account endpoints behind `/counselor/profile` (prompt-driven, 2026-09-20).
 *
 * They are tested together because the line between them is the thing worth pinning: `/auth/profile`
 * edits labels and asks for nothing, `/auth/change-email` moves the login identifier and proves
 * two separate things before it does — the password, and that the destination mailbox is real
 * (migration 0039). A change that blurred that line would pass one of these suites and fail the
 * other.
 *
 * `APP_ENV` is `local` under `wrangler.test.toml`, so the route echoes the six-digit code in the
 * response body — the same affordance `/auth/forgot-password` has for its reset token, and what
 * lets these tests run the whole flow with no mail channel (the suite has no `RESEND_API_KEY` by
 * design, so the sender returns `not_configured` before it can reach the network).
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

describe('POST /auth/change-email (the two steps, migration 0039)', () => {
  /**
   * A fresh address per test. The suite shares one database across the file, and
   * `users_email_unique` covers soft-deleted rows — so a constant here would mean every test
   * after the first one was really exercising "this address is already in use".
   */
  let issued = 0;
  const nextEmail = () => `moved.counselor.${(issued += 1)}@school.test`;

  /** Step one, for the tests whose subject is step two. Returns the code the local env echoes. */
  async function stage(
    token: string,
    password: string,
    email: string,
  ): Promise<{ code: string; email: string }> {
    const response = await api('POST', '/auth/change-email', {
      token,
      body: { email, current_password: password },
    });

    expect(response.status).toBe(202);

    return { code: response.body.data.verification_code, email };
  }

  it('stages the change and mails a code without touching the account', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);
    const email = nextEmail();

    const response = await api('POST', '/auth/change-email', {
      token,
      body: { email, current_password: counselor.password },
    });

    // 202, because nothing has happened yet — that is the whole point of the step.
    expect(response.status).toBe(202);
    expect(response.body.data.pending_email).toBe(email);
    expect(response.body.data.expires_in_minutes).toBe(15);
    // Echoed only because APP_ENV is `local` under test; there is no mail channel in the suite.
    expect(response.body.data.verification_code).toMatch(/^\d{6}$/);

    // The account is exactly where it was, which is what makes a typo survivable.
    expect((await findUser(counselor.id))?.email).toBe(counselor.email);
    await expect(findEmailChangeRequest(counselor.id)).resolves.toBeDefined();

    const withOld = await api('POST', '/auth/login', {
      body: { email: counselor.email, password: counselor.password },
    });

    expect(withOld.status).toBe(200);
  });

  it('stores the code hashed, never in plaintext', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);
    const { code } = await stage(token, counselor.password, nextEmail());

    const staged = await findEmailChangeRequest(counselor.id);

    expect(staged?.codeHash).not.toBe(code);
    // SHA-256, hex — the same instrument the signup code is stored with.
    expect(staged?.codeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('moves the login identifier only when the code comes back', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);
    const { code, email } = await stage(token, counselor.password, nextEmail());

    const response = await api('POST', '/auth/change-email/verify', { token, body: { code } });

    expect(response.status).toBe(200);
    expect(response.body.data.email).toBe(email);
    // Proven, not merely claimed: somebody read this code out of that mailbox.
    expect(response.body.data.email_verified_at).not.toBeNull();
    // Not a credential rotation: nothing the caller holds got less trustworthy.
    await expect(countTokensFor(counselor.id)).resolves.toBe(1);
    // The staged row is spent, not left behind for a second use.
    await expect(findEmailChangeRequest(counselor.id)).resolves.toBeUndefined();

    const withNew = await api('POST', '/auth/login', {
      body: { email, password: counselor.password },
    });

    expect(withNew.status).toBe(200);
  });

  it('refuses the old address for signing in afterwards', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);
    const { code } = await stage(token, counselor.password, nextEmail());

    await api('POST', '/auth/change-email/verify', { token, body: { code } });

    const withOld = await api('POST', '/auth/login', {
      body: { email: counselor.email, password: counselor.password },
    });

    expect(withOld.status).toBe(401);
  });

  it('refuses a wrong code and leaves the change pending', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);
    const { code } = await stage(token, counselor.password, nextEmail());
    const wrong = code === '000000' ? '111111' : '000000';

    const response = await api('POST', '/auth/change-email/verify', {
      token,
      body: { code: wrong },
    });

    expect(response.status).toBe(422);
    expect((await findUser(counselor.id))?.email).toBe(counselor.email);
    // Still staged: a mistyped digit must not cost the code that did arrive.
    await expect(findEmailChangeRequest(counselor.id)).resolves.toBeDefined();

    const retry = await api('POST', '/auth/change-email/verify', { token, body: { code } });

    expect(retry.status).toBe(200);
  });

  it('refuses a code past its fifteen minutes and drops the request', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);
    const { code } = await stage(token, counselor.password, nextEmail());

    await backdateEmailChangeRequest(counselor.id, 16);

    const response = await api('POST', '/auth/change-email/verify', { token, body: { code } });

    expect(response.status).toBe(422);
    expect((await findUser(counselor.id))?.email).toBe(counselor.email);
    await expect(findEmailChangeRequest(counselor.id)).resolves.toBeUndefined();
  });

  it('reports what is pending, so a reloaded page finds its way back', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);
    const { email } = await stage(token, counselor.password, nextEmail());

    const response = await api('GET', '/auth/change-email', { token });

    expect(response.status).toBe(200);
    expect(response.body.data.pending_email).toBe(email);
    expect(response.body.data.expires_in_minutes).toBeGreaterThan(0);
  });

  it('reports nothing pending when nothing is staged', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);

    const response = await api('GET', '/auth/change-email', { token });

    expect(response.status).toBe(200);
    expect(response.body.data).toBeNull();
  });

  it('issues a new code on resend and retires the old one', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);
    const { code: first, email } = await stage(token, counselor.password, nextEmail());

    const resent = await api('POST', '/auth/change-email/resend', { token });

    expect(resent.status).toBe(202);
    expect(resent.body.data.pending_email).toBe(email);

    const second = resent.body.data.verification_code;

    expect(second).not.toBe(first);

    // One live code per request, never two.
    const stale = await api('POST', '/auth/change-email/verify', {
      token,
      body: { code: first },
    });

    expect(stale.status).toBe(422);

    const fresh = await api('POST', '/auth/change-email/verify', {
      token,
      body: { code: second },
    });

    expect(fresh.status).toBe(200);
    expect(fresh.body.data.email).toBe(email);
  });

  it('refuses a resend when nothing is staged', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);

    const response = await api('POST', '/auth/change-email/resend', { token });

    expect(response.status).toBe(404);
  });

  it('cancels a staged change, and cancelling nothing is still a success', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);
    const { code } = await stage(token, counselor.password, nextEmail());

    const cancelled = await api('DELETE', '/auth/change-email', { token });

    expect(cancelled.status).toBe(200);
    await expect(findEmailChangeRequest(counselor.id)).resolves.toBeUndefined();

    // The code it issued is dead with it.
    const spent = await api('POST', '/auth/change-email/verify', { token, body: { code } });

    expect(spent.status).toBe(422);

    // Idempotent: the button exists to stop the page asking, not to report bookkeeping.
    const again = await api('DELETE', '/auth/change-email', { token });

    expect(again.status).toBe(200);
  });

  it('refuses a wrong current password and stages nothing', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);
    const email = nextEmail();

    const response = await api('POST', '/auth/change-email', {
      token,
      body: { email, current_password: 'NotThePassword1' },
    });

    expect(response.status).toBe(422);
    expect((await findUser(counselor.id))?.email).toBe(counselor.email);
    await expect(findEmailChangeRequest(counselor.id)).resolves.toBeUndefined();
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
    await expect(findEmailChangeRequest(counselor.id)).resolves.toBeUndefined();
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

  it('records the request and the change as separate audit actions', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);
    const { code } = await stage(token, counselor.password, nextEmail());

    // Asked for, not yet done — and that distinction is the reason for two actions.
    await expect(auditActionsFor(counselor.id)).resolves.toContain(
      'STAFF_EMAIL_CHANGE_REQUESTED',
    );
    await expect(auditActionsFor(counselor.id)).resolves.not.toContain('STAFF_EMAIL_CHANGED');

    await api('POST', '/auth/change-email/verify', { token, body: { code } });

    await expect(auditActionsFor(counselor.id)).resolves.toContain('STAFF_EMAIL_CHANGED');
  });

  it('records an abandoned change rather than leaving it silent', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);

    await stage(token, counselor.password, nextEmail());
    await api('DELETE', '/auth/change-email', { token });

    await expect(auditActionsFor(counselor.id)).resolves.toContain(
      'STAFF_EMAIL_CHANGE_CANCELLED',
    );
  });

  it('tells every active administrator once the address has moved', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const counselor = await createStaffUser();
    const token = await login(counselor);
    const { code, email } = await stage(token, counselor.password, nextEmail());

    // Nothing has changed yet, so there is nothing to tell them about yet.
    await expect(notificationsFor(admin.id)).resolves.toHaveLength(0);

    await api('POST', '/auth/change-email/verify', { token, body: { code } });

    const sent = await notificationsFor(admin.id);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.category).toBe('ACCOUNT');
    // Both addresses: "who used to be x@ and is now y@" is the only form an admin can act on.
    expect(sent[0]!.message).toContain(counselor.email);
    expect(sent[0]!.message).toContain(email);
  });

  it('is refused while must_change_password is set, at both steps', async () => {
    const counselor = await createStaffUser({ mustChangePassword: true });
    const token = await login(counselor);

    const staged = await api('POST', '/auth/change-email', {
      token,
      body: { email: nextEmail(), current_password: counselor.password },
    });

    expect(staged.status).toBe(403);

    const verified = await api('POST', '/auth/change-email/verify', {
      token,
      body: { code: '123456' },
    });

    expect(verified.status).toBe(403);
  });

  it('refuses every step without a token', async () => {
    const email = nextEmail();

    await expect(
      api('POST', '/auth/change-email', { body: { email, current_password: VALID_PASSWORD } }),
    ).resolves.toMatchObject({ status: 401 });
    // The wildcard mount is what makes this one a 401 rather than a code-guessing endpoint
    // against every account at once.
    await expect(
      api('POST', '/auth/change-email/verify', { body: { code: '123456' } }),
    ).resolves.toMatchObject({ status: 401 });
    await expect(api('POST', '/auth/change-email/resend', {})).resolves.toMatchObject({
      status: 401,
    });
    await expect(api('GET', '/auth/change-email', {})).resolves.toMatchObject({ status: 401 });
  });
});

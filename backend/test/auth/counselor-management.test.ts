import { describe, expect, it } from 'vitest';

import {
  api,
  countTokensFor,
  createClass,
  createStaffUser,
  createStudentUser,
  findUser,
  login,
} from '../helpers';

/**
 * Counselor management (FULLPLAN §20 "Counselor management", Phase 6) — the four admin
 * endpoints over the role that can read every enrolled student's results.
 *
 * The load-bearing claims: the generated temporary password actually opens the account (a
 * committed-credential class of bug shipped twice in this project's history — a password
 * this API *claims* works must be proven against the real login), the first login is forced
 * through rotation, and delete/suspend genuinely end access rather than merely relabeling it.
 */

const ENDPOINTS: [string, string][] = [
  ['GET', '/admin/counselors'],
  ['POST', '/admin/counselors'],
  ['PATCH', '/admin/counselors/some-id'],
  ['DELETE', '/admin/counselors/some-id'],
];

describe('authorization', () => {
  it.each(ENDPOINTS)('%s %s → 403 for a counselor', async (method, path) => {
    const token = await login(await createStaffUser({ role: 'counselor' }));

    const response = await api(method, path, {
      token,
      ...(method === 'GET' || method === 'DELETE' ? {} : { body: {} }),
    });

    expect(response.status).toBe(403);
  });

  it('an unauthenticated caller gets 401', async () => {
    const response = await api('GET', '/admin/counselors');

    expect(response.status).toBe(401);
  });
});

describe('POST /admin/counselors', () => {
  it('creates the account and the generated temporary password really opens it — once', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const adminToken = await login(admin);
    const email = `new.counselor.${Date.now()}@school.test`;

    const created = await api('POST', '/admin/counselors', {
      token: adminToken,
      body: {
        email,
        first_name: 'Liza',
        last_name: 'Manalo',
        specialization: 'Career Guidance',
      },
    });

    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      email,
      role: 'counselor',
      status: 'active',
      must_change_password: true,
      name: 'Liza Manalo',
      classes_count: 0,
      students_count: 0,
    });
    expect(created.body.data.counselor_profile).toMatchObject({
      first_name: 'Liza',
      last_name: 'Manalo',
      specialization: 'Career Guidance',
    });

    // The §38 policy holds for the generated credential itself.
    const temporaryPassword = created.body.data.temporary_password as string;

    expect(temporaryPassword.length).toBeGreaterThanOrEqual(10);
    expect(temporaryPassword).toMatch(/[A-Z]/);
    expect(temporaryPassword).toMatch(/[a-z]/);
    expect(temporaryPassword).toMatch(/[0-9]/);

    // The claim that matters: this password opens this account, and lands on the rotation gate.
    const firstLogin = await api('POST', '/auth/login', {
      body: { email, password: temporaryPassword },
    });

    expect(firstLogin.status).toBe(200);
    expect(firstLogin.body.data.user.must_change_password).toBe(true);

    // The gate holds: everything but auth is refused until the password rotates.
    const gated = await api('GET', '/counselor/classes', {
      token: firstLogin.body.data.token,
    });

    expect(gated.status).toBe(403);
  });

  it('refuses a duplicate email with a 422, not a constraint error', async () => {
    const adminToken = await login(await createStaffUser({ role: 'admin' }));
    const existing = await createStaffUser({ role: 'counselor' });

    const response = await api('POST', '/admin/counselors', {
      token: adminToken,
      body: { email: existing.email, first_name: 'Dup', last_name: 'Licate' },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.email).toBeDefined();
  });

  it('answers a *concurrent* duplicate create with 422, not a 500 (H4/M8)', async () => {
    const adminToken = await login(await createStaffUser({ role: 'admin' }));
    const email = `race.${Date.now()}@school.test`;
    const body = { email, first_name: 'Race', last_name: 'Winner' };

    // Both pass the email pre-check before either writes (the hash is derived first — the wide M8
    // window), so the loser hits `users_email_unique`. That must translate to the same 422 the
    // pre-check gives, never the raw constraint 500 it used to be.
    const [a, b] = await Promise.all([
      api('POST', '/admin/counselors', { token: adminToken, body }),
      api('POST', '/admin/counselors', { token: adminToken, body }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 422]);
    expect([a, b].every((r) => r.status !== 500)).toBe(true);

    // Exactly one account exists for the email.
    const listed = await api('GET', `/admin/counselors?search=${email}`, { token: adminToken });
    expect(listed.body.data.items).toHaveLength(1);
  });

  it('rejects a client-supplied role or password outright (.strict())', async () => {
    const adminToken = await login(await createStaffUser({ role: 'admin' }));

    const response = await api('POST', '/admin/counselors', {
      token: adminToken,
      body: {
        email: `strict.${Date.now()}@school.test`,
        first_name: 'No',
        last_name: 'Escalation',
        role: 'admin',
        password: 'MyOwnPassword1',
      },
    });

    expect(response.status).toBe(422);
  });
});

describe('GET /admin/counselors', () => {
  it('lists live counselors with their class/student footprint, searchable', async () => {
    const adminToken = await login(await createStaffUser({ role: 'admin' }));
    const counselor = await createStaffUser({ role: 'counselor', name: 'Footprint Fixture' });
    await createClass(await login(counselor));

    const searched = await api('GET', `/admin/counselors?search=${counselor.email}`, {
      token: adminToken,
    });

    expect(searched.status).toBe(200);
    expect(searched.body.data.items).toHaveLength(1);
    expect(searched.body.data.items[0]).toMatchObject({
      id: counselor.id,
      classes_count: 1,
      students_count: 0,
    });
    expect(searched.body.data.items[0]).not.toHaveProperty('password');
    expect(searched.body.data.items[0]).not.toHaveProperty('temporary_password');
  });
});

describe('PATCH /admin/counselors/{id}', () => {
  it('updates profile fields and status — and a suspended counselor’s live token dies', async () => {
    const adminToken = await login(await createStaffUser({ role: 'admin' }));
    const counselor = await createStaffUser({ role: 'counselor' });
    const counselorToken = await login(counselor);

    // Verify the token is alive first, so the death below means something.
    expect((await api('GET', '/auth/me', { token: counselorToken })).status).toBe(200);

    const response = await api('PATCH', `/admin/counselors/${counselor.id}`, {
      token: adminToken,
      body: { status: 'suspended', specialization: 'On leave' },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('suspended');
    expect(response.body.data.counselor_profile.specialization).toBe('On leave');

    // §38: a live token is rejected the moment its user leaves `active`.
    expect((await api('GET', '/auth/me', { token: counselorToken })).status).toBe(401);
  });

  it('a non-counselor id 404s — an admin cannot be managed through this surface', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const otherAdmin = await createStaffUser({ role: 'admin' });
    const student = await createStudentUser();
    const token = await login(admin);

    for (const id of [otherAdmin.id, student.id, 'does-not-exist']) {
      const response = await api('PATCH', `/admin/counselors/${id}`, {
        token,
        body: { status: 'suspended' },
      });

      expect(response.status).toBe(404);
    }
  });
});

describe('DELETE /admin/counselors/{id}', () => {
  it('soft-deletes, revokes every session, and disappears from the list', async () => {
    const adminToken = await login(await createStaffUser({ role: 'admin' }));
    const counselor = await createStaffUser({ role: 'counselor' });
    await login(counselor); // a live session to revoke

    const response = await api('DELETE', `/admin/counselors/${counselor.id}`, {
      token: adminToken,
    });

    expect(response.status).toBe(204);

    const row = await findUser(counselor.id);

    expect(row?.deletedAt).not.toBeNull();
    expect(await countTokensFor(counselor.id)).toBe(0);

    const listed = await api('GET', `/admin/counselors?search=${counselor.email}`, {
      token: adminToken,
    });

    expect(listed.body.data.items).toHaveLength(0);

    // Gone is gone: a second delete has nothing to find.
    const again = await api('DELETE', `/admin/counselors/${counselor.id}`, {
      token: adminToken,
    });

    expect(again.status).toBe(404);

    // And the deleted credential no longer opens anything.
    const dead = await api('POST', '/auth/login', {
      body: { email: counselor.email, password: counselor.password },
    });

    expect(dead.status).toBe(401);
  });
});

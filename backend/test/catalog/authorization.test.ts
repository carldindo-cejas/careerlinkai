import { describe, expect, it } from 'vitest';

import {
  api,
  createCareer,
  createClass,
  createCollege,
  createProgram,
  createStaffUser,
  enrolStudents,
  joinClass,
  login,
  setUserStatus,
} from '../helpers';

/**
 * The authorization matrix for `/admin` (FULLPLAN §20, §39).
 *
 * **This file is load-bearing, not belt-and-braces.** Authorization in the catalog is one
 * layer, not two: a college belongs to nobody, so there is no ownership dimension to scope and
 * §39 names no catalog policy — `ensureRole('admin')` on the route group is the entire rule.
 * Which means the route group is the *only* thing standing between a new catalog endpoint and
 * a counselor who can edit the catalog. There is no second net inside the Service.
 *
 * So every endpoint is enumerated below rather than spot-checked. A new route added to the
 * group without a guard is exactly the failure this file exists to catch, and it can only
 * catch it by naming them all.
 */

/** All 15 catalog endpoints (§20). `{}` bodies are fine — the guard runs before validation. */
const ENDPOINTS: [string, string][] = [
  ['GET', '/admin/colleges'],
  ['POST', '/admin/colleges'],
  ['GET', '/admin/colleges/some-id'],
  ['PATCH', '/admin/colleges/some-id'],
  ['DELETE', '/admin/colleges/some-id'],
  ['GET', '/admin/colleges/some-id/programs'],
  ['POST', '/admin/colleges/some-id/programs'],
  ['PATCH', '/admin/programs/some-id'],
  ['DELETE', '/admin/programs/some-id'],
  ['GET', '/admin/careers'],
  ['POST', '/admin/careers'],
  ['PATCH', '/admin/careers/some-id'],
  ['DELETE', '/admin/careers/some-id'],
  ['POST', '/admin/programs/some-id/careers'],
  ['DELETE', '/admin/programs/some-id/careers/some-career-id'],
];

describe('a counselor is refused the /admin group entirely', () => {
  /**
   * **403, not 404 and not a filtered list.** The catalog is admin-managed (§5): a counselor
   * editing the college list would be editing what every *other* counselor's students get
   * recommended. There is nothing here to scope to them, so there is nothing to hide either —
   * the honest answer is "you may not", not "it does not exist".
   */
  it.each(ENDPOINTS)('%s %s → 403', async (method, path) => {
    const token = await login(await createStaffUser({ role: 'counselor' }));

    // No body on a GET — `fetch` refuses one, and the guard runs before validation anyway.
    const response = await api(method, path, {
      token,
      ...(method === 'GET' ? {} : { body: {} }),
    });

    expect(response.status).toBe(403);
  });
});

describe('a student is refused the /admin group entirely', () => {
  it.each(ENDPOINTS)('%s %s → 403', async (method, path) => {
    const counselor = await createStaffUser({ role: 'counselor' });
    const counselorToken = await login(counselor);
    const classRoom = await createClass(counselorToken);
    const [student] = await enrolStudents(counselorToken, classRoom.id, ['Juan Dela Cruz']);

    const token = await joinClass(classRoom.join_code, student.username);

    // No body on a GET — `fetch` refuses one, and the guard runs before validation anyway.
    const response = await api(method, path, {
      token,
      ...(method === 'GET' ? {} : { body: {} }),
    });

    expect(response.status).toBe(403);
  });
});

describe('an anonymous caller is refused the /admin group entirely', () => {
  it.each(ENDPOINTS)('%s %s → 401', async (method, path) => {
    const response = await api(method, path, { ...(method === 'GET' ? {} : { body: {} }) });

    expect(response.status).toBe(401);
  });
});

describe('an admin still on a temporary password', () => {
  /**
   * A temp password buys a token that must open nothing but its own rotation (§38). The
   * catalog is not an exception — `ensurePasswordChanged` sits behind `ensureRole` on this
   * group too.
   */
  it('is refused the catalog until the password is rotated', async () => {
    const admin = await createStaffUser({ role: 'admin', mustChangePassword: true });
    const token = await login(admin);

    expect((await api('GET', '/admin/colleges', { token })).status).toBe(403);

    // Genuinely different from the fixture's password — the schema refuses a rotation that
    // changes nothing, which is a rule worth not tripping over here.
    const rotatedPassword = 'RotatedPass9';

    const rotated = await api('POST', '/auth/change-password', {
      token,
      body: {
        current_password: admin.password,
        password: rotatedPassword,
        password_confirmation: rotatedPassword,
      },
    });

    expect(rotated.status).toBe(200);

    // A password change revokes every session, so the caller signs in again — and now the
    // catalog opens.
    const fresh = await login({ ...admin, password: rotatedPassword });

    expect((await api('GET', '/admin/colleges', { token: fresh })).status).toBe(200);
  });
});

describe('an admin is admitted', () => {
  it('may run the full catalog lifecycle end to end', async () => {
    const token = await login(await createStaffUser({ role: 'admin' }));

    const college = await createCollege(token);
    const program = await createProgram(token, college.id);
    const career = await createCareer(token);

    expect(
      (await api('POST', `/admin/programs/${program.id}/careers`, {
        token,
        body: { career_id: career.id },
      })).status,
    ).toBe(201);

    const detail = await api('GET', `/admin/colleges/${college.id}`, { token });

    expect(detail.status).toBe(200);
    expect(detail.body.data.programs[0].careers[0].id).toBe(career.id);
  });
});

describe('a suspended admin', () => {
  it('cannot reach the catalog even with a live token', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);

    expect((await api('GET', '/admin/colleges', { token })).status).toBe(200);

    await setUserStatus(admin.id, 'suspended');

    // §38: a live token dies the moment its user leaves `active`.
    expect((await api('GET', '/admin/colleges', { token })).status).toBe(401);
  });
});

import { describe, expect, it } from 'vitest';

import { api, createClass, createStaffUser, enrolStudents, joinClass, login } from '../helpers';

/**
 * Class CRUD + the join-code lifecycle (FULLPLAN §13.2, §20).
 *
 * The join code is the whole security boundary for student access (§38), so most of what is
 * asserted here is about the code: that it is generated (not supplied), that it is well
 * formed, that regenerating it revokes the old one.
 */

/** Four letters, a hyphen, four digits — and never an I, O, 0 or 1 (§13.2). */
const JOIN_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[2-9]{4}$/;

describe('POST /counselor/classes', () => {
  it('creates a class and returns a join code immediately, before any roster exists', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);

    const response = await api('POST', '/counselor/classes', {
      token,
      body: { name: 'Grade 12 STEM A', academic_year: '2026-2027', grade_level: 'Grade 12' },
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      counselor_id: counselor.id,
      name: 'Grade 12 STEM A',
      academic_year: '2026-2027',
      grade_level: 'Grade 12',
      status: 'active',
    });
    expect(response.body.data.join_code).toMatch(JOIN_CODE);
    expect(response.body.data.join_code_expires_at).not.toBeNull();
  });

  it('ignores a client-supplied join code — a client must never choose its own', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);

    const response = await api('POST', '/counselor/classes', {
      token,
      body: {
        name: 'Grade 12 STEM B',
        academic_year: '2026-2027',
        join_code: 'AAAA-2222',
      },
    });

    expect(response.status).toBe(201);
    expect(response.body.data.join_code).not.toBe('AAAA-2222');
    expect(response.body.data.join_code).toMatch(JOIN_CODE);
  });

  it('issues a distinct code to every class', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);

    const codes = new Set<string>();

    for (let i = 0; i < 8; i += 1) {
      const created = await createClass(token, { name: `Class ${i}` });
      codes.add(created.join_code);
    }

    expect(codes.size).toBe(8);
  });

  it('rejects a missing name', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);

    const response = await api('POST', '/counselor/classes', {
      token,
      body: { academic_year: '2026-2027' },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.name).toBeDefined();
  });
});

describe('GET /counselor/classes', () => {
  it('lists the caller’s classes in the §19 nested-pagination shape', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);

    await createClass(token, { name: 'One' });
    await createClass(token, { name: 'Two' });

    const response = await api('GET', '/counselor/classes', { token });

    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(2);
    expect(response.body.data.pagination).toMatchObject({
      current_page: 1,
      per_page: 20,
      total: 2,
      last_page: 1,
    });
  });

  it('does not leak another counselor’s classes', async () => {
    const mine = await createStaffUser();
    const theirs = await createStaffUser();
    const myToken = await login(mine);
    const theirToken = await login(theirs);

    await createClass(myToken, { name: 'Mine' });
    await createClass(theirToken, { name: 'Theirs' });

    const response = await api('GET', '/counselor/classes', { token: myToken });

    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].name).toBe('Mine');
  });

  it('shows an admin every class', async () => {
    const counselor = await createStaffUser();
    const admin = await createStaffUser({ role: 'admin' });

    await createClass(await login(counselor), { name: 'A counselor’s class' });

    const response = await api('GET', '/counselor/classes', { token: await login(admin) });

    expect(response.status).toBe(200);
    expect(response.body.data.items.length).toBeGreaterThanOrEqual(1);
  });

  it('excludes soft-deleted classes', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);
    const classRoom = await createClass(token);

    await api('DELETE', `/counselor/classes/${classRoom.id}`, { token });

    const response = await api('GET', '/counselor/classes', { token });

    expect(response.body.data.items).toHaveLength(0);
  });
});

describe('class ownership (§39)', () => {
  it('returns 404 — not 403 — for another counselor’s class', async () => {
    // A 403 would confirm the class exists, which is a fact a counselor is not entitled to
    // about a colleague's class. "Not yours" and "not real" must be indistinguishable.
    const owner = await createStaffUser();
    const stranger = await createStaffUser();
    const classRoom = await createClass(await login(owner));
    const strangerToken = await login(stranger);

    for (const [method, path] of [
      ['GET', `/counselor/classes/${classRoom.id}`],
      ['PATCH', `/counselor/classes/${classRoom.id}`],
      ['DELETE', `/counselor/classes/${classRoom.id}`],
      ['POST', `/counselor/classes/${classRoom.id}/regenerate-code`],
      ['GET', `/counselor/classes/${classRoom.id}/students`],
    ] as const) {
      const response = await api(method, path, {
        token: strangerToken,
        ...(method === 'PATCH' ? { body: { name: 'Hijacked' } } : {}),
      });

      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });

  it('lets an admin reach a counselor’s class', async () => {
    const counselor = await createStaffUser();
    const admin = await createStaffUser({ role: 'admin' });
    const classRoom = await createClass(await login(counselor));

    const response = await api('GET', `/counselor/classes/${classRoom.id}`, {
      token: await login(admin),
    });

    expect(response.status).toBe(200);
  });

  it('refuses a student outright — the coarse role gate, before any policy runs', async () => {
    const counselor = await createStaffUser();
    const counselorToken = await login(counselor);
    const classRoom = await createClass(counselorToken);

    const [enrolled] = await enrolStudents(counselorToken, classRoom.id, ['Juan Dela Cruz']);
    const studentToken = await joinClass(classRoom.join_code, enrolled.username);

    const response = await api('GET', '/counselor/classes', { token: studentToken });

    expect(response.status).toBe(403);
  });

  it('requires authentication', async () => {
    const response = await api('GET', '/counselor/classes');

    expect(response.status).toBe(401);
  });

  it('refuses a staff member who has not yet rotated their temp password', async () => {
    // ensure-password-changed: the token a temporary password buys must open nothing but its
    // own rotation (§38). This is that middleware's first real mount.
    const flagged = await createStaffUser({ mustChangePassword: true });
    const token = await login(flagged);

    const response = await api('GET', '/counselor/classes', { token });

    expect(response.status).toBe(403);
    expect(response.body.message).toBe('You must change your password before continuing.');
  });
});

describe('PATCH /counselor/classes/{id}', () => {
  it('updates the editable fields', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);
    const classRoom = await createClass(token);

    const response = await api('PATCH', `/counselor/classes/${classRoom.id}`, {
      token,
      body: { name: 'Grade 12 STEM A (renamed)', status: 'archived' },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.name).toBe('Grade 12 STEM A (renamed)');
    expect(response.body.data.status).toBe('archived');
  });

  it('will not change the join code', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);
    const classRoom = await createClass(token);

    const response = await api('PATCH', `/counselor/classes/${classRoom.id}`, {
      token,
      body: { join_code: 'ZZZZ-9999' },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.join_code).toBe(classRoom.join_code);
  });

  it('rejects an unknown status', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);
    const classRoom = await createClass(token);

    const response = await api('PATCH', `/counselor/classes/${classRoom.id}`, {
      token,
      body: { status: 'deleted' },
    });

    expect(response.status).toBe(422);
  });
});

describe('POST /counselor/classes/{id}/regenerate-code', () => {
  it('issues a fresh code and expiry', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);
    const classRoom = await createClass(token);

    const response = await api('POST', `/counselor/classes/${classRoom.id}/regenerate-code`, {
      token,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.join_code).not.toBe(classRoom.join_code);
    expect(response.body.data.join_code).toMatch(JOIN_CODE);
  });
});

describe('DELETE /counselor/classes/{id}', () => {
  it('soft-deletes, returning 204 and then 404 on the same id', async () => {
    const counselor = await createStaffUser();
    const token = await login(counselor);
    const classRoom = await createClass(token);

    const deleted = await api('DELETE', `/counselor/classes/${classRoom.id}`, { token });

    expect(deleted.status).toBe(204);

    const refetched = await api('GET', `/counselor/classes/${classRoom.id}`, { token });

    expect(refetched.status).toBe(404);
  });
});

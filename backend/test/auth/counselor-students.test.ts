import { describe, expect, it } from 'vitest';

import { api, createClass, createStaffUser, enrolStudents, login } from '../helpers';

/**
 * The counselor detail page's data — `GET /admin/counselors/{id}/students` (prompt-driven §20).
 *
 * "Assigned" means enrolled (active) in one of the counselor's live classes — the relationship §4
 * grants a counselor read access over. The endpoint is admin-only, scopes the roster to *this*
 * counselor's classes, and 404s a non-counselor id. A student with no assessments yet still appears,
 * with a null Holland Code and empty recommendation lists.
 */

async function admin(): Promise<string> {
  return login(await createStaffUser({ role: 'admin' }));
}

describe('GET /admin/counselors/{id}/students', () => {
  it("lists the counselor's enrolled students with their recommendation shape", async () => {
    const adminToken = await admin();
    const counselor = await createStaffUser({ role: 'counselor' });
    const counselorToken = await login(counselor);

    const classroom = await createClass(counselorToken);
    await enrolStudents(counselorToken, classroom.id, ['Juan Dela Cruz']);

    const response = await api('GET', `/admin/counselors/${counselor.id}/students`, {
      token: adminToken,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.counselor.id).toBe(counselor.id);

    const student = response.body.data.students.find((row: { name: string }) =>
      row.name.includes('Juan'),
    );

    expect(student).toBeDefined();
    // No assessments taken yet: a null Holland Code and empty recommendation lists, never absent keys.
    expect(student.holland_code).toBeNull();
    expect(student.top_careers).toEqual([]);
    expect(student.top_programs).toEqual([]);
  });

  it("does not leak another counselor's students", async () => {
    const adminToken = await admin();

    const counselorA = await createStaffUser({ role: 'counselor' });
    const classA = await createClass(await login(counselorA));
    await enrolStudents(await login(counselorA), classA.id, ['Only In A']);

    const counselorB = await createStaffUser({ role: 'counselor' });

    const response = await api('GET', `/admin/counselors/${counselorB.id}/students`, {
      token: adminToken,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.students).toEqual([]);
  });

  it('404s for a non-counselor id', async () => {
    const adminToken = await admin();
    const anotherAdmin = await createStaffUser({ role: 'admin' });

    const response = await api('GET', `/admin/counselors/${anotherAdmin.id}/students`, {
      token: adminToken,
    });

    expect(response.status).toBe(404);
  });

  it('is admin-only — a counselor cannot read it', async () => {
    const counselor = await createStaffUser({ role: 'counselor' });
    const counselorToken = await login(counselor);

    const response = await api('GET', `/admin/counselors/${counselor.id}/students`, {
      token: counselorToken,
    });

    expect(response.status).toBe(403);
  });
});

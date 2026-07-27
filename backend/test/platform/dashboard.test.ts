import { describe, expect, it } from 'vitest';

import {
  api,
  assessmentTaxonomyBody,
  createCareer,
  createClass,
  createCollege,
  createProgram,
  createStaffUser,
  enrolStudents,
  login,
  profileLookups,
} from '../helpers';

/**
 * The three §20 dashboard endpoints (Phase 6) — live §54 aggregates, one per role.
 *
 * Storage is shared across this file's tests (test/setup.ts), so numeric assertions are
 * either `toBeGreaterThanOrEqual` over globals or exact over rows the test itself scoped
 * (a counselor's own classes; a student's own assignments).
 */

describe('authorization', () => {
  it('each dashboard admits exactly its own role', async () => {
    const adminToken = await login(await createStaffUser({ role: 'admin' }));
    const counselorToken = await login(await createStaffUser({ role: 'counselor' }));

    // /admin/dashboard: admin only.
    expect((await api('GET', '/admin/dashboard', { token: counselorToken })).status).toBe(403);
    expect((await api('GET', '/admin/dashboard', { token: adminToken })).status).toBe(200);

    // /counselor/dashboard: counselor or admin (the same rule as every /counselor route).
    expect((await api('GET', '/counselor/dashboard', { token: counselorToken })).status).toBe(
      200,
    );
    expect((await api('GET', '/counselor/dashboard', { token: adminToken })).status).toBe(200);

    // /student/dashboard: students only — staff are refused.
    expect((await api('GET', '/student/dashboard', { token: adminToken })).status).toBe(403);
    expect((await api('GET', '/student/dashboard')).status).toBe(401);
  });
});

describe('GET /admin/dashboard', () => {
  it('reports live totals, the access/AI windows, and recent audit activity', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const adminToken = await login(admin);

    const college = await createCollege(adminToken);
    await createProgram(adminToken, college.id);
    await createCareer(adminToken);

    const counselor = await createStaffUser({ role: 'counselor' });
    const counselorToken = await login(counselor);
    const classRoom = await createClass(counselorToken);
    await enrolStudents(counselorToken, classRoom.id, ['Juan Dela Cruz', 'Maria Santos']);

    const response = await api('GET', '/admin/dashboard', { token: adminToken });

    expect(response.status).toBe(200);

    const data = response.body.data;

    expect(data.totals.students).toBeGreaterThanOrEqual(2);
    expect(data.totals.counselors).toBeGreaterThanOrEqual(1);
    expect(data.totals.classes).toBeGreaterThanOrEqual(1);
    expect(data.totals.colleges).toBeGreaterThanOrEqual(1);
    expect(data.totals.programs).toBeGreaterThanOrEqual(1);
    expect(data.totals.careers).toBeGreaterThanOrEqual(1);

    // Nothing has been attempted in this storage stack necessarily — the shape is the claim.
    expect(data.assessments).toHaveProperty('published_versions');
    expect(data.assessments).toHaveProperty('completion_rate');
    expect(data.student_access_7d).toMatchObject({});
    expect(typeof data.student_access_7d.success).toBe('number');
    expect(typeof data.ai_7d.requests).toBe('number');

    // The acts above were audited; the recent-activity strip carries real rows.
    expect(Array.isArray(data.recent_activity)).toBe(true);
    expect(data.recent_activity.length).toBeGreaterThan(0);
    expect(data.recent_activity[0]).toHaveProperty('action');
  });

  it('counts a student join in the 7-day access window', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const counselor = await createStaffUser({ role: 'counselor' });
    const counselorToken = await login(counselor);
    const classRoom = await createClass(counselorToken);
    const roster = await enrolStudents(counselorToken, classRoom.id, ['Jose Rizal']);

    const before = await api('GET', '/admin/dashboard', { token: await login(admin) });

    const join = await api('POST', '/student-access/join', {
      body: { class_code: classRoom.join_code, username: roster[0].username },
    });
    expect(join.status).toBe(200);

    const failed = await api('POST', '/student-access/join', {
      body: { class_code: classRoom.join_code, username: 'nobody.here' },
    });
    expect(failed.status).toBe(401);

    const after = await api('GET', '/admin/dashboard', { token: await login(admin) });

    expect(after.body.data.student_access_7d.success).toBeGreaterThan(
      before.body.data.student_access_7d.success,
    );
    expect(after.body.data.student_access_7d.failed).toBeGreaterThan(
      before.body.data.student_access_7d.failed,
    );
  });
});

describe('GET /counselor/dashboard', () => {
  it("scopes to the counselor's own classes, with per-class rows", async () => {
    const counselor = await createStaffUser({ role: 'counselor' });
    const token = await login(counselor);
    const classRoom = await createClass(token, { name: 'Dashboard Class A' });
    await enrolStudents(token, classRoom.id, ['Juan Dela Cruz', 'Maria Santos']);

    // Another counselor's world must not leak into this one's numbers.
    const other = await createStaffUser({ role: 'counselor' });
    const otherToken = await login(other);
    const otherClass = await createClass(otherToken, { name: 'Not Yours' });
    await enrolStudents(otherToken, otherClass.id, ['Pedro Reyes']);

    const response = await api('GET', '/counselor/dashboard', { token });

    expect(response.status).toBe(200);

    const data = response.body.data;

    expect(data.totals.classes).toBe(1);
    expect(data.totals.students).toBe(2);
    expect(data.totals.active_assignments).toBe(0);
    expect(data.classes).toHaveLength(1);
    expect(data.classes[0]).toMatchObject({
      id: classRoom.id,
      name: 'Dashboard Class A',
      students_count: 2,
      active_assignments: 0,
      scored_attempts: 0,
    });
    expect(data.students_with_recommendations).toBe(0);
  });

  it('a counselor with no classes gets zeros, not an error', async () => {
    const token = await login(await createStaffUser({ role: 'counselor' }));

    const response = await api('GET', '/counselor/dashboard', { token });

    expect(response.status).toBe(200);
    expect(response.body.data.totals).toEqual({
      classes: 0,
      students: 0,
      active_assignments: 0,
    });
    expect(response.body.data.classes).toEqual([]);
  });
});

describe('GET /student/dashboard', () => {
  it('reports assignments, profile completeness, and the unread badge', async () => {
    const counselor = await createStaffUser({ role: 'counselor' });
    const counselorToken = await login(counselor);
    const classRoom = await createClass(counselorToken);
    const roster = await enrolStudents(counselorToken, classRoom.id, ['Juan Dela Cruz']);

    const join = await api('POST', '/student-access/join', {
      body: { class_code: classRoom.join_code, username: roster[0].username },
    });
    const studentToken = join.body.data.token as string;

    // A published one-question CUSTOM assessment, assigned to the class.
    const template = await api('POST', '/assessment-templates', {
      token: counselorToken,
      body: {
        category: 'CUSTOM',
        title: 'Dashboard Fixture',
        ...(await assessmentTaxonomyBody()),
      },
    });
    const version = await api(
      'POST',
      `/assessment-templates/${template.body.data.id}/versions`,
      {
        token: counselorToken,
        body: {},
      },
    );
    await api('POST', `/assessment-versions/${version.body.data.id}/questions`, {
      token: counselorToken,
      body: {
        questions: [
          {
            question_text: 'I plan my week ahead.',
            question_type: 'LIKERT',
            options: [
              { label: 'Disagree', value: '1', score: 1 },
              { label: 'Agree', value: '5', score: 5 },
            ],
          },
        ],
      },
    });
    await api('POST', `/assessment-versions/${version.body.data.id}/publish`, {
      token: counselorToken,
      body: {},
    });
    const assignment = await api('POST', `/counselor/classes/${classRoom.id}/assignments`, {
      token: counselorToken,
      body: { assessment_version_id: version.body.data.id },
    });
    expect(assignment.status).toBe(201);

    const before = await api('GET', '/student/dashboard', { token: studentToken });

    expect(before.status).toBe(200);
    expect(before.body.data.assignments).toEqual({ active: 1, completed: 0, pending: 1 });
    expect(before.body.data.results_count).toBe(0);
    expect(before.body.data.recommendations_ready).toBe(false);
    expect(before.body.data.profile_complete).toBe(false);
    // The assignment fan-out (§44) already landed one unread notification.
    expect(before.body.data.unread_notifications).toBeGreaterThanOrEqual(1);

    // Complete the profile (§27's two engine inputs — a strand and an academic signal, which
    // since 2026-07-27 is a subject grade rather than the removed GWA) and the assignment.
    const profile = await api('PATCH', '/student/profile', {
      token: studentToken,
      body: { shs_strand_id: (await profileLookups()).academic, math_grade: 91 },
    });
    expect(profile.status).toBe(200);

    const attempt = await api('POST', `/student/assignments/${assignment.body.data.id}/start`, {
      token: studentToken,
    });
    const question = attempt.body.data.questions[0];
    await api('POST', `/student/attempts/${attempt.body.data.id}/answers`, {
      token: studentToken,
      body: { question_id: question.id, selected_option_id: question.options[0].id },
    });
    await api('POST', `/student/attempts/${attempt.body.data.id}/submit`, {
      token: studentToken,
    });

    const after = await api('GET', '/student/dashboard', { token: studentToken });

    expect(after.body.data.assignments).toEqual({ active: 1, completed: 1, pending: 0 });
    expect(after.body.data.results_count).toBe(1);
    expect(after.body.data.profile_complete).toBe(true);
  });
});

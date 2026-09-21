import { beforeAll, describe, expect, it } from 'vitest';

import {
  answerAll,
  api,
  assignVersion,
  classWithStudent,
  createStaffUser,
  login,
  seedInstruments,
  type StaffUserFixture,
} from '../helpers';

/**
 * The printable results export (`docs_report/`), end to end over HTTP.
 *
 * What makes this endpoint different from `GET /student/results/:id` is that it discloses the one
 * thing the player never may: which dimension each item loads onto and what its answer scored. So
 * the tests are as much about *when* that is allowed (a scored attempt, its own student) as about
 * what comes back.
 */

let admin: StaffUserFixture;
let counselor: StaffUserFixture;
let counselorToken: string;
let riasecVersionId: string;
let scctVersionId: string;

beforeAll(async () => {
  admin = await createStaffUser({ role: 'admin' });
  counselor = await createStaffUser({ role: 'counselor', name: 'Angeline P. Ravelo' });
  counselorToken = await login(counselor);

  const seeded = await seedInstruments(admin);

  riasecVersionId = seeded.riasecVersionId!;
  scctVersionId = seeded.scctVersionId!;
});

async function scoredRiasecAttempt(name = 'Maria Louise Fernandez') {
  const { classRoom, student, studentToken } = await classWithStudent(counselorToken, name);
  const assignment = await assignVersion(counselorToken, classRoom.id, riasecVersionId);

  const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
    token: studentToken,
  });
  const attempt = started.body.data;

  await answerAll(studentToken, attempt, (question) => {
    if (question.section_label === 'Investigative') return 4; // Strongly Agree → 5
    if (question.section_label === 'Artistic') return 3; // Agree → 4
    return 0; // Strongly Disagree → 1
  });

  await api('POST', `/student/attempts/${attempt.id}/submit`, { token: studentToken });

  return { classRoom, student, studentToken, attemptId: attempt.id as string };
}

describe('the printable report', () => {
  it('carries the result, the identity block and every item with its score', async () => {
    const { classRoom, student, studentToken, attemptId } = await scoredRiasecAttempt();

    const response = await api('GET', `/student/results/${attemptId}/report`, {
      token: studentToken,
    });

    expect(response.status).toBe(200);

    const report = response.body.data;

    // The plain result is still all there — this is a superset, not a different shape.
    expect(report.attempt_id).toBe(attemptId);
    expect(report.result.result_code).toBe('IAR');
    expect(report.dimensions.map((d: any) => d.code)).toEqual(['R', 'I', 'A', 'S', 'E', 'C']);

    // Who sat it, and under whom — the mockup's header table, from real rows.
    expect(report.student.name).toBe('Maria Louise Fernandez');
    expect(report.student.username).toBe(student.username);
    expect(report.class.name).toBe(classRoom.name);
    expect(report.counselor.name).toBe('Angeline P. Ravelo');
    expect(report.instrument).toEqual({
      version_number: 1,
      question_count: 60,
      composite_weights: null,
    });

    // Appendix A: all 60 items, in administered order, each with the score its answer carried.
    expect(report.items).toHaveLength(60);
    expect(report.items.map((item: any) => item.order_number)).toEqual(
      Array.from({ length: 60 }, (_, i) => i + 1),
    );

    const investigative = report.items.filter((item: any) =>
      item.loads_on.some((load: any) => load.code === 'I'),
    );

    expect(investigative).toHaveLength(10);
    for (const item of investigative) {
      expect(item.loads_on).toEqual([{ code: 'I', weight: 1 }]);
      expect(item.max_score).toBe(5);
      expect(item.answer).toEqual({ label: 'Strongly Agree', score: 5 });
    }

    // Raw = Σ answer scores per dimension, so the appendix and the breakdown must agree.
    const rawI = investigative.reduce((sum: number, item: any) => sum + item.answer.score, 0);
    expect(report.dimensions.find((d: any) => d.code === 'I').raw_score).toBe(rawI.toFixed(2));
  });

  /**
   * The point of letting a student rename themselves (prompt-driven, 2026-09-20): the name on the
   * record they export is the one they say is theirs, not the one a counselor typed off a class
   * list. The report reads `users.name`, which the profile save moves in the same batch as the
   * roster's copy — so an already-scored attempt re-exports under the new name without any of
   * this having to reach back into scoring.
   */
  it('prints the name the student corrected, on an attempt taken under the old one', async () => {
    const { student, studentToken, attemptId } = await scoredRiasecAttempt('Maria Fernandez');

    const before = await api('GET', `/student/results/${attemptId}/report`, {
      token: studentToken,
    });

    expect(before.body.data.student.name).toBe('Maria Fernandez');

    await api('PATCH', '/student/profile', {
      token: studentToken,
      body: { first_name: 'Maria Louise', last_name: 'Fernandez-Cruz' },
    });

    const after = await api('GET', `/student/results/${attemptId}/report`, {
      token: studentToken,
    });

    expect(after.body.data.student.name).toBe('Maria Louise Fernandez-Cruz');
    // The username on the same identity block is untouched — it is how they sign in, not what
    // they are called.
    expect(after.body.data.student.username).toBe(student.username);
  });

  /** SCCT (§23): the version's weights travel with the report so the index can be recomputed. */
  it('carries the composite weights for the SCCT instrument', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const assignment = await assignVersion(counselorToken, classRoom.id, scctVersionId);

    const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });

    await answerAll(studentToken, started.body.data, () => 4);
    await api('POST', `/student/attempts/${started.body.data.id}/submit`, {
      token: studentToken,
    });

    const response = await api('GET', `/student/results/${started.body.data.id}/report`, {
      token: studentToken,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.instrument).toEqual({
      version_number: 1,
      question_count: 30,
      composite_weights: { SE: 0.4, OE: 0.3, GO: 0.3 },
    });
    expect(response.body.data.items).toHaveLength(30);
    expect(response.body.data.result.result_code).toBeNull();
  });

  /**
   * Before scoring the appendix would be an answer key for the attempt in progress — the exact
   * disclosure `serializeQuestion` exists to prevent. 422, not 404: the attempt is the caller's.
   */
  it('refuses to report on an attempt that has not been scored', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const assignment = await assignVersion(counselorToken, classRoom.id, riasecVersionId);

    const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });

    const response = await api('GET', `/student/results/${started.body.data.id}/report`, {
      token: studentToken,
    });

    expect(response.status).toBe(422);
  });

  /** The standing rule: not yours and not real are indistinguishable from outside. */
  it('is a 404 for another student', async () => {
    const { attemptId } = await scoredRiasecAttempt();
    const other = await classWithStudent(counselorToken, 'Somebody Else');

    const response = await api('GET', `/student/results/${attemptId}/report`, {
      token: other.studentToken,
    });

    expect(response.status).toBe(404);
  });
});

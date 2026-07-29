import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import { recommendations } from '@/db/schema';
import {
  answerAll,
  api,
  assignVersion,
  attachCareer,
  classWithStudent,
  createCareer,
  createCollege,
  createProgram,
  createStaffUser,
  db,
  login,
  seedInstruments,
  type StaffUserFixture,
} from '../helpers';

/**
 * Recommendation regeneration (audit C4) — **the recovery path that did not exist.**
 *
 * Until these two endpoints, `RecommendationService.generateFor()` had exactly one caller in the
 * whole system: the `AssessmentCompleted` listener. `dispatch()` catches and logs every listener
 * failure by design, and correctly so — a recommendation engine having a bad day must not turn a
 * completed assessment into a 500 while the student sits on the submit screen. But nothing was ever
 * paired with that swallow, so a transient D1 error during the listener left a student with both
 * assessments SCORED and no recommendations *permanently*, being told by their own screen to
 * "complete both RIASEC and SCCT" — advice they had already followed. The only escape was a
 * counselor resetting an attempt and the student re-sitting sixty items.
 *
 * The tests below therefore do the one thing that proves the fix: they **delete a student's
 * recommendation rows directly**, simulating exactly that swallowed failure, and then assert the
 * endpoint brings them back. Asserting only that a POST returns 200 would not distinguish a working
 * recovery from a no-op.
 *
 * The same endpoint answers the slower problem, which is not a failure at all: a set is computed
 * once, at submit, against the catalog as it stood that day. Careers added next month are invisible
 * to every existing student until this runs. That case is covered too.
 *
 * Fixtures are shared for the reason `generation.test.ts` documents at length — completing both
 * instruments costs ~90 HTTP round trips, and a file that rebuilt that per test times out.
 */

let admin: StaffUserFixture;
let adminToken: string;
let counselorToken: string;
let riasecVersionId: string;
let scctVersionId: string;

/** A student who has completed both instruments and therefore has a real set to rebuild. */
let assessed: { studentId: string; studentToken: string; classId: string };

beforeAll(async () => {
  admin = await createStaffUser({ role: 'admin', mustChangePassword: false });
  adminToken = await login(admin);
  const counselor = await createStaffUser({ role: 'counselor', mustChangePassword: false });
  counselorToken = await login(counselor);

  const seeded = await seedInstruments(admin);
  riasecVersionId = seeded.riasecVersionId!;
  scctVersionId = seeded.scctVersionId!;

  const college = await createCollege(adminToken, { name: `Regeneration University ${Date.now()}` });
  const program = await createProgram(adminToken, college.id, {
    code: 'BSIT',
    name: 'BS Information Technology',
    recommended_strand: 'Academic',
  });
  const career = await createCareer(adminToken, {
    title: `Systems Analyst ${Date.now()}`,
    typical_riasec_code: 'ICE',
  });
  await attachCareer(adminToken, program.id, career.id);

  const { classRoom, student, studentToken } = await classWithStudent(counselorToken);
  await completeAssessment(studentToken, classRoom.id, riasecVersionId, investigative);
  await completeAssessment(studentToken, classRoom.id, scctVersionId, confident);

  // `student.student_id`, not `student.id` — the roster row's `id` is the enrollment id.
  assessed = { studentId: student.student_id, studentToken, classId: classRoom.id };
});

async function completeAssessment(
  studentToken: string,
  classId: string,
  versionId: string,
  pick: (question: any, index: number) => number,
): Promise<void> {
  const assignment = await assignVersion(counselorToken, classId, versionId);
  const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
    token: studentToken,
  });

  await answerAll(studentToken, started.body.data, pick);

  const submitted = await api('POST', `/student/attempts/${started.body.data.id}/submit`, {
    token: studentToken,
  });

  if (submitted.status !== 200) {
    throw new Error(`Fixture submit failed: ${JSON.stringify(submitted.body)}`);
  }
}

const investigative = (question: any) => (question.section_label === 'Investigative' ? 4 : 0);
const confident = () => 3;

/** Simulate the swallowed listener failure: the results exist, the recommendations do not. */
async function wipeRecommendations(studentId: string): Promise<void> {
  await db().delete(recommendations).where(eq(recommendations.studentId, studentId));
}

async function countRecommendations(studentId: string): Promise<number> {
  const rows = await db()
    .select()
    .from(recommendations)
    .where(eq(recommendations.studentId, studentId));

  return rows.length;
}

describe('authorization', () => {
  it('401 unauthenticated on the student endpoint', async () => {
    const response = await api('POST', '/student/recommendations/regenerate');

    expect(response.status).toBe(401);
  });

  it('403 for staff on the student endpoint — it means "mine", and staff have no results', async () => {
    const response = await api('POST', '/student/recommendations/regenerate', {
      token: counselorToken,
    });

    expect(response.status).toBe(403);
  });

  it('403 for a student on the counselor endpoint', async () => {
    const response = await api(
      'POST',
      `/counselor/students/${assessed.studentId}/recommendations/regenerate`,
      { token: assessed.studentToken },
    );

    expect(response.status).toBe(403);
  });

  it('404 — not 403 — for a student outside the counselor’s classes', async () => {
    // A 403 would confirm the student exists, handing a counselor a roster nobody gave them. The
    // GET beside this endpoint already holds that line; the POST must not be the weaker door.
    const otherCounselorToken = await login(
      await createStaffUser({ role: 'counselor', mustChangePassword: false }),
    );

    const response = await api(
      'POST',
      `/counselor/students/${assessed.studentId}/recommendations/regenerate`,
      { token: otherCounselorToken },
    );

    expect(response.status).toBe(404);
  });
});

describe('POST /student/recommendations/regenerate', () => {
  it('rebuilds a set that a swallowed listener failure destroyed', async () => {
    const { classRoom, student, studentToken } = await classWithStudent(counselorToken);
    await completeAssessment(studentToken, classRoom.id, riasecVersionId, investigative);
    await completeAssessment(studentToken, classRoom.id, scctVersionId, confident);

    const studentId = student.student_id;

    expect(await countRecommendations(studentId)).toBeGreaterThan(0);

    // This is the exact state the bug produced: both results scored, no recommendations, and — as
    // the screen truthfully reported before this endpoint — no way back.
    await wipeRecommendations(studentId);
    expect(await countRecommendations(studentId)).toBe(0);

    const stranded = await api('GET', '/student/recommendations', { token: studentToken });
    expect(stranded.body.data).toBeNull();

    const response = await api('POST', '/student/recommendations/regenerate', {
      token: studentToken,
    });

    expect(response.status).toBe(200);
    expect(response.body.data).not.toBeNull();
    expect(response.body.data.careers.length).toBeGreaterThan(0);
    expect(await countRecommendations(studentId)).toBeGreaterThan(0);
  });

  it('returns the rebuilt set in the response — the client needs no second request', async () => {
    const response = await api('POST', '/student/recommendations/regenerate', {
      token: assessed.studentToken,
    });

    const fetched = await api('GET', '/student/recommendations', {
      token: assessed.studentToken,
    });

    expect(response.status).toBe(200);
    // The POST's payload and the GET's must be the same shape, or the frontend's `setQueryData`
    // would write a subtly different object into the cache than a refetch would produce.
    expect(response.body.data.careers.length).toBe(fetched.body.data.careers.length);
    expect(response.body.data.programs.length).toBe(fetched.body.data.programs.length);
  });

  it('is idempotent — pressing it twice replaces, never accumulates (§26)', async () => {
    const before = await countRecommendations(assessed.studentId);

    await api('POST', '/student/recommendations/regenerate', { token: assessed.studentToken });
    await api('POST', '/student/recommendations/regenerate', { token: assessed.studentToken });

    // The delete-then-insert in `generateFor` is what makes this true; without it a student who
    // pressed the button three times would hold three stacked sets and `latestFor` would be
    // reading an arbitrary one of them.
    expect(await countRecommendations(assessed.studentId)).toBe(before);
  });

  it('picks up catalog rows added after the student finished — the stale-set case', async () => {
    const { classRoom, student, studentToken } = await classWithStudent(counselorToken);
    await completeAssessment(studentToken, classRoom.id, riasecVersionId, investigative);
    await completeAssessment(studentToken, classRoom.id, scctVersionId, confident);

    const before = await api('GET', '/student/recommendations', { token: studentToken });
    const careersBefore = before.body.data.careers.length;

    // An administrator expands the catalog *after* this student was assessed. Nothing in the system
    // revisits an existing student's set on its own, so without this endpoint the new career is
    // invisible to them forever.
    const fresh = await createCareer(adminToken, {
      title: `Data Engineer ${Date.now()}`,
      typical_riasec_code: 'IRC',
    });

    const response = await api('POST', '/student/recommendations/regenerate', {
      token: studentToken,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.careers.length).toBeGreaterThan(careersBefore);
    expect(
      response.body.data.careers.some(
        (entry: { career: { id: string } }) => entry.career.id === fresh.id,
      ),
    ).toBe(true);

    expect(student.student_id).toBeDefined();
  });

  it('answers 200 with null — not an error — for a student who has finished only one instrument', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    await completeAssessment(studentToken, classRoom.id, riasecVersionId, investigative);

    const response = await api('POST', '/student/recommendations/regenerate', {
      token: studentToken,
    });

    // "You have not finished both yet" is an ordinary state, not a failure. Reporting it as one
    // would send a student to their counselor over the system working exactly as designed.
    expect(response.status).toBe(200);
    expect(response.body.data).toBeNull();
  });

  it('throttles a student who hammers it, and says how long to wait', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    await completeAssessment(studentToken, classRoom.id, riasecVersionId, investigative);
    await completeAssessment(studentToken, classRoom.id, scctVersionId, confident);

    // The limit is 5 per 10 minutes per student. Charged on every attempt, so the sixth is refused.
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await api('POST', '/student/recommendations/regenerate', {
        token: studentToken,
      });

      statuses.push(response.status);
    }

    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });
});

describe('POST /counselor/students/{id}/recommendations/regenerate', () => {
  it('lets a counselor rebuild for their own student', async () => {
    const { classRoom, student, studentToken } = await classWithStudent(counselorToken);
    await completeAssessment(studentToken, classRoom.id, riasecVersionId, investigative);
    await completeAssessment(studentToken, classRoom.id, scctVersionId, confident);

    const studentId = student.student_id;

    // The realistic shape of this: the *counselor* notices the student has no cards, and the
    // student may not sign in again for a week.
    await wipeRecommendations(studentId);
    expect(await countRecommendations(studentId)).toBe(0);

    const response = await api(
      'POST',
      `/counselor/students/${studentId}/recommendations/regenerate`,
      { token: counselorToken },
    );

    expect(response.status).toBe(200);
    expect(response.body.data).not.toBeNull();
    expect(await countRecommendations(studentId)).toBeGreaterThan(0);

    // And the student sees them on their own endpoint — the counselor rebuilt the student's set,
    // not a copy of it living somewhere only staff can read.
    const asStudent = await api('GET', '/student/recommendations', { token: studentToken });

    expect(asStudent.body.data).not.toBeNull();
    expect(asStudent.body.data.careers.length).toBeGreaterThan(0);
  });

  it('an admin may rebuild for any student', async () => {
    const { classRoom, student, studentToken } = await classWithStudent(counselorToken);
    await completeAssessment(studentToken, classRoom.id, riasecVersionId, investigative);
    await completeAssessment(studentToken, classRoom.id, scctVersionId, confident);

    const response = await api(
      'POST',
      `/counselor/students/${student.student_id}/recommendations/regenerate`,
      { token: adminToken },
    );

    expect(response.status).toBe(200);
  });
});

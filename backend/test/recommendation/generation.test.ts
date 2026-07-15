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
 * Phase 4 — recommendation generation (FULLPLAN §11 v1.2, §26, §27).
 *
 * The §27 *arithmetic* is already pinned, hard, in `test/unit/recommendation.test.ts` — against
 * §28's hand-computed numbers rather than against the engine's own output, which is the only thing
 * that holds §26's reproducibility claim to account. None of that is retested here.
 *
 * What this file tests is everything the pure engine cannot see: **when** generation runs, what it
 * reads, what it persists, and who is allowed to read it back.
 *
 * ## Why the fixtures are shared, which is not the habit elsewhere in this suite
 *
 * Completing one assessment means POSTing every answer individually through the real HTTP surface —
 * 60 requests for RIASEC, 30 for SCCT — and a student needs *both* before a single recommendation
 * exists. A test that builds its own fully-assessed student from scratch costs ~90 round trips, and
 * the first draft of this file did that thirteen times and blew through the 60-second timeout.
 *
 * So the read-only assertions share one student who has completed both. The tests that genuinely
 * need a *different* history — one assessment only, or a resubmission — still build their own,
 * because sharing a fixture whose whole point is its state would test nothing. Storage is not
 * rolled back between tests in a file (`isolatedStorage` is gone), so every fixture identifies its
 * own rows and none of them assert on "the only row in the table".
 */

let admin: StaffUserFixture;
let adminToken: string;
let counselorToken: string;
let riasecVersionId: string;
let scctVersionId: string;

/** One student who has completed both instruments — the subject of every read-only assertion. */
let assessed: { studentId: string; studentToken: string; classId: string };
/** Their recommendations, fetched once. */
let recommendationSet: any;

beforeAll(async () => {
  admin = await createStaffUser({ role: 'admin', mustChangePassword: false });
  adminToken = await login(admin);
  const counselor = await createStaffUser({ role: 'counselor', mustChangePassword: false });
  counselorToken = await login(counselor);

  const seeded = await seedInstruments(admin);
  riasecVersionId = seeded.riasecVersionId!;
  scctVersionId = seeded.scctVersionId!;

  // A catalog to rank. Without it every student gets an empty — technically correct, entirely
  // useless — recommendation set, and every assertion below would pass vacuously.
  const college = await createCollege(adminToken, {
    name: `Recommendation University ${Date.now()}`,
  });
  const program = await createProgram(adminToken, college.id, {
    code: 'BSCS',
    name: 'BS Computer Science',
    recommended_strand: 'Academic',
  });
  const career = await createCareer(adminToken, {
    title: `Software Engineer ${Date.now()}`,
    typical_riasec_code: 'IEC',
  });
  await attachCareer(adminToken, program.id, career.id);

  const { classRoom, student, studentToken } = await classWithStudent(counselorToken);
  await completeAssessment(studentToken, classRoom.id, riasecVersionId, investigative);
  await completeAssessment(studentToken, classRoom.id, scctVersionId, confident);

  // `student.student_id`, NOT `student.id`. A roster row's `id` is the *enrollment* id
  // (`class_students.id`); the user id is `student_id`. The first draft of this file passed the
  // enrollment id and the policy correctly 404'd it — which is the policy doing its job, and worth
  // recording here because the two ids are both UUIDs and the mistake is invisible at a glance.
  assessed = { studentId: student.student_id, studentToken, classId: classRoom.id };

  const response = await api('GET', '/student/recommendations', { token: studentToken });
  recommendationSet = response.body.data;
});

/**
 * Take one assessment end to end, through the real HTTP surface, and have it scored.
 *
 * `pick` decides the answers, so a test can shape a student's profile — an Investigative student
 * and a Social one must not receive the same ranking, and a fixture that cannot tell them apart
 * would not be exercising §27 at all.
 */
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

/** Strongly Agree on Investigative, Strongly Disagree elsewhere — a decisively Investigative student. */
const investigative = (question: any) => (question.section_label === 'Investigative' ? 4 : 0);

/** Agree throughout. SCCT has no "wrong" answer; the ranking just needs a confidence index to exist. */
const confident = () => 3;

describe('the both-results-exist rule (§11, v1.2 — it lives in the LISTENER, not the event)', () => {
  it('generates NOTHING after RIASEC alone', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);

    await completeAssessment(studentToken, classRoom.id, riasecVersionId, investigative);

    const response = await api('GET', '/student/recommendations', { token: studentToken });

    // 200 with `data: null`, NOT a 404. "You have none yet" and "we could not load them" are
    // different facts, and D11 is the standing proof of what happens to a student when a screen
    // cannot tell them apart.
    expect(response.status).toBe(200);
    expect(response.body.data).toBeNull();
  });

  it('generates NOTHING after SCCT alone', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);

    await completeAssessment(studentToken, classRoom.id, scctVersionId, confident);

    const response = await api('GET', '/student/recommendations', { token: studentToken });

    expect(response.body.data).toBeNull();
  });

  it('generates as soon as the SECOND of the two lands — SCCT first, RIASEC second', async () => {
    // The reverse order of the shared fixture. §27 needs both and does not care which arrived last,
    // and neither assessment needs to know it is the second one — which is precisely why the check
    // is in the listener rather than in the event.
    const { classRoom, studentToken } = await classWithStudent(counselorToken);

    await completeAssessment(studentToken, classRoom.id, scctVersionId, confident);
    await completeAssessment(studentToken, classRoom.id, riasecVersionId, investigative);

    const response = await api('GET', '/student/recommendations', { token: studentToken });

    expect(response.status).toBe(200);
    expect(response.body.data).not.toBeNull();
    expect(response.body.data.careers.length).toBeGreaterThan(0);
    expect(response.body.data.programs.length).toBeGreaterThan(0);
  });
});

describe('what gets persisted (§27)', () => {
  it('generated a set for the student who completed both', () => {
    expect(recommendationSet).not.toBeNull();
    expect(recommendationSet.careers.length).toBeGreaterThan(0);
    expect(recommendationSet.programs.length).toBeGreaterThan(0);
  });

  it('ranks 1..N within each type — the two types are ranked separately', () => {
    const careerRanks = recommendationSet.careers.map((r: any) => r.ranking);
    const programRanks = recommendationSet.programs.map((r: any) => r.ranking);

    // Each type starts at its own 1. A career's score and a program's score come from different
    // formulas with different weights (§27) and are not comparable, so one global ranking across
    // both would be a number that means nothing.
    expect(careerRanks[0]).toBe(1);
    expect(programRanks[0]).toBe(1);
    expect(careerRanks).toEqual([...careerRanks].sort((a: number, b: number) => a - b));

    // Descending by score, which is what "ranking" claims to mean.
    const scores = recommendationSet.careers.map((r: any) => r.match_score);
    expect(scores).toEqual([...scores].sort((a: number, b: number) => b - a));
  });

  it('persists at most the top 10 of each type (§27)', () => {
    expect(recommendationSet.careers.length).toBeLessThanOrEqual(10);
    expect(recommendationSet.programs.length).toBeLessThanOrEqual(10);
  });

  it('carries a deterministic reason on every row — §3 forbids a recommendation without one', () => {
    for (const row of [...recommendationSet.careers, ...recommendationSet.programs]) {
      expect(row.reason).toBeTruthy();
      // This student answered every Investigative item at the ceiling, so Investigative *is* their
      // top dimension and the sentence must say so. A reason naming a different dimension than the
      // one the Holland Code leads with would be worse than no reason at all.
      expect(row.reason).toContain('Investigative');
    }
  });

  it('nests the college on a program recommendation — §13.6 makes it a join, not a stored match', () => {
    expect(recommendationSet.programs[0].college).toBeDefined();
    expect(recommendationSet.programs[0].college.name).toBeTruthy();
  });

  it('anchors the set to the RIASEC result the ranking was computed over', () => {
    expect(recommendationSet.assessment_result_id).toBeTruthy();
  });
});

describe('idempotence (§26 — the same inputs produce the same ranking)', () => {
  it('regenerating replaces the set rather than duplicating it', async () => {
    // Its own student: this test *resubmits*, so it changes the state it depends on.
    const { classRoom, studentToken } = await classWithStudent(counselorToken);

    await completeAssessment(studentToken, classRoom.id, riasecVersionId, investigative);
    await completeAssessment(studentToken, classRoom.id, scctVersionId, confident);

    const first = await api('GET', '/student/recommendations', { token: studentToken });
    const resultId = first.body.data.assessment_result_id;

    const countRows = async () =>
      (
        await db()
          .select()
          .from(recommendations)
          .where(eq(recommendations.assessmentResultId, resultId))
      ).length;

    const before = await countRows();
    expect(before).toBeGreaterThan(0);

    // A second SCCT attempt fires the listener again against the *same* RIASEC result. Without the
    // delete-then-insert in one batch this would try to leave a second rank-1 career behind — which
    // the unique index on (assessment_result_id, match_type, ranking) would reject. Either way the
    // count must not move.
    await completeAssessment(studentToken, classRoom.id, scctVersionId, confident);

    expect(await countRows()).toBe(before);

    const second = await api('GET', '/student/recommendations', { token: studentToken });

    // Deterministic: identical inputs, identical ranking. §26 promises exactly this, and a student
    // whose cards silently reshuffle between two visits has been told the ranking is arbitrary.
    expect(
      second.body.data.careers.map((r: any) => [r.ranking, r.career.id, r.match_score]),
    ).toEqual(first.body.data.careers.map((r: any) => [r.ranking, r.career.id, r.match_score]));
  });
});

describe('authorization (§4, §39, §40)', () => {
  it("lets a counselor read their OWN student's recommendations", async () => {
    const response = await api(
      'GET',
      `/counselor/students/${assessed.studentId}/recommendations`,
      { token: counselorToken },
    );

    expect(response.status).toBe(200);
    expect(response.body.data.careers.length).toBeGreaterThan(0);
  });

  it("404s — not 403s — on ANOTHER counselor's student", async () => {
    const stranger = await createStaffUser({ role: 'counselor', mustChangePassword: false });
    const strangerToken = await login(stranger);

    const response = await api(
      'GET',
      `/counselor/students/${assessed.studentId}/recommendations`,
      { token: strangerToken },
    );

    // 404, deliberately. A 403 would confirm the student exists — and a counselor who can enumerate
    // student ids by watching status codes has been handed a roster nobody gave them.
    expect(response.status).toBe(404);
  });

  it('lets an admin read any student (§4 — the admin scope is the institution)', async () => {
    const response = await api(
      'GET',
      `/counselor/students/${assessed.studentId}/recommendations`,
      { token: adminToken },
    );

    expect(response.status).toBe(200);
  });

  it('refuses a student reaching the counselor route, even for themselves', async () => {
    const response = await api(
      'GET',
      `/counselor/students/${assessed.studentId}/recommendations`,
      { token: assessed.studentToken },
    );

    // 403 from `ensureRole`, and this one *is* correctly a 403: the role gate refuses the kind of
    // caller before any record is looked at, so it leaks nothing about whether the student exists.
    expect(response.status).toBe(403);
  });

  it('never lets one student see another — the student route has no id to tamper with', async () => {
    // A second student, in a different class, who has completed nothing. `GET /student/
    // recommendations` means *mine*, resolved from the token: there is no parameter to change, and
    // that is a structural property rather than a check that could be forgotten.
    const other = await classWithStudent(counselorToken, 'Maria Clara');

    const response = await api('GET', '/student/recommendations', {
      token: other.studentToken,
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toBeNull();
  });
});

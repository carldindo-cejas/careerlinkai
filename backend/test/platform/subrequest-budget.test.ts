import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '@/db/client';
import {
  assessmentAttempts,
  assessmentDimensions,
  assessmentResults,
  assessmentVersions,
  dimensionScores,
  users,
} from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { AssessmentAttemptService } from '@/modules/assessment/assessment-attempt-service';
import { AssessmentBuilderService } from '@/modules/assessment/assessment-builder-service';
import {
  answerAll,
  api,
  assessmentTaxonomyBody,
  assignVersion,
  attachCareer,
  classWithStudent,
  createCareer,
  createClass,
  createCollege,
  createProgram,
  createStaffUser,
  db,
  enrolStudents,
  findUser,
  joinClass,
  login,
  seedInstruments,
} from '../helpers';

/**
 * The subrequest budget (FULLPLAN §45, Phase 4.5 Step 2).
 *
 * A **free** Worker invocation may make at most **50 subrequests**, and every D1 query, KV
 * op, AI call, Vectorize op and queue send counts against it. Miniflare enforces no such
 * limit, which puts this squarely in the class of bug that has now shipped three times: the
 * N+1 in the first `rankPrograms` passed every local test and generated nothing at all on
 * the deployed Worker.
 *
 * So, as with the PBKDF2 cap and the D1 parameter ceiling, the test asserts on **what the
 * code asks of the platform**: it counts every executed D1 statement and every `batch()`
 * call on the heaviest request in the system — a student's submit that scores inline AND
 * runs full recommendation generation inline (deviation D17) — and holds it to **≤ 27**.
 * The margin is the point: the gate should fire on the feature that *approaches* the
 * cliff, not the one that falls off it.
 *
 * Budget history — every move must be explained here, that is the deal:
 *   * Phase 4.5: set at 25 (half the cap). First run measured **35** and forced a real
 *     trim to ~24 (see PROGRESS.md, Phase 4.5 Step 2).
 *   * Phase 6: raised 25 → 27. The §44 notification listeners put exactly two INSERTs on
 *     this path — "your results are ready" and "your recommendations are ready" — which
 *     are required writes, not waste; the measured count moved 24 → 26. Headroom stays
 *     comfortable (26 of 50) and the gate still fires on the next two-query feature.
 *
 * (Phase 5a's ingestion batch gets its own budget test when it lands — see the batching
 * contract in §33.)
 */

interface SubrequestCounter {
  calls: number;
}

/** Count what D1 is actually asked to execute: one per statement run, one per `batch()` call. */
function countingD1(real: D1Database, counter: SubrequestCounter): D1Database {
  function countingStatement(statement: D1PreparedStatement): D1PreparedStatement {
    return new Proxy(statement, {
      get(target, prop, receiver) {
        if (prop === 'bind') {
          return (...values: unknown[]) => countingStatement(target.bind(...values));
        }

        if (prop === 'all' || prop === 'run' || prop === 'first' || prop === 'raw') {
          return (...args: unknown[]) => {
            counter.calls += 1;

            return (target[prop] as (...a: unknown[]) => unknown)(...args);
          };
        }

        return Reflect.get(target, prop, receiver);
      },
    });
  }

  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (query: string) => countingStatement(target.prepare(query));
      }

      if (prop === 'batch') {
        // One `batch()` is one round trip to the binding, however many statements it carries.
        return (statements: D1PreparedStatement[]) => {
          counter.calls += 1;

          return target.batch(statements);
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

describe('the Free-plan 50-subrequest ceiling (§45)', () => {
  let studentId: string;
  let scctAttemptId: string;

  beforeAll(async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const adminToken = await login(admin);
    const counselor = await createStaffUser({ role: 'counselor' });
    const counselorToken = await login(counselor);

    // A real catalog, so generation ranks actual rows rather than an empty set.
    const college = await createCollege(adminToken);
    const program = await createProgram(adminToken, college.id);
    const career = await createCareer(adminToken, { typical_riasec_code: 'IEC' });
    await attachCareer(adminToken, program.id, career.id);

    const seeded = await seedInstruments(admin);

    const { classRoom, student, studentToken } = await classWithStudent(counselorToken);
    // `student_id`, not `id`: a roster row's `id` is the enrollment id (`class_students.id`).
    studentId = student.student_id;

    // RIASEC end to end over HTTP — after this, one of the two results exists.
    const riasecAssignment = await assignVersion(
      counselorToken,
      classRoom.id,
      seeded.riasecVersionId!,
    );
    const riasecStart = await api('POST', `/student/assignments/${riasecAssignment.id}/start`, {
      token: studentToken,
    });
    const riasecAttempt = await api('GET', `/student/attempts/${riasecStart.body.data.id}`, {
      token: studentToken,
    });
    await answerAll(studentToken, riasecAttempt.body.data, () => 3);
    await api('POST', `/student/attempts/${riasecStart.body.data.id}/submit`, {
      token: studentToken,
    });

    // SCCT answered but NOT submitted — the measured call below is its submit, which is the
    // worst case: inline scoring plus full inline recommendation generation (D17).
    const scctAssignment = await assignVersion(
      counselorToken,
      classRoom.id,
      seeded.scctVersionId!,
    );
    const scctStart = await api('POST', `/student/assignments/${scctAssignment.id}/start`, {
      token: studentToken,
    });
    scctAttemptId = scctStart.body.data.id as string;
    const scctAttempt = await api('GET', `/student/attempts/${scctAttemptId}`, {
      token: studentToken,
    });
    await answerAll(studentToken, scctAttempt.body.data, () => 3);
  });

  it('submit-with-inline-generation stays well within the platform cap (≤ 27 D1 calls)', async () => {
    const counter: SubrequestCounter = { calls: 0 };
    const db = createDatabase(countingD1(env.DB, counter));
    const student = await findUser(studentId);

    const view = await new AssessmentAttemptService(db, env).submit(student!, scctAttemptId);

    // Logged so a budget regression can be seen approaching across runs, not just crossing.
    console.info(
      `submit-with-inline-generation: ${counter.calls} D1 calls (budget 27, platform cap 50)`,
    );

    // The path under measurement must have actually done the work: a scored SCCT attempt,
    // and — both results now existing — a persisted recommendation set behind it.
    expect(view.attempt.status).toBe('SCORED');
    expect(counter.calls).toBeGreaterThan(0);
    expect(counter.calls).toBeLessThanOrEqual(27);
  });
});

/**
 * The results-listing budget (§45, A3 — the C1 hole the original budget test never covered).
 *
 * C1's failure is invisible to every other test because Miniflare enforces no subrequest cap.
 * So, exactly as above, this asserts on **what the code asks of the platform**: a class results
 * listing must cost a *fixed, small* number of D1 calls no matter how many scored attempts the
 * class holds. Before A1 it was ~5 per row — a 40-student class doing RIASEC+SCCT was ~400
 * subrequests against a 50 cap, a guaranteed 500 the moment a real class finished. After A1 the
 * whole page is hydrated in a handful of set queries, whatever N is.
 */
describe('the results-listing budget is O(1) in the number of rows (§45, C1/A3)', () => {
  /** Insert `count` distinct students, each with one SCORED attempt (result + dimension scores). */
  async function seedScoredAttempts(params: {
    assignmentId: string;
    versionId: string;
    dimensionIds: string[];
    count: number;
    student?: string;
  }): Promise<void> {
    const database = db();

    for (let i = 0; i < params.count; i += 1) {
      const timestamp = now();
      const attemptId = uuid();
      let studentId = params.student;

      // A distinct student per row unless one is pinned (the single-student listing seeds one
      // student across many assignments instead — the live-attempt unique index forbids two
      // non-EXPIRED attempts on the same (assignment, student) pair).
      if (studentId === undefined) {
        studentId = uuid();
        await database.insert(users).values({
          id: studentId,
          name: `Budget Student ${i}`,
          email: `budget.${uuid().slice(0, 8)}@school.test`,
          password: null,
          role: 'student',
          status: 'active',
          mustChangePassword: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }

      await database.insert(assessmentAttempts).values({
        id: attemptId,
        assignmentId: params.assignmentId,
        assessmentVersionId: params.versionId,
        studentId,
        status: 'SCORED',
        startedAt: timestamp,
        submittedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      await database.insert(assessmentResults).values({
        id: uuid(),
        attemptId,
        overallSummary: 'Realistic, Investigative, Artistic.',
        resultCode: 'RIA',
        generatedAt: timestamp,
      });

      await database.insert(dimensionScores).values(
        params.dimensionIds.map((dimensionId) => ({
          id: uuid(),
          attemptId,
          dimensionId,
          rawScore: 12,
          normalizedScore: 60,
          interpretation: 'Moderate',
          createdAt: timestamp,
        })),
      );
    }
  }

  let counselorToken: string;
  let counselorId: string;
  let riasecVersionId: string;
  let dimensionIds: string[];

  beforeAll(async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const counselor = await createStaffUser({ role: 'counselor' });
    counselorToken = await login(counselor);
    counselorId = counselor.id;

    const seeded = await seedInstruments(admin);
    riasecVersionId = seeded.riasecVersionId!;

    const [version] = await db()
      .select()
      .from(assessmentVersions)
      .where(eq(assessmentVersions.id, riasecVersionId))
      .limit(1);
    const dimensions = await db()
      .select()
      .from(assessmentDimensions)
      .where(eq(assessmentDimensions.assessmentTemplateId, version!.assessmentTemplateId));
    dimensionIds = dimensions.map((dimension) => dimension.id);
  });

  it('class results at N=40 scored attempts stays a small constant (≤ 15 D1 calls)', async () => {
    const classRoom = await createClass(counselorToken);
    const assignment = await assignVersion(counselorToken, classRoom.id, riasecVersionId);

    await seedScoredAttempts({
      assignmentId: assignment.id,
      versionId: riasecVersionId,
      dimensionIds,
      count: 40,
    });

    const counter: SubrequestCounter = { calls: 0 };
    const countingDb = createDatabase(countingD1(env.DB, counter));
    const counselor = await findUser(counselorId);

    const page = await new AssessmentAttemptService(countingDb, env).listResultsForClass(
      counselor!,
      classRoom.id,
      1,
      50,
    );

    console.info(
      `class-results @ N=40: ${counter.calls} D1 calls (budget 15, platform cap 50)`,
    );

    expect(page.views).toHaveLength(40);
    expect(page.total).toBe(40);
    expect(counter.calls).toBeGreaterThan(0);
    expect(counter.calls).toBeLessThanOrEqual(15);
  });

  it('student results across several assignments stays a small constant (≤ 12 D1 calls)', async () => {
    // One student, six SCORED attempts on six assignments in one class — the live-attempt unique
    // index forbids stacking them on a single assignment, so each gets its own.
    const classRoom = await createClass(counselorToken);
    const studentId = uuid();
    const timestamp = now();

    await db()
      .insert(users)
      .values({
        id: studentId,
        name: 'Solo Budget Student',
        email: `solo.${uuid().slice(0, 8)}@school.test`,
        password: null,
        role: 'student',
        status: 'active',
        mustChangePassword: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      });

    for (let i = 0; i < 6; i += 1) {
      const assignment = await assignVersion(counselorToken, classRoom.id, riasecVersionId);
      await seedScoredAttempts({
        assignmentId: assignment.id,
        versionId: riasecVersionId,
        dimensionIds,
        count: 1,
        student: studentId,
      });
    }

    const counter: SubrequestCounter = { calls: 0 };
    const countingDb = createDatabase(countingD1(env.DB, counter));
    const student = await findUser(studentId);

    const page = await new AssessmentAttemptService(countingDb, env).listResultsForStudent(
      student!,
      1,
      25,
    );

    console.info(
      `student-results @ N=6: ${counter.calls} D1 calls (budget 12, platform cap 50)`,
    );

    expect(page.views).toHaveLength(6);
    expect(page.total).toBe(6);
    expect(counter.calls).toBeGreaterThan(0);
    expect(counter.calls).toBeLessThanOrEqual(12);
  });
});

/**
 * The per-row fans Phase D batched (§45, H5) — the same "N queries per unpaginated list" pattern
 * as C1, one blast radius down. These pin them at a fixed cost so a future edit cannot quietly
 * reintroduce the fan-out.
 */
describe('the H5 list budgets are O(1) in the number of rows (§45)', () => {
  it('the student assignments list stays a small constant regardless of how many assignments (H5)', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const counselor = await createStaffUser({ role: 'counselor' });
    const counselorToken = await login(counselor);
    const seeded = await seedInstruments(admin);

    const classRoom = await createClass(counselorToken);
    const [rosterEntry] = await enrolStudents(counselorToken, classRoom.id, ['Budget Student']);
    await joinClass(classRoom.join_code, rosterEntry.username);

    // Twelve ACTIVE assignments in the student's one class — the old decorateAssignments ran two
    // queries per assignment (question count + my-attempt), so this would have been ~26 reads.
    for (let i = 0; i < 12; i += 1) {
      await assignVersion(counselorToken, classRoom.id, seeded.riasecVersionId!);
    }

    const counter: SubrequestCounter = { calls: 0 };
    const countingDb = createDatabase(countingD1(env.DB, counter));
    const student = await findUser(rosterEntry.student_id);

    const views = await new AssessmentAttemptService(countingDb, env).listAssignmentsForStudent(
      student!,
    );

    console.info(
      `student-assignments @ N=12: ${counter.calls} D1 calls (budget 10, platform cap 50)`,
    );

    expect(views).toHaveLength(12);
    expect(counter.calls).toBeGreaterThan(0);
    expect(counter.calls).toBeLessThanOrEqual(10);
  });

  it('the counselor template list stays a small constant regardless of how many templates (H5)', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const counselor = await createStaffUser({ role: 'counselor' });
    const counselorToken = await login(counselor);

    // The two GLOBAL instruments plus several of the counselor's own CUSTOM templates.
    await seedInstruments(admin);
    for (let i = 0; i < 6; i += 1) {
      await api('POST', '/assessment-templates', {
        token: counselorToken,
        body: {
          category: 'CUSTOM',
          title: `Budget Template ${uuid().slice(0, 8)}`,
          ...(await assessmentTaxonomyBody()),
        },
      });
    }

    const counter: SubrequestCounter = { calls: 0 };
    const builder = new AssessmentBuilderService(createDatabase(countingD1(env.DB, counter)));
    const counselorRow = await findUser(counselor.id);

    // Mirrors the route (H5): list, then three grouped lookups — a fixed four reads, not 1 + 3N.
    const templates = await builder.listTemplatesFor(counselorRow!);
    const versionByTemplate = await builder.assignableVersionsFor(templates.map((t) => t.id));
    await builder.questionCountsFor([...versionByTemplate.values()].map((v) => v.id));
    await builder.dimensionsForTemplates(templates.map((t) => t.id));

    console.info(
      `counselor-templates @ N=${templates.length}: ${counter.calls} D1 calls (budget 6, platform cap 50)`,
    );

    expect(templates.length).toBeGreaterThanOrEqual(8);
    expect(counter.calls).toBeGreaterThan(0);
    expect(counter.calls).toBeLessThanOrEqual(6);
  });
});

import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '@/db/client';
import { AssessmentAttemptService } from '@/modules/assessment/assessment-attempt-service';
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
  findUser,
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
 * runs full recommendation generation inline (deviation D17) — and holds it to **≤ 25**,
 * half the platform's cap. The margin is the point: the gate should fire on the feature
 * that *approaches* the cliff, not the one that falls off it.
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
    const riasecAssignment = await assignVersion(counselorToken, classRoom.id, seeded.riasecVersionId!);
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
    const scctAssignment = await assignVersion(counselorToken, classRoom.id, seeded.scctVersionId!);
    const scctStart = await api('POST', `/student/assignments/${scctAssignment.id}/start`, {
      token: studentToken,
    });
    scctAttemptId = scctStart.body.data.id as string;
    const scctAttempt = await api('GET', `/student/attempts/${scctAttemptId}`, {
      token: studentToken,
    });
    await answerAll(studentToken, scctAttempt.body.data, () => 3);
  });

  it('submit-with-inline-generation stays within half the platform cap (≤ 25 D1 calls)', async () => {
    const counter: SubrequestCounter = { calls: 0 };
    const db = createDatabase(countingD1(env.DB, counter));
    const student = await findUser(studentId);

    const view = await new AssessmentAttemptService(db, env).submit(student!, scctAttemptId);

    // Logged so a budget regression can be seen approaching across runs, not just crossing.
    console.info(`submit-with-inline-generation: ${counter.calls} D1 calls (budget 25, platform cap 50)`);

    // The path under measurement must have actually done the work: a scored SCCT attempt,
    // and — both results now existing — a persisted recommendation set behind it.
    expect(view.attempt.status).toBe('SCORED');
    expect(counter.calls).toBeGreaterThan(0);
    expect(counter.calls).toBeLessThanOrEqual(25);
  });
});

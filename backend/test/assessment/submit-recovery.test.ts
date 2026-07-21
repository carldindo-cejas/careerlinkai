import { env } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '@/db/client';
import { assessmentAttempts, assessmentResults } from '@/db/schema';
import { AssessmentAttemptService } from '@/modules/assessment/assessment-attempt-service';
import {
  answerAll,
  api,
  assignVersion,
  classWithStudent,
  createStaffUser,
  db,
  findUser,
  login,
  seedInstruments,
} from '../helpers';

/**
 * Atomic submit — the crash-recovery path (audit C2 / A2).
 *
 * Submit used to flip the attempt to `SUBMITTED` in one statement and *then* score in a separate
 * batch. A failure in between stranded the attempt: retry answered 422 "already submitted", nothing
 * re-scores a `SUBMITTED` attempt, and the only recovery was a counselor reset + full retake. A2
 * folded the status transition into scoring's single batch, so a failure now leaves the attempt
 * `IN_PROGRESS` and re-submittable. This asserts exactly that, by making the scoring batch throw.
 *
 * Invisible to every other test because Miniflare's D1 never fails a `batch()` on its own — so, as
 * with the subrequest and parameter-cap gates, the failure has to be *injected* to be exercised.
 */

/** A D1 binding whose `batch()` always rejects — everything else passes straight through. */
function failingBatchD1(real: D1Database): D1Database {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'batch') {
        return () => Promise.reject(new Error('Injected D1 batch failure.'));
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

describe('a submit whose scoring batch fails is recoverable (C2)', () => {
  let studentId: string;
  let attemptId: string;

  beforeAll(async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const counselor = await createStaffUser({ role: 'counselor' });
    const counselorToken = await login(counselor);
    const seeded = await seedInstruments(admin);

    const { classRoom, student, studentToken } = await classWithStudent(counselorToken);
    studentId = student.student_id;

    const assignment = await assignVersion(
      counselorToken,
      classRoom.id,
      seeded.riasecVersionId!,
    );
    const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });
    attemptId = started.body.data.id as string;

    const attempt = await api('GET', `/student/attempts/${attemptId}`, { token: studentToken });
    await answerAll(studentToken, attempt.body.data, () => 3);
  });

  it('leaves the attempt IN_PROGRESS with no result, then scores cleanly on retry', async () => {
    const student = await findUser(studentId);

    // First submit: scoring's db.batch() throws. Nothing before it in submit is a batch, so the
    // failure lands exactly where a real D1 blip would.
    const failing = new AssessmentAttemptService(createDatabase(failingBatchD1(env.DB)), env);
    await expect(failing.submit(student!, attemptId)).rejects.toThrow();

    // The attempt must NOT be stranded: still IN_PROGRESS, and no half-written result row.
    const [afterFailure] = await db()
      .select()
      .from(assessmentAttempts)
      .where(eq(assessmentAttempts.id, attemptId));
    expect(afterFailure?.status).toBe('IN_PROGRESS');
    expect(afterFailure?.submittedAt).toBeNull();

    const strandedResult = await db()
      .select()
      .from(assessmentResults)
      .where(eq(assessmentResults.attemptId, attemptId));
    expect(strandedResult).toHaveLength(0);

    // Retry with a healthy binding: the same attempt now scores through to SCORED, with a result.
    const healthy = new AssessmentAttemptService(db(), env);
    const view = await healthy.submit(student!, attemptId);

    expect(view.attempt.status).toBe('SCORED');
    expect(view.attempt.submittedAt).not.toBeNull();

    const [scored] = await db()
      .select()
      .from(assessmentAttempts)
      .where(
        and(eq(assessmentAttempts.id, attemptId), eq(assessmentAttempts.status, 'SCORED')),
      );
    expect(scored).toBeDefined();

    const finalResult = await db()
      .select()
      .from(assessmentResults)
      .where(eq(assessmentResults.attemptId, attemptId));
    expect(finalResult).toHaveLength(1);
  });
});

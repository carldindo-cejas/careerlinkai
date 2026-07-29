import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { notifications } from '@/db/schema';
import worker, { type JobMessage } from '@/index';
import { uuid } from '@/lib/crypto';
import { createStaffUser, db } from '../helpers';

/**
 * Dead-letter alerting (plan P3-7).
 *
 * H1 made a dead-lettered job *recorded* — logged, marked FAILED where possible, acked rather than
 * dropped. It did not make it *noticed*: `console.error` reaches Workers Logs, which is somewhere
 * you look after you already suspect a problem, and the defining property of a failing background
 * queue is that it produces no symptom to suspect. A silently failing AI generation queue and an
 * idle one look identical from every screen in the app.
 *
 * These tests drive the real `queue()` entry point with a real DLQ batch — the same way
 * `test/ai/queue-consumer.test.ts` drives the source-queue path — and assert on the notification
 * rows that come out the other side.
 */

/** A fake dead-lettered message that records whether the consumer acked it. */
function fakeMessage(body: JobMessage) {
  const calls = { ack: 0, retry: 0 };

  return {
    calls,
    message: {
      id: uuid(),
      timestamp: new Date(),
      attempts: 3,
      body,
      ack: () => {
        calls.ack += 1;
      },
      retry: () => {
        calls.retry += 1;
      },
    },
  };
}

async function runDlq(queue: string, bodies: JobMessage[], overrides: Partial<typeof env> = {}) {
  const fakes = bodies.map(fakeMessage);
  const batch = {
    queue,
    messages: fakes.map((fake) => fake.message),
  } as unknown as MessageBatch<JobMessage>;

  await worker.queue(batch, { ...env, ...overrides });

  return fakes.map((fake) => fake.calls);
}

/** The alert rows this admin received, newest first. */
async function alertsFor(adminId: string) {
  const rows = await db()
    .select()
    .from(notifications)
    .where(eq(notifications.userId, adminId));

  return rows.filter((row) => row.title === 'Background jobs are failing');
}

/**
 * A unique queue name per test.
 *
 * The P3-7 throttle is keyed on the queue name and DO storage is shared across the tests in a file
 * (test/setup.ts), so two tests naming the same queue would have the second one silently measuring
 * the first one's suppression. The name still ends in `-dlq`, which is what `index.ts` routes on.
 */
function scratchQueue(): string {
  return `careerlinkai-${uuid().slice(0, 8)}-dlq`;
}

describe('dead-letter alerting (P3-7)', () => {
  it('notifies every active administrator when a batch is dead-lettered', async () => {
    const first = await createStaffUser({ role: 'admin' });
    const second = await createStaffUser({ role: 'admin' });

    const calls = await runDlq(scratchQueue(), [
      { type: 'GenerateAssessmentDraft', payload: { aiRequestId: uuid() } },
      { type: 'ProcessKnowledgeDocument', payload: { documentId: uuid() } },
    ]);

    // H1's contract is unchanged: a dead-lettered message is still acked, never retried.
    expect(calls.every((call) => call.ack === 1 && call.retry === 0)).toBe(true);

    for (const admin of [first, second]) {
      const alerts = await alertsFor(admin.id);

      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.category).toBe('ACCOUNT');
      // The count is the batch's, and both job types are named — an administrator who is told
      // "something failed" has to go and find out what, which is the state this replaced.
      expect(alerts[0]!.message).toContain('2 background jobs');
      expect(alerts[0]!.message).toContain('GenerateAssessmentDraft');
      expect(alerts[0]!.message).toContain('ProcessKnowledgeDocument');
    }
  });

  /**
   * **The alert says that it is muting itself.**
   *
   * A broken pipeline dead-letters every message, ten at a time, so the un-throttled version of
   * this feature is a hundred identical rows in the bell — an alert nobody reads, which is worse
   * than no alert because it hides the ones that matter. The throttle is therefore load-bearing,
   * and so is saying so: "3 jobs failed" is a worse lie than silence when 300 did.
   */
  it('sends one alert per queue per window, and says that it is suppressing the rest', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const queue = scratchQueue();

    await runDlq(queue, [{ type: 'GenerateStudentExplanations', payload: {} }]);
    await runDlq(queue, [{ type: 'GenerateStudentExplanations', payload: {} }]);
    await runDlq(queue, [{ type: 'GenerateStudentExplanations', payload: {} }]);

    const alerts = await alertsFor(admin.id);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.message).toContain('muted for 15 minutes');
    expect(alerts[0]!.message).toContain('may not be all of them');
  });

  /**
   * The two dead-letter queues mean different things — `ai` is generation and ingestion, `default`
   * is everything else — so one going quiet must never mask the other. Keyed per queue for the
   * same reason every prefix in `lib/auth-guard.ts` exists.
   */
  it('throttles per queue, so a failing AI queue cannot mask a failing default queue', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const aiQueue = scratchQueue();
    const defaultQueue = scratchQueue();

    await runDlq(aiQueue, [{ type: 'GenerateAssessmentDraft', payload: {} }]);
    await runDlq(aiQueue, [{ type: 'GenerateAssessmentDraft', payload: {} }]);
    await runDlq(defaultQueue, [{ type: 'GenerateStudentExplanations', payload: {} }]);

    const alerts = await alertsFor(admin.id);

    expect(alerts).toHaveLength(2);
    expect(alerts.map((alert) => alert.message).join('\n')).toContain(defaultQueue);
  });

  /** A suspended or removed administrator is not a recipient — the same rule `authenticate` applies. */
  it('does not notify a suspended or soft-deleted administrator', async () => {
    const suspended = await createStaffUser({ role: 'admin', status: 'suspended' });
    const active = await createStaffUser({ role: 'admin' });

    await runDlq(scratchQueue(), [{ type: 'GenerateAssessmentDraft', payload: {} }]);

    expect(await alertsFor(suspended.id)).toHaveLength(0);
    expect(await alertsFor(active.id)).toHaveLength(1);
  });

  /** Counselors and students are not told; a dead queue is an operator's problem, not theirs. */
  it('notifies administrators only', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const counselor = await createStaffUser({ role: 'counselor' });

    await runDlq(scratchQueue(), [{ type: 'GenerateAssessmentDraft', payload: {} }]);

    expect(await alertsFor(admin.id)).toHaveLength(1);
    expect(await alertsFor(counselor.id)).toHaveLength(0);
  });

  /**
   * **Alerting must never cost the batch.**
   *
   * A dead-lettered message has nowhere further to fall, so a notification insert that throws must
   * not turn "this job died" into "this job died and the consumer recording it died too". Driven
   * by breaking the alert for real — the throttle's own DO stub is asked for a state it cannot
   * produce — rather than by trusting the `try`/`catch` on inspection.
   */
  it('acks the batch even when alerting throws', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const queue = scratchQueue();

    /**
     * `queue()` takes its `env` as a parameter, so the failure is injected through the binding the
     * alert path reaches for first — no mocking, and `DB` stays real so `markAiJobFailed` and the
     * ack loop run exactly as they do in production.
     */
    const calls = await runDlq(queue, [{ type: 'GenerateAssessmentDraft', payload: {} }], {
      AUTH_DO: {
        idFromName: () => {
          throw new Error('alerting is down');
        },
      } as unknown as typeof env.AUTH_DO,
    });

    expect(calls[0]!.ack).toBe(1);
    expect(calls[0]!.retry).toBe(0);
    // And nothing was half-sent: a throw before the throttle charged leaves no alert and no
    // spent window, so the next batch on this queue can still reach an administrator.
    expect(await alertsFor(admin.id)).toHaveLength(0);

    await runDlq(queue, [{ type: 'GenerateAssessmentDraft', payload: {} }]);

    expect(await alertsFor(admin.id)).toHaveLength(1);
  });

  /** The source-queue path is untouched: a live job still retries rather than alerting. */
  it('leaves the source-queue path alone — a failing job retries and raises no alert', async () => {
    const admin = await createStaffUser({ role: 'admin' });

    const calls = await runDlq('careerlinkai-ai-queue', [
      { type: 'ProcessKnowledgeDocument', payload: { documentId: uuid() } },
    ]);

    expect(calls[0]!.retry).toBe(1);
    expect(calls[0]!.ack).toBe(0);
    expect(await alertsFor(admin.id)).toHaveLength(0);
  });
});

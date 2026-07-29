import { and, eq, isNull } from 'drizzle-orm';

import { createDatabase } from '@/db/client';
import { users } from '@/db/schema';
import type { Env } from '@/env';
import { DLQ_ALERT_LIMIT, DLQ_ALERT_WINDOW_SECONDS, dlqAlertGuard } from '@/lib/auth-guard';
import { NotificationService } from '@/modules/platform/notification-service';

/**
 * Dead-letter alerting (plan P3-7).
 *
 * ## The gap this closes
 *
 * H1 gave both source queues a dead-letter queue and this Worker a consumer for them, so a message
 * that exhausts its retries is recorded and acked rather than dropped. What it did **not** do is
 * tell anybody. `console.error` goes to Workers Logs, which is a place you look once you already
 * suspect something — and the whole difficulty with a failing background queue is that there is no
 * symptom to suspect. A silently failing AI generation queue and an idle one produce exactly the
 * same thing on every screen in the app: nothing. The reviewer whose draft never arrived assumes
 * they are still waiting.
 *
 * So the alert has to arrive somewhere an administrator already looks, and in this system that is
 * the §44 notification bell — which is in the shell of every signed-in page.
 *
 * ## Why the queue consumer rather than a `scheduled` sweep
 *
 * The item offered both. The consumer wins on every axis that matters here: it fires at the moment
 * the message dies rather than up to 24 hours later, it already holds the batch (so the count and
 * the job types are in hand, with no state to persist and re-read), and it adds no work at all on
 * the overwhelming majority of days when nothing dead-letters. A cron sweep would have to invent
 * somewhere to record DLQ activity in order to notice it later — which is a table whose only reader
 * is the thing that writes it.
 *
 * ## What it must never do
 *
 * Fail the ack loop. A message that is already in a dead-letter queue has nowhere further to fall,
 * and a notification insert that throws must not turn "this job died" into "this job died and the
 * consumer that was recording it also died". Every path below is caught and absorbed by the caller
 * (`index.ts`), and the structured log is written first, unconditionally and unthrottled, so the
 * trail exists even when nothing else works.
 */

/** The category §13.8 offers for "a message to an administrator about the system's own state". */
const ALERT_CATEGORY = 'ACCOUNT' as const;

export interface DeadLetterAlert {
  /** How many messages this batch carried. */
  count: number;
  /** Distinct job types in the batch, for the message body. */
  types: string[];
  /** True when the alert was sent; false when the P3-7 throttle suppressed it. */
  notified: boolean;
  /** How many administrators it reached. */
  recipients: number;
}

/**
 * Notify every active administrator that a batch of jobs was dead-lettered.
 *
 * Returns what happened rather than nothing, so `index.ts` can log the decision — a suppressed
 * alert that logged the same line as a delivered one would make the throttle invisible to the
 * person reading the logs to find out why they were not told.
 */
export async function alertDeadLetteredBatch(
  env: Env,
  queueName: string,
  types: (string | undefined)[],
): Promise<DeadLetterAlert> {
  const distinct = [...new Set(types.map((type) => type ?? 'unknown'))].sort();
  const count = types.length;

  /**
   * One alert per queue per window (see `dlqAlertGuard`). Charged **before** the recipient lookup,
   * so a storm costs one DO round trip per batch rather than a `users` scan per batch.
   */
  const throttle = await dlqAlertGuard(env, queueName).charge(
    DLQ_ALERT_LIMIT,
    DLQ_ALERT_WINDOW_SECONDS,
  );

  if (throttle.locked) {
    return { count, types: distinct, notified: false, recipients: 0 };
  }

  const db = createDatabase(env.DB);

  const admins = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.status, 'active'), isNull(users.deletedAt)));

  if (admins.length === 0) {
    return { count, types: distinct, notified: false, recipients: 0 };
  }

  const minutes = Math.round(DLQ_ALERT_WINDOW_SECONDS / 60);

  await new NotificationService(db).sendToMany(
    admins.map((admin) => admin.id),
    {
      title: 'Background jobs are failing',
      /**
       * Three facts, in the order an administrator needs them: what died, that it is **not** coming
       * back on its own (a dead-lettered message has already been retried three times and is acked
       * here, so "wait and see" is the one wrong response), and that the next fifteen minutes of
       * silence mean nothing. The queue name is included because it says which half of the system
       * is affected — `ai` is generation and ingestion, `default` is everything else.
       */
      message: `${count} background ${count === 1 ? 'job' : 'jobs'} on ${queueName} ran out of retries and will not run again (${distinct.join(', ')}). Check the Worker logs for the reason. Further alerts for this queue are muted for ${minutes} minutes, so this may not be all of them.`,
      category: ALERT_CATEGORY,
    },
  );

  return { count, types: distinct, notified: true, recipients: admins.length };
}

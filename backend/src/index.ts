import { createApp } from '@/app';
import type { Env } from '@/env';
import { handleAiJob, markAiJobFailed, type AiJobMessage } from '@/jobs/ai-jobs';
import { runNightlyCleanup } from '@/jobs/cleanup';
import { alertDeadLetteredBatch } from '@/jobs/dlq-alert';

/**
 * The Worker entry (FULLPLAN §16, §42).
 *
 * One Worker, three entry points: `fetch` serves the HTTP API, `queue` consumes background jobs
 * (and their dead-letter queues), and `scheduled` runs the nightly Cron housekeeping. Producer and
 * consumer are the same deployment — there is no separate consumer Worker (§7). The `AuthGuardDO`
 * class (§38 v1.5) is exported below because a Durable Object class must be exported from the
 * Worker entry module for the runtime to host it.
 */

export { AuthGuardDO } from '@/do/auth-guard';

const app = createApp();

/** A queue message. `type` selects the handler; payloads are defined beside their jobs. */
export type JobMessage = AiJobMessage;

/** A dead-letter queue is a source queue's name plus this suffix (see wrangler.toml). */
const DEAD_LETTER_SUFFIX = '-dlq';

export default {
  fetch: app.fetch,

  /**
   * The consumer (§42): dispatch by type, ack success, retry failure. Phase 5a gave this
   * its first real jobs — the §33 ingestion pair and the §43 explanation job.
   *
   * A message no handler recognises is **acked with a warning**, not retried: it will not
   * process on the third attempt either, and burning retries only delays the dead-letter
   * queue. A handler that throws gets `retry()` — with one exception already inside the
   * handlers: an explanation failure (quota, no grounding) is logged-and-fallen-back-from,
   * never rethrown, because retrying into a dead quota cannot succeed (§30 v1.5).
   */
  async queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
    // **Dead-letter queues (H1).** A message that exhausts `max_retries` on a source queue is
    // routed by the platform to that queue's `-dlq`, which this same Worker also consumes. Before
    // H1 those messages were simply *dropped* — a `GenerateAssessmentDraft` gone silent left its
    // poll PENDING forever, and a lost `GenerateStudentExplanations` vanished with no trace. Here
    // a dead-lettered message is recorded (so `markAiJobFailed` flips the visible status where it
    // can) and **acked**, never retried: retrying a message that already failed three times just
    // sends it straight back to the DLQ.
    if (batch.queue.endsWith(DEAD_LETTER_SUFFIX)) {
      for (const message of batch.messages) {
        console.error(
          JSON.stringify({
            level: 'error',
            // P3-7: a stable marker for a Workers Logs alert to filter on. The notification below
            // reaches an administrator inside the app; this reaches whoever is watching the logs,
            // and unlike the notification it is written for **every** message, unthrottled.
            alert: 'dead_letter_queue',
            message: 'Job dead-lettered after exhausting retries.',
            queue: batch.queue,
            type: message.body?.type,
          }),
        );

        await markAiJobFailed(env, message.body).catch(() => undefined);
        message.ack();
      }

      /**
       * **P3-7: tell a human.** Before this, a dead-lettered job was logged and acked, and nothing
       * else happened — a silently failing AI queue and an idle one look identical from every
       * screen in the app, so the first person to notice was the reviewer whose draft never came.
       *
       * After the acks, deliberately: the messages are already accounted for, so an alert that
       * fails cannot cost the batch. Absorbed for the same reason `dispatch()` absorbs a listener —
       * a notification must never fail the thing it is about, least of all when that thing is the
       * recording of a failure.
       */
      try {
        const alert = await alertDeadLetteredBatch(
          env,
          batch.queue,
          batch.messages.map((message) => message.body?.type),
        );

        console.warn(
          JSON.stringify({
            level: 'warn',
            message: alert.notified
              ? 'Dead-letter alert sent to administrators.'
              : 'Dead-letter alert suppressed (throttled, or no active administrator).',
            queue: batch.queue,
            dead_lettered: alert.count,
            recipients: alert.recipients,
          }),
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'Dead-letter alerting itself failed.',
            queue: batch.queue,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }

      return;
    }

    for (const message of batch.messages) {
      try {
        const handled = await handleAiJob(env, message.body);

        if (!handled) {
          console.warn(
            JSON.stringify({
              level: 'warn',
              message: 'Queue message received with no matching job handler.',
              queue: batch.queue,
              type: message.body?.type,
            }),
          );
        }

        message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'Queue job failed.',
            queue: batch.queue,
            type: message.body?.type,
            error: error instanceof Error ? error.message : String(error),
          }),
        );

        // Visible failure beats silent absence: the admin list shows FAILED while the
        // retry — which may still succeed and flip it back — is pending (§53).
        await markAiJobFailed(env, message.body).catch(() => undefined);

        message.retry();
      }
    }
  },

  /**
   * The Cron Trigger (§45 enhancement, audit M11). Nightly housekeeping: sweep expired
   * `api_tokens` and stale `password_reset_tokens` that nothing else removes. Idempotent, so a
   * missed or doubled run is harmless. See `runNightlyCleanup` for what is deliberately *not* here.
   */
  async scheduled(
    _event: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const result = await runNightlyCleanup(env);

    console.info(
      JSON.stringify({
        level: 'info',
        message: 'Nightly cleanup complete.',
        expired_tokens: result.expiredTokens,
        stale_reset_tokens: result.staleResetTokens,
        stalled_ai_requests: result.stalledAiRequests,
      }),
    );
  },
} satisfies ExportedHandler<Env, JobMessage>;

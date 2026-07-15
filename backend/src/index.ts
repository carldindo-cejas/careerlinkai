import { createApp } from '@/app';
import type { Env } from '@/env';
import { handleAiJob, markAiJobFailed, type AiJobMessage } from '@/jobs/ai-jobs';

/**
 * The Worker entry (FULLPLAN §16, §42).
 *
 * One Worker, two entry points: `fetch` serves the HTTP API, `queue` consumes background
 * jobs. Producer and consumer are the same deployment — there is no separate consumer
 * Worker (§7). The `AuthGuardDO` class (§38 v1.5) is exported below because a Durable
 * Object class must be exported from the Worker entry module for the runtime to host it.
 */

export { AuthGuardDO } from '@/do/auth-guard';

const app = createApp();

/** A queue message. `type` selects the handler; payloads are defined beside their jobs. */
export type JobMessage = AiJobMessage;

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
} satisfies ExportedHandler<Env, JobMessage>;

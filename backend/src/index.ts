import { createApp } from '@/app';
import type { Env } from '@/env';

/**
 * The Worker entry (FULLPLAN §16, §42).
 *
 * One Worker, two entry points: `fetch` serves the HTTP API, `queue` consumes background
 * jobs. Producer and consumer are the same deployment — there is no separate consumer
 * Worker (§7).
 */

const app = createApp();

/**
 * A queue message. `type` selects the handler in `src/jobs/`; the handlers themselves
 * arrive with the phases that need them — `generateRecommendation` in Phase 4, the four AI
 * jobs in Phase 5 (§43).
 */
export interface JobMessage {
  type: string;
  payload: Record<string, unknown>;
}

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<JobMessage>): Promise<void> {
    for (const message of batch.messages) {
      // No job handlers exist yet. Ack rather than retry: a message no handler can process
      // will not process on the third attempt either, and burning retries would only delay
      // it reaching the dead-letter queue. The dispatch switch lands with the first job.
      console.warn(
        JSON.stringify({
          level: 'warn',
          message: 'Queue message received before any job handler exists.',
          queue: batch.queue,
          type: message.body?.type,
        }),
      );

      message.ack();
    }
  },
} satisfies ExportedHandler<Env, JobMessage>;

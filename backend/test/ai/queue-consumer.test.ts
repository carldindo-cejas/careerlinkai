import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import worker, { type JobMessage } from '@/index';
import { uuid } from '@/lib/crypto';

/**
 * The `queue()` consumer's ack / retry decision (FULLPLAN §42, §43).
 *
 * The handlers themselves are exercised elsewhere; this pins the *dispatch loop* in `index.ts`:
 * a handled message is acked, a throwing one is retried (after a best-effort FAILED mark), and a
 * message of an unrecognised type is **acked with a warning**, never retried — burning three
 * retries on a type no handler will ever match only delays the dead-letter queue.
 */

/** A fake queue message that records whether the consumer acked or retried it. */
function fakeMessage(body: JobMessage) {
  const calls = { ack: 0, retry: 0 };
  const message = {
    id: uuid(),
    timestamp: new Date(),
    attempts: 1,
    body,
    ack: () => {
      calls.ack += 1;
    },
    retry: () => {
      calls.retry += 1;
    },
  };

  return { message, calls };
}

async function runQueue(body: JobMessage): Promise<{ ack: number; retry: number }> {
  const { message, calls } = fakeMessage(body);
  const batch = {
    queue: 'careerlinkai-ai-queue',
    messages: [message],
  } as unknown as MessageBatch<JobMessage>;

  await worker.queue(batch, env);

  return calls;
}

describe('the queue consumer dispatch loop (§42)', () => {
  it('acks a handled job — a student with no recommendations is a clean no-op success', async () => {
    const calls = await runQueue({
      type: 'GenerateStudentExplanations',
      payload: { studentId: uuid() },
    });

    expect(calls.ack).toBe(1);
    expect(calls.retry).toBe(0);
  });

  it('acks (does not retry) a message whose type no handler recognises', async () => {
    const calls = await runQueue({ type: 'NoSuchJobType', payload: {} });

    expect(calls.ack).toBe(1);
    expect(calls.retry).toBe(0);
  });

  it('retries a job whose handler throws — a missing document cannot process, so it is re-queued', async () => {
    const calls = await runQueue({
      type: 'ProcessKnowledgeDocument',
      payload: { documentId: uuid() },
    });

    expect(calls.retry).toBe(1);
    expect(calls.ack).toBe(0);
  });
});

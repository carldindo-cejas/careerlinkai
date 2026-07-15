/* eslint-disable @typescript-eslint/require-await -- async-interface stubs have nothing to await */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { aiRequests } from '@/db/schema';
import {
  AiGatewayService,
  EMBEDDING_BATCH_LIMIT,
  type WorkersAiClient,
} from '@/modules/ai/ai-gateway-service';
import { db } from '../helpers';

/**
 * `AiGatewayService` against a **stubbed** model client (FULLPLAN §49, and the Step 3
 * toolchain lesson): Workers AI has no local emulation, and an assertion on a live LLM's
 * output is not a test, it is a weather report. What CAN be pinned offline is the §29/§30
 * contract — one `ai_requests` row per call, the failure taxonomy, and the §33 batching
 * shape, which is the "what the code asks of the platform" assertion for the 50-subrequest
 * ceiling.
 */

const MODELS = { text: '@cf/test/text-model', embedding: '@cf/test/embedding-model' };

function gateway(client: WorkersAiClient | undefined) {
  return new AiGatewayService(db(), client, MODELS);
}

function generateOptions(marker: string) {
  return {
    userId: null,
    requestType: 'RECOMMENDATION_EXPLANATION' as const,
    systemPrompt: 'system',
    userPrompt: `explain ${marker}`,
    inputContext: { marker },
  };
}

async function requestRowById(id: string) {
  const rows = await db().select().from(aiRequests).where(eq(aiRequests.id, id));

  return rows[0];
}

describe('generate — one ai_requests row per call, success or failure (§29 principle 6)', () => {
  it('logs SUCCESS with the response, latency and token count', async () => {
    const result = await gateway({
      run: async () => ({ response: 'A grounded explanation.', usage: { total_tokens: 42 } }),
    }).generate(generateOptions('success'));

    expect(result.ok).toBe(true);

    const row = await requestRowById(result.request.id);

    expect(row).toMatchObject({
      status: 'SUCCESS',
      responseText: 'A grounded explanation.',
      tokensUsed: 42,
      model: MODELS.text,
      requestType: 'RECOMMENDATION_EXPLANATION',
    });
    expect(row!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('logs FAILED when the model throws, and the caller gets a typed failure, not an exception', async () => {
    const result = await gateway({
      run: async () => {
        throw new Error('model exploded');
      },
    }).generate(generateOptions('model-error'));

    expect(result).toMatchObject({ ok: false, reason: 'MODEL_ERROR' });

    const row = await requestRowById(result.request.id);

    expect(row!.status).toBe('FAILED');
    expect(row!.inputContext).toMatchObject({
      failure_reason: expect.stringContaining('model exploded'),
    });
  });

  it('recognises quota exhaustion (§30 v1.5) — FAILED with the quota reason, exactly one attempt', async () => {
    let calls = 0;

    const result = await gateway({
      run: async () => {
        calls += 1;
        throw new Error('4023: You have exceeded your daily neuron quota');
      },
    }).generate(generateOptions('quota'));

    expect(result).toMatchObject({ ok: false, reason: 'QUOTA_EXHAUSTED' });
    // Never retry into a dead quota: a retry cannot succeed and only burns time.
    expect(calls).toBe(1);
  });

  it('treats a missing AI binding as MODEL_UNAVAILABLE — the hermetic-config shape of "model down"', async () => {
    const result = await gateway(undefined).generate(generateOptions('unbound'));

    expect(result).toMatchObject({ ok: false, reason: 'MODEL_UNAVAILABLE' });
    expect((await requestRowById(result.request.id))!.status).toBe('FAILED');
  });

  it('rejects a blank response as EMPTY_RESPONSE (§34)', async () => {
    const result = await gateway({ run: async () => ({ response: '   ' }) }).generate(
      generateOptions('empty'),
    );

    expect(result).toMatchObject({ ok: false, reason: 'EMPTY_RESPONSE' });
  });

  it('logSkipped records the §30 zero-retrieval decision as a FAILED row without a model call', async () => {
    let calls = 0;
    const service = gateway({
      run: async () => {
        calls += 1;
        return { response: 'should never be called' };
      },
    });

    const row = await service.logSkipped(
      { ...generateOptions('skipped'), systemPrompt: '', userPrompt: 'q' },
      'No knowledge chunks above the similarity threshold.',
    );

    expect(calls).toBe(0);
    expect((await requestRowById(row.id))!.status).toBe('FAILED');
    expect((await requestRowById(row.id))!.inputContext).toMatchObject({
      failure_reason: expect.stringContaining('SKIPPED'),
    });
  });
});

describe('embed — the §33 batching contract (Phase 4.5 Step 3)', () => {
  it('makes ONE call per ≤100 texts, never one per text', async () => {
    const batchSizes: number[] = [];

    const client: WorkersAiClient = {
      run: async (_model, inputs) => {
        const texts = inputs.text as string[];

        batchSizes.push(texts.length);

        return { data: texts.map(() => [0.1, 0.2, 0.3]) };
      },
    };

    const texts = Array.from({ length: 250 }, (_, i) => `chunk ${i}`);
    const vectors = await gateway(client).embed(texts);

    expect(vectors).toHaveLength(250);
    // 250 texts → exactly ceil(250 / 100) = 3 calls. A per-chunk loop would be 250 calls,
    // and on a free Worker (50 subrequests/invocation) that is not slow — it is broken.
    expect(batchSizes).toEqual([EMBEDDING_BATCH_LIMIT, EMBEDDING_BATCH_LIMIT, 50]);
  });

  it('embeds nothing for an empty list without touching the model', async () => {
    let calls = 0;

    const vectors = await gateway({
      run: async () => {
        calls += 1;
        return { data: [] };
      },
    }).embed([]);

    expect(vectors).toEqual([]);
    expect(calls).toBe(0);
  });

  it('throws on a count mismatch — a silently missing vector is an invisible retrieval gap', async () => {
    await expect(
      gateway({ run: async () => ({ data: [[0.1]] }) }).embed(['a', 'b']),
    ).rejects.toThrow(/returned 1 vectors for 2 texts/);
  });
});

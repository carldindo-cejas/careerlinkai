/* eslint-disable @typescript-eslint/require-await -- async-interface stubs have nothing to await */
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { aiRequests } from '@/db/schema';
import {
  AiGatewayService,
  BGE_QUERY_PREFIX,
  EMBEDDING_BATCH_LIMIT,
  EMBEDDING_MAX_INPUT_TOKENS,
  type WorkersAiClient,
} from '@/modules/ai/ai-gateway-service';
import { CHARS_PER_TOKEN } from '@/lib/chunker';
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
    // Its own column since migration 0015 — the one field an operator greps for was the one
    // field SQL could not filter on while it lived inside the `input_context` JSON blob.
    expect(row!.failureReason).toContain('model exploded');
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
    expect((await requestRowById(row.id))!.failureReason).toContain('SKIPPED');
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

  /**
   * AiNormalisation D1's tripwire. The embedder truncates past 512 tokens and reports nothing —
   * a well-formed vector comes back either way — so the whole corpus embedded at two thirds of
   * its length for as long as the ceiling was wrong, with no error and no log line. This is the
   * line that makes that class of defect *observable*; it does not throw, because a degraded
   * vector is still better than a failed ingestion.
   */
  it('logs when a text exceeds the embedding model input limit, and still embeds it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const oversized = 'x'.repeat((EMBEDDING_MAX_INPUT_TOKENS + 50) * CHARS_PER_TOKEN);
      const vectors = await gateway({
        run: async (_model, inputs) => ({ data: (inputs.text as string[]).map(() => [0.1]) }),
      }).embed([oversized, 'short text']);

      expect(vectors).toHaveLength(2);

      const logged = error.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .find((line) => line.stage === 'embedding_input_truncated');

      expect(logged).toMatchObject({ oversized_texts: 1, total_texts: 2 });
    } finally {
      error.mockRestore();
    }
  });

  it('embeds a query with the BGE instruction prefix; passages stay bare (D3)', async () => {
    const seen: string[] = [];
    const client: WorkersAiClient = {
      run: async (_model, inputs) => {
        seen.push(...(inputs.text as string[]));

        return { data: (inputs.text as string[]).map(() => [0.1]) };
      },
    };
    const service = gateway(client);

    await service.embedQuery('what strand should I take');
    await service.embed(['A passage from the handbook.']);

    expect(seen).toEqual([
      `${BGE_QUERY_PREFIX}what strand should I take`,
      'A passage from the handbook.',
    ]);
  });
});

describe('rerank — the cross-encoder that makes a low similarity floor safe', () => {
  const MODELS_WITH_RERANK = { ...MODELS, rerank: '@cf/test/reranker' };

  it('returns scored indexes, and soft-fails to undefined rather than taking retrieval down', async () => {
    const ok = new AiGatewayService(
      db(),
      { run: async () => ({ response: [{ id: 1, score: 0.9 }, { id: 0, score: 0.2 }] }) },
      MODELS_WITH_RERANK,
    );

    expect(await ok.rerank('q', ['a', 'b'])).toEqual([
      { index: 1, score: 0.9 },
      { index: 0, score: 0.2 },
    ]);

    const broken = new AiGatewayService(
      db(),
      {
        run: async () => {
          throw new Error('reranker down');
        },
      },
      MODELS_WITH_RERANK,
    );

    expect(await broken.rerank('q', ['a', 'b'])).toBeUndefined();
    // No rerank model configured is the same non-event, not a crash.
    expect(await gateway({ run: async () => ({}) }).rerank('q', ['a'])).toBeUndefined();
  });

  it('drops entries pointing outside the supplied passages', async () => {
    const service = new AiGatewayService(
      db(),
      { run: async () => ({ response: [{ id: 5, score: 0.9 }, { id: 0, score: 0.5 }] }) },
      MODELS_WITH_RERANK,
    );

    expect(await service.rerank('q', ['only one'])).toEqual([{ index: 0, score: 0.5 }]);
  });
});

import { and, eq, inArray } from 'drizzle-orm';

import type { Database } from '@/db/client';
import { aiRequests, type AiRequest } from '@/db/schema';
import { AI_REQUEST_IN_FLIGHT_STATUSES, type AiRequestType } from '@/db/enums';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { log } from '@/lib/logger';

/**
 * `AiGatewayService` — the single adapter in front of Cloudflare Workers AI (FULLPLAN §29
 * principle 5). No other code calls the `AI` binding; both pipelines (§30 explanation now,
 * §31 generation in Phase 5b) come through here.
 *
 * ## Every call is logged (§29 principle 6)
 *
 * One `ai_requests` row per **text-generation** call, success or failure, with latency and
 * token counts — no exceptions. Embedding calls do not write rows: `ai_requests.request_type`
 * has no embedding value by design (§13.7), the corpus-side audit trail is
 * `knowledge_documents.processing_status`, and embeddings are three orders of magnitude
 * cheaper than generation (§30 v1.5).
 *
 * ## The row is a lifecycle, not a receipt (migration 0015)
 *
 * A *synchronous* caller (the §30 explanation path) calls `generate` and gets one terminal row —
 * unchanged. An *asynchronous* caller (the §31 generation endpoints) cannot afford that, because
 * the thing that would write the row is the same queued job that might never run, and "no row
 * yet" then means both "queued" and "lost" with no way to tell them apart. So the async path is:
 *
 *     reserve(…)          → PENDING     written by the HTTP endpoint, before the queue send
 *     markProcessing(id)  → PROCESSING  written by the consumer when it picks the job up
 *     generate({ id })    → SUCCESS | FAILED (upserts onto the reserved row)
 *     failReserved(id, …) → FAILED      any non-model failure the job hits on the way
 *
 * `log` upserts rather than inserts precisely so those two entry styles share one code path: an
 * id that was never reserved is inserted, an id that was is completed in place.
 *
 * ## The failure taxonomy (§30 v1.5, Phase 4.5 Step 3)
 *
 * **Neuron-quota exhaustion is a model failure like any other**: the Free plan allows
 * 10,000 neurons/day and hard-fails afterwards (~150–200 explanations/day). A quota error
 * logs a FAILED row with the reason and is **never retried** — a retry into a dead quota
 * cannot succeed and burns nothing but time. Every caller must have a deterministic
 * fallback; §29's posture is that the AI paragraph is an enhancement, not a dependency.
 *
 * A **missing binding** (`env.AI` is undefined — the hermetic test config deletes it, since
 * Workers AI has no local emulation) is treated identically: FAILED row, no throw. That is
 * not a test convenience so much as the same contract: "the model is unavailable" has one
 * shape, whatever the cause.
 *
 * ## Testability
 *
 * The constructor takes a minimal `WorkersAiClient` rather than the `Ai` binding type, so
 * the suite injects a stub (§49 — an assertion on a live LLM's output is not a test, it is
 * a weather report). Production passes `env.AI` unchanged.
 */

/** The two Workers AI shapes this system uses — the whole surface, kept stubbable. */
export interface WorkersAiClient {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export interface GenerateOptions {
  /** Who asked. NULL for system-triggered work (the queued explanation job). */
  userId: string | null;
  requestType: AiRequestType;
  systemPrompt: string;
  userPrompt: string;
  /** Retrieved chunk ids + prompt variables — persisted for §13.7 provenance. */
  inputContext: Record<string, unknown>;
  maxTokens?: number;
  /**
   * Pre-allocated `ai_requests.id` (Phase 5b). The generation endpoints answer 202 with an
   * id and enqueue the job; the job passes that id here so the row the gateway writes is the
   * row the client is already polling (`GET /ai/requests/{id}/status`). Callers that pass
   * this must call `generate` at most once per id — the id is a primary key.
   */
  id?: string;
}

export type GenerateResult =
  | { ok: true; text: string; request: AiRequest }
  | { ok: false; reason: 'MODEL_UNAVAILABLE' | 'QUOTA_EXHAUSTED' | 'MODEL_ERROR' | 'EMPTY_RESPONSE'; request: AiRequest };

/** §33 v1.5: the embedding model accepts up to 100 texts per call. */
export const EMBEDDING_BATCH_LIMIT = 100;

/** A quota error must never be retried (§30 v1.5) — recognize it by its message. */
function isQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return /neuron|quota|daily limit|3040/i.test(message);
}

/**
 * The longest a single model call may run before it is called a failure.
 *
 * `env.AI.run()` has no timeout of its own — it settles when the platform decides it does, and a
 * call that never settles is the one remaining way a queued job can occupy PROCESSING without ever
 * writing a row. The 10-minute deadline in `AssessmentGenerationService` reaps that from the
 * outside; this bounds it from the inside, which is better: the job terminates *itself*, with a
 * reason naming the model, instead of being swept later by a cron and reported as a lost message.
 *
 * Three minutes, measured rather than guessed: a §31 generation at `max_tokens: 4096` against
 * `llama-3.1-8b-instruct-fp8` was observed taking ~76 s end to end through a `remote = true` dev
 * binding, which is the slowest legitimate path this system has. The cap has to clear that with
 * room to spare — a timeout that fires on work which would have succeeded is a worse bug than the
 * hang it prevents.
 */
export const MODEL_CALL_TIMEOUT_MS = 180_000;

/**
 * Bound a model call in wall-clock time.
 *
 * The underlying request is **not** cancelled — a Worker cannot abort `env.AI.run()` — so this
 * does not save the neurons. What it buys is that the caller stops waiting, the `ai_requests` row
 * reaches a terminal state, and the person watching the poll gets an answer. The dangling call
 * ends with the invocation.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`The model did not respond within ${ms / 1000} seconds.`)),
          ms,
        );
      }),
    ]);
  } finally {
    // Guarded because the Workers runtime types `clearTimeout` as `number | null`, not `unknown`.
    // Clearing matters: an un-cleared timer keeps the invocation alive after the call has settled.
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export class AiGatewayService {
  constructor(
    private readonly db: Database,
    private readonly ai: WorkersAiClient | undefined,
    private readonly models: { text: string; embedding: string },
  ) {}

  /**
   * Claim an id as PENDING **before** the work is queued (migration 0015).
   *
   * This is what makes an async generation observable. The endpoint reserves, then sends the
   * queue message; from that instant the poll sees a real row with a real `created_at`, so a
   * message that is never delivered shows up as a row that never moved — which the deadline in
   * `AssessmentGenerationService.statusFor` and the nightly sweep can both act on — instead of
   * as an absence indistinguishable from a bogus id.
   *
   * Deliberately allowed to throw: if the row cannot be written there is nothing to poll, and
   * the endpoint must fail loudly rather than hand back an id that means nothing.
   */
  async reserve(options: Omit<GenerateOptions, 'systemPrompt' | 'userPrompt'> & { id: string }): Promise<AiRequest> {
    const timestamp = now();
    const row = {
      id: options.id,
      userId: options.userId,
      requestType: options.requestType,
      inputContext: options.inputContext,
      responseText: null,
      model: this.models.text,
      tokensUsed: null,
      latencyMs: null,
      status: 'PENDING' as const,
      failureReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.db.insert(aiRequests).values(row);

    log('info', 'ai_gateway.reserved', {
      pipeline: 'ai_gateway',
      stage: 'reserved',
      ai_request_id: options.id,
      request_type: options.requestType,
    });

    return row;
  }

  /**
   * PENDING → PROCESSING, when the consumer picks the job up. Guarded on the current status so a
   * redelivered message cannot drag a row that already finished back into the middle of its own
   * lifecycle. Returns false when nothing was advanced — the caller logs it and carries on,
   * because a missing row is not a reason to fail work that can still succeed.
   */
  async markProcessing(id: string): Promise<boolean> {
    const advanced = await this.db
      .update(aiRequests)
      .set({ status: 'PROCESSING', updatedAt: now() })
      .where(and(eq(aiRequests.id, id), inArray(aiRequests.status, [...AI_REQUEST_IN_FLIGHT_STATUSES])))
      .returning({ id: aiRequests.id });

    log('info', 'ai_gateway.processing', {
      pipeline: 'ai_gateway',
      stage: 'processing',
      ai_request_id: id,
      advanced: advanced.length > 0,
    });

    return advanced.length > 0;
  }

  /**
   * Terminate a reserved row as FAILED for a reason that is **not** a model failure — the source
   * document vanished, the prompt could not be assembled, the save threw. §30's taxonomy covers
   * the model; this covers everything else that can stop a job, and it exists so that no path
   * through a queued job can leave the row non-terminal.
   *
   * Never throws: it runs in `catch` blocks, and an error thrown out of error handling replaces a
   * diagnosable failure with an undiagnosable one.
   */
  async failReserved(id: string, reason: string): Promise<void> {
    try {
      await this.db
        .update(aiRequests)
        .set({ status: 'FAILED', failureReason: reason, updatedAt: now() })
        .where(and(eq(aiRequests.id, id), inArray(aiRequests.status, [...AI_REQUEST_IN_FLIGHT_STATUSES])));

      log('error', 'ai_gateway.failed', {
        pipeline: 'ai_gateway',
        stage: 'failed',
        ai_request_id: id,
        failure_reason: reason,
      });
    } catch (error) {
      log('error', 'ai_gateway.fail_write_failed', {
        pipeline: 'ai_gateway',
        stage: 'fail_write_failed',
        ai_request_id: id,
        failure_reason: reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * One text generation, one `ai_requests` row. Never throws for model trouble — the row
   * plus a typed failure is the contract, and the caller's deterministic fallback is the
   * user experience.
   */
  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const startedAt = Date.now();

    log('info', 'ai_gateway.request_sent', {
      pipeline: 'ai_gateway',
      stage: 'request_sent',
      ai_request_id: options.id,
      request_type: options.requestType,
      model: this.models.text,
      system_prompt_chars: options.systemPrompt.length,
      user_prompt_chars: options.userPrompt.length,
      max_tokens: options.maxTokens ?? 512,
    });

    if (this.ai === undefined) {
      // Not a test convenience: "the model is unavailable" has one shape whatever the cause. The
      // message names the remedy because the overwhelmingly common cause is a dev loop booted on
      // a config that drops the binding — and a reason a reader cannot act on is not a reason.
      return this.failure(
        options,
        startedAt,
        'MODEL_UNAVAILABLE',
        'The AI binding is not configured in this environment. Workers AI has no local emulation — run `npm run dev:remote` (wrangler.dev.toml) or use staging to exercise generation.',
      );
    }

    let output: unknown;

    try {
      output = await withTimeout(
        this.ai.run(this.models.text, {
          messages: [
            { role: 'system', content: options.systemPrompt },
            { role: 'user', content: options.userPrompt },
          ],
          max_tokens: options.maxTokens ?? 512,
        }),
        MODEL_CALL_TIMEOUT_MS,
      );
    } catch (error) {
      const quota = isQuotaError(error);

      return this.failure(
        options,
        startedAt,
        quota ? 'QUOTA_EXHAUSTED' : 'MODEL_ERROR',
        error instanceof Error ? error.message : String(error),
      );
    }

    const text = extractResponseText(output);

    if (text === null || text.trim().length === 0) {
      return this.failure(options, startedAt, 'EMPTY_RESPONSE', 'The model returned no text.');
    }

    const request = await this.log(options, {
      status: 'SUCCESS',
      responseText: text,
      latencyMs: Date.now() - startedAt,
      tokensUsed: extractTokensUsed(output),
    });

    log('info', 'ai_gateway.response_received', {
      pipeline: 'ai_gateway',
      stage: 'response_received',
      ai_request_id: request.id,
      request_type: options.requestType,
      latency_ms: request.latencyMs,
      tokens_used: request.tokensUsed,
      response_chars: text.length,
    });

    return { ok: true, text, request };
  }

  /**
   * Embed texts, **batched** (§33 v1.5): one AI call per ≤100 texts, never one per text.
   * A free Worker invocation gets 50 subrequests and every AI call counts — the per-chunk
   * loop this replaces would have breached that on a 20-chunk document.
   *
   * Throws on failure rather than soft-failing like `generate`: embedding runs inside a
   * queue consumer whose retry/DLQ machinery (§42) *is* the failure handling, and a vector
   * silently missing from the index would be an invisible retrieval gap, not a graceful
   * degradation.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    if (this.ai === undefined) {
      throw new Error('AI binding is not configured — embeddings cannot be generated.');
    }

    const vectors: number[][] = [];

    for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_LIMIT) {
      const batch = texts.slice(i, i + EMBEDDING_BATCH_LIMIT);
      const output = (await this.ai.run(this.models.embedding, { text: batch })) as {
        data?: number[][];
      };

      if (!Array.isArray(output?.data) || output.data.length !== batch.length) {
        throw new Error(
          `Embedding call returned ${output?.data?.length ?? 0} vectors for ${batch.length} texts.`,
        );
      }

      vectors.push(...output.data);
    }

    return vectors;
  }

  /**
   * Record a FAILED row for a pipeline decision made *before* any model call — §30's
   * zero-retrieval case: "the system does not fall back to an ungrounded generic AI answer
   * … and logs the `ai_requests` row as `status = FAILED` with a note." The row shape is
   * identical to a model failure, so the audit trail reads as one taxonomy.
   */
  async logSkipped(options: GenerateOptions, note: string): Promise<AiRequest> {
    return this.log(options, {
      status: 'FAILED',
      responseText: null,
      latencyMs: 0,
      tokensUsed: null,
      failureReason: `SKIPPED: ${note}`,
    });
  }

  // --- internals ---------------------------------------------------------------------

  private async failure(
    options: GenerateOptions,
    startedAt: number,
    reason: Exclude<GenerateResult, { ok: true }>['reason'],
    detail: string,
  ): Promise<GenerateResult> {
    const failureReason = `${reason}: ${detail}`;

    const request = await this.log(options, {
      status: 'FAILED',
      responseText: null,
      latencyMs: Date.now() - startedAt,
      tokensUsed: null,
      failureReason,
    });

    log('error', 'ai_gateway.call_failed', {
      pipeline: 'ai_gateway',
      stage: 'call_failed',
      ai_request_id: request.id,
      request_type: options.requestType,
      reason,
      failure_reason: failureReason,
      latency_ms: request.latencyMs,
    });

    return { ok: false, reason, request };
  }

  /**
   * Write the terminal row.
   *
   * **Upsert, not insert.** A synchronous caller passes no id and lands a fresh row; an async
   * caller passes the id it already reserved as PENDING, and this completes that same row in
   * place. Before migration 0015 this was a bare insert, which is fine only as long as no row is
   * ever written ahead of the call — and writing one ahead of the call is exactly the fix.
   *
   * `createdAt` is deliberately absent from the update set: on a reserved row it already records
   * when the *request* was made, which is what the deadline measures against, and overwriting it
   * with the completion time would reset the clock the sweep depends on.
   */
  private async log(
    options: GenerateOptions,
    outcome: {
      status: 'SUCCESS' | 'FAILED';
      responseText: string | null;
      latencyMs: number;
      tokensUsed: number | null;
      failureReason?: string;
    },
  ): Promise<AiRequest> {
    const timestamp = now();
    const row = {
      id: options.id ?? uuid(),
      userId: options.userId,
      requestType: options.requestType,
      inputContext: options.inputContext,
      responseText: outcome.responseText,
      model: this.models.text,
      tokensUsed: outcome.tokensUsed,
      latencyMs: outcome.latencyMs,
      status: outcome.status,
      failureReason: outcome.failureReason ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.db
      .insert(aiRequests)
      .values(row)
      .onConflictDoUpdate({
        target: aiRequests.id,
        set: {
          inputContext: row.inputContext,
          responseText: row.responseText,
          model: row.model,
          tokensUsed: row.tokensUsed,
          latencyMs: row.latencyMs,
          status: row.status,
          failureReason: row.failureReason,
          updatedAt: row.updatedAt,
        },
      });

    return row;
  }
}

/** Workers AI text models answer `{ response: string }`; tolerate a bare string too. */
function extractResponseText(output: unknown): string | null {
  if (typeof output === 'string') {
    return output;
  }

  if (output !== null && typeof output === 'object' && 'response' in output) {
    const { response } = output;

    return typeof response === 'string' ? response : null;
  }

  return null;
}

function extractTokensUsed(output: unknown): number | null {
  if (output !== null && typeof output === 'object' && 'usage' in output) {
    const usage = (output as { usage: { total_tokens?: unknown } }).usage;
    const total = usage?.total_tokens;

    return typeof total === 'number' ? total : null;
  }

  return null;
}

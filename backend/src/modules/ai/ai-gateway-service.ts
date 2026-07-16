import type { Database } from '@/db/client';
import { aiRequests, type AiRequest } from '@/db/schema';
import type { AiRequestType } from '@/db/enums';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';

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

export class AiGatewayService {
  constructor(
    private readonly db: Database,
    private readonly ai: WorkersAiClient | undefined,
    private readonly models: { text: string; embedding: string },
  ) {}

  /**
   * One text generation, one `ai_requests` row. Never throws for model trouble — the row
   * plus a typed failure is the contract, and the caller's deterministic fallback is the
   * user experience.
   */
  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const startedAt = Date.now();

    if (this.ai === undefined) {
      return this.failure(options, startedAt, 'MODEL_UNAVAILABLE', 'AI binding is not configured.');
    }

    let output: unknown;

    try {
      output = await this.ai.run(this.models.text, {
        messages: [
          { role: 'system', content: options.systemPrompt },
          { role: 'user', content: options.userPrompt },
        ],
        max_tokens: options.maxTokens ?? 512,
      });
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
    const request = await this.log(options, {
      status: 'FAILED',
      responseText: null,
      latencyMs: Date.now() - startedAt,
      tokensUsed: null,
      failureReason: `${reason}: ${detail}`,
    });

    return { ok: false, reason, request };
  }

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
    const row = {
      id: options.id ?? uuid(),
      userId: options.userId,
      requestType: options.requestType,
      inputContext: {
        ...options.inputContext,
        ...(outcome.failureReason === undefined ? {} : { failure_reason: outcome.failureReason }),
      },
      responseText: outcome.responseText,
      model: this.models.text,
      tokensUsed: outcome.tokensUsed,
      latencyMs: outcome.latencyMs,
      status: outcome.status,
      createdAt: now(),
    };

    await this.db.insert(aiRequests).values(row);

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

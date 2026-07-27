import { and, count, eq, inArray, lt } from 'drizzle-orm';

import type { Database } from '@/db/client';
import { AI_REQUEST_IN_FLIGHT_STATUSES, type QuestionType } from '@/db/enums';
import { aiRequests, assessmentQuestions, type AiRequest, type User } from '@/db/schema';
import { now } from '@/lib/datetime';
import { ApiError } from '@/lib/envelope';
import { describeError, pipelineLogger } from '@/lib/logger';
import {
  ASSESSMENT_GENERATION_OUTPUT_SCHEMA,
  ASSESSMENT_GENERATION_PROMPT_VERSION,
  ASSESSMENT_GENERATION_SYSTEM_PROMPT,
} from '@/prompts/assessment-generation.v1';
import type { AiGatewayService } from '@/modules/ai/ai-gateway-service';
import { AssessmentBuilderService } from '@/modules/assessment/assessment-builder-service';

/**
 * `AssessmentGenerationService` — the §31 pipeline: prompt, generate, validate (§34),
 * persist as an **unconfirmed draft**. Runs inside `GenerateAssessmentDraftJob` on the `ai`
 * queue; the HTTP endpoints only validate, authorize, and enqueue.
 *
 * ## What this service must never do
 *
 * It must never produce anything a student can be measured by without a human in between.
 * That property is not enforced here — it is enforced by §25's publish gate, which blocks
 * any version carrying a `confirmed_at IS NULL` mapping. This service's whole contract is to
 * *feed* that gate: every mapping it writes has `confirmed_at = NULL`, every question has
 * `source = 'AI_GENERATED'` and `source_ai_request_id` set, and the reviewer takes it from
 * there. An ungraded draft (a template with no dimensions) writes no mappings at all, so the
 * gate is trivially satisfied — §31's reflection-survey case, not a loophole.
 *
 * ## The async contract (§20's status endpoint)
 *
 * The endpoint **reserves** an `ai_requests` row as PENDING, answers 202 with its id, and
 * enqueues. The job advances that same row — PROCESSING, then SUCCESS or FAILED — so the row the
 * client polls exists from the first millisecond and always moves. The draft's outcome is then
 * read from the row, plus the one thing the row cannot know (whether questions landed):
 *
 *   - row PENDING           → PENDING   (queued, not yet picked up)
 *   - row PROCESSING        → PROCESSING (a consumer has it)
 *   - row FAILED            → FAILED    (the §30 taxonomy, or the stage that threw)
 *   - row SUCCESS, no q's   → VALIDATION_FAILED (§34 rejected the output; regenerate)
 *   - row SUCCESS, q's      → DRAFTED   (the review screen takes over)
 *   - in-flight past the deadline → FAILED, **and the row is reaped to match**
 *
 * ## Why the deadline exists, and what it is really guarding
 *
 * This pipeline spans two Worker invocations that share nothing but an id: an HTTP request that
 * enqueues, and a queue consumer that may never run. Message delivery is not guaranteed on any
 * useful timescale — a Free-plan queue retains for 24 h (§45), a message can exhaust its retries
 * into a dead-letter queue, and a dev or preview environment can be configured with a producer
 * and no consumer at all, in which case `send()` succeeds and *nothing* ever happens.
 *
 * The original design encoded "in flight" as the **absence** of a row, which made all of those
 * indistinguishable from "working on it" and from "that id never existed" — permanently. The
 * frontend polled a status that was structurally incapable of changing. Reserving the row makes
 * the stall visible; `GENERATION_DEADLINE_MS` is what turns a visible stall into a terminal,
 * reportable failure. **A request must never be able to sit in a non-terminal state forever**,
 * and no amount of correct queue configuration can guarantee that on its own.
 */

/** §34: every question needs at least this many options. */
const MIN_OPTIONS_PER_QUESTION = 2;

const QUESTION_TYPES_ALLOWED: readonly QuestionType[] = ['LIKERT', 'MULTIPLE_CHOICE', 'BOOLEAN'];

export interface GeneratedQuestion {
  questionText: string;
  questionType: QuestionType;
  options: { label: string; value: string; score: number }[];
  /** A code from the template's own dimensions — anything else is dropped by the validator. */
  dimensionCode: string | null;
}

export interface GenerationOutput {
  questions: GeneratedQuestion[];
  /** Mode A's inert suggestions (§31) — never persisted, surfaced to the reviewer as text. */
  suggestedDimensions: { name: string; description: string | null }[];
}

export interface GenerateDraftParams {
  /** The pre-allocated `ai_requests` id the client is polling. */
  aiRequestId: string;
  versionId: string;
  /** The requesting staff user — the `ai_requests` row names them. */
  userId: string;
  mode: 'DOCUMENT' | 'DESCRIPTION';
  /** Mode A: the browser-extracted document text. Mode B: the creator's typed description. */
  sourceText: string;
}

/**
 * What one run of `generateDraft` actually did.
 *
 * The job handler needs this because "the draft is ready" is a notification it must not send when
 * the draft is not ready — and before the row carried a lifecycle there was nothing to ask.
 */
export type DraftOutcome =
  | { outcome: 'DRAFTED'; questionCount: number }
  | { outcome: 'VALIDATION_FAILED' }
  | { outcome: 'FAILED'; failureReason: string };

export type DraftStatus =
  | { status: 'PENDING' }
  | { status: 'PROCESSING' }
  | { status: 'FAILED'; failureReason: string | null }
  | { status: 'VALIDATION_FAILED'; failureReason: string }
  | {
      status: 'DRAFTED';
      questionCount: number;
      suggestedDimensions: { name: string; description: string | null }[];
    };

/**
 * How long a generation may stay non-terminal before the system calls it dead (see the class
 * comment for why a deadline is required rather than merely prudent).
 *
 * Ten minutes is chosen against the *pipeline*, not the model: one Workers AI call at 4,096
 * max_tokens is seconds, and the queue's own `max_batch_timeout` is 30 s with 3 retries. Anything
 * still un-terminal ten minutes later is not slow — it is a message that will not be delivered,
 * and telling the reviewer to keep waiting is a worse answer than telling them to try again.
 */
export const GENERATION_DEADLINE_MS = 10 * 60 * 1000;

export const GENERATION_TIMED_OUT_REASON =
  'TIMED_OUT: the generation job was never completed within 10 minutes. The queued message was most likely never delivered to a consumer — check that the environment running this Worker declares a [[queues.consumers]] entry for the AI queue, then request a fresh generation.';

/**
 * The §34 output validator — pure, and deliberately exported on its own: this is the guard
 * that stands between a model's output and the database, so it gets its own unit tests
 * against hand-written malformed payloads rather than being reachable only through a job.
 *
 * Contract:
 *   - Malformed JSON (after stripping the ```fences``` chat models love) → `null`.
 *   - More than `maxQuestions` questions → **truncated** to the cap (§34 allows either).
 *   - A question with fewer than 2 options, a wrong shape, or an unknown type → dropped.
 *   - `dimension_code` not in `allowedDimensionCodes` → the mapping is dropped (kept as an
 *     unmapped question); the model was told to use only the provided codes (§32), and an
 *     invented code must not invent a dimension.
 *   - Zero surviving questions → `null` (the run failed §34, whatever the JSON looked like).
 */
export function parseGenerationOutput(
  raw: string,
  maxQuestions: number,
  allowedDimensionCodes: ReadonlySet<string>,
): GenerationOutput | null {
  const unfenced = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

  let parsed: unknown;

  try {
    parsed = JSON.parse(unfenced);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { questions?: unknown }).questions)) {
    return null;
  }

  const body = parsed as { questions: unknown[]; suggested_dimensions?: unknown };

  const questions: GeneratedQuestion[] = [];

  for (const entry of body.questions.slice(0, maxQuestions)) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }

    const q = entry as Record<string, unknown>;

    if (typeof q.question_text !== 'string' || q.question_text.trim().length === 0) {
      continue;
    }

    const questionType = QUESTION_TYPES_ALLOWED.find((type) => type === q.question_type);

    if (questionType === undefined || !Array.isArray(q.options)) {
      continue;
    }

    const options: GeneratedQuestion['options'] = [];

    for (const optionEntry of q.options) {
      if (optionEntry === null || typeof optionEntry !== 'object') {
        continue;
      }

      const option = optionEntry as Record<string, unknown>;

      if (
        typeof option.label !== 'string' ||
        option.label.trim().length === 0 ||
        typeof option.score !== 'number' ||
        !Number.isFinite(option.score)
      ) {
        continue;
      }

      options.push({
        label: option.label.trim(),
        value:
          typeof option.value === 'string' && option.value.trim().length > 0
            ? option.value.trim()
            : option.label.trim(),
        score: option.score,
      });
    }

    if (options.length < MIN_OPTIONS_PER_QUESTION) {
      continue;
    }

    const dimensionCode =
      typeof q.dimension_code === 'string' && allowedDimensionCodes.has(q.dimension_code.trim())
        ? q.dimension_code.trim()
        : null;

    questions.push({
      questionText: q.question_text.trim(),
      questionType,
      options,
      dimensionCode,
    });
  }

  if (questions.length === 0) {
    return null;
  }

  const suggestedDimensions: GenerationOutput['suggestedDimensions'] = [];

  if (Array.isArray(body.suggested_dimensions)) {
    for (const entry of body.suggested_dimensions) {
      if (entry === null || typeof entry !== 'object') {
        continue;
      }

      const suggestion = entry as Record<string, unknown>;

      if (typeof suggestion.name === 'string' && suggestion.name.trim().length > 0) {
        suggestedDimensions.push({
          name: suggestion.name.trim(),
          description:
            typeof suggestion.description === 'string' ? suggestion.description.trim() : null,
        });
      }
    }
  }

  return { questions, suggestedDimensions };
}

export class AssessmentGenerationService {
  private readonly builder: AssessmentBuilderService;

  constructor(
    private readonly db: Database,
    private readonly gateway: AiGatewayService,
    private readonly activePolicy: { instructions: string | null; restrictions: string | null } | null,
    private readonly maxQuestions: number,
  ) {
    this.builder = new AssessmentBuilderService(db);
  }

  /**
   * Run one queued generation (§31, both modes — they differ only in what the source text *is*).
   *
   * **Never throws, and never returns without the row being terminal.** Those two properties are
   * the whole point of this method's shape, and they used to be neither: every guard below was a
   * bare `return` that left the reserved row exactly as it found it, so a version that published
   * mid-queue, a deleted template, or a throw out of `addQuestions` all produced the same
   * permanently-PENDING poll as a message that was never delivered. Now each of them names
   * itself in `failure_reason`.
   *
   * Not throwing is a §30 v1.5 decision, not laziness: the consumer retries a throw, and none of
   * these failures get better on a retry — a dead quota stays dead, a published version stays
   * published, malformed model output stays malformed. The FAILED row *is* the outcome, and the
   * §20 poll is how it reaches the reviewer.
   */
  async generateDraft(params: GenerateDraftParams): Promise<DraftOutcome> {
    const logger = pipelineLogger('assessment_generation', {
      ai_request_id: params.aiRequestId,
      assessment_version_id: params.versionId,
      user_id: params.userId,
      mode: params.mode,
    });

    /** Terminate the reserved row and stop. Every early exit in this method goes through here. */
    const fail = async (stage: string, reason: string): Promise<DraftOutcome> => {
      logger.error(stage, { failure_reason: reason });
      await this.gateway.failReserved(params.aiRequestId, reason);

      return { outcome: 'FAILED', failureReason: reason };
    };

    /**
     * Everything is inside the try, including the first log line. That is not fastidiousness: the
     * payload is a queue message, so `sourceText` is whatever the producer put there — and a
     * `params.sourceText.length` sitting one line above the `try` would throw on a malformed
     * message, escape this method entirely, and leave the reserved row PENDING while the consumer
     * retried its way to the dead-letter queue. The point of this method is that no input can do
     * that; the boundary has to start above the first field access.
     */
    try {
      logger.info('job_received', { source_chars: params.sourceText.length });

      await this.gateway.markProcessing(params.aiRequestId);

      const version = await this.builder.findVersion(params.versionId);

      if (version === undefined) {
        return await fail(
          'version_missing',
          'PRECONDITION_FAILED: the assessment version no longer exists, so there is nothing to draft into.',
        );
      }

      if (version.status !== 'DRAFT') {
        // The version published or was archived while the message sat in the queue. Writing to it
        // is exactly what must not happen (§12: a published version is frozen forever) — but
        // saying so out loud is the part that was missing.
        return await fail(
          'version_not_draft',
          `PRECONDITION_FAILED: this version is ${version.status} and can no longer be drafted into. Create a new DRAFT version and generate again.`,
        );
      }

      const template = await this.builder.findTemplate(version.assessmentTemplateId);

      if (template === undefined) {
        return await fail(
          'template_missing',
          'PRECONDITION_FAILED: the assessment template no longer exists.',
        );
      }

      /**
       * §32's own rule: "you must never assume that check happened correctly." The endpoint
       * already refused non-CUSTOM categories at the policy layer (§39, category before
       * ownership); the job re-checks because a queue message is an input, not a proof.
       */
      if (template.category !== 'CUSTOM') {
        return await fail(
          'category_forbidden',
          `FORBIDDEN: ${template.category} assessments can never be AI-generated (§5).`,
        );
      }

      const dimensions = await this.builder.dimensionsFor(template.id);
      const allowedCodes = new Set(dimensions.map((dimension) => dimension.code));

      logger.info('preconditions_met', {
        template_id: template.id,
        dimension_codes: [...allowedCodes],
      });

      let systemPrompt: string;
      let userPrompt: string;

      try {
        systemPrompt = this.systemPrompt();
        userPrompt = this.userPrompt(params, dimensions);
      } catch (error) {
        // Prompt assembly is string work over admin-editable policy text (§32). It should not
        // throw — and if it ever does, the reviewer is owed the reason rather than a silent stall.
        return await fail(
          'prompt_assembly_failed',
          `PROMPT_ERROR: the prompt could not be assembled — ${describeError(error)}`,
        );
      }

      logger.info('prompt_built', {
        prompt_version: ASSESSMENT_GENERATION_PROMPT_VERSION,
        system_prompt_chars: systemPrompt.length,
        user_prompt_chars: userPrompt.length,
      });

      const result = await this.gateway.generate({
        id: params.aiRequestId,
        userId: params.userId,
        requestType: 'ASSESSMENT_GENERATION',
        systemPrompt,
        userPrompt,
        inputContext: {
          prompt_version: ASSESSMENT_GENERATION_PROMPT_VERSION,
          assessment_version_id: params.versionId,
          mode: params.mode,
          dimension_codes: [...allowedCodes],
          source_chars: params.sourceText.length,
        },
        maxTokens: 4096,
      });

      if (!result.ok) {
        // The gateway already wrote the FAILED row with the §30 taxonomy in `failure_reason`.
        logger.error('model_failed', { reason: result.reason });

        return { outcome: 'FAILED', failureReason: failureReasonOf(result.request) ?? result.reason };
      }

      logger.info('response_received', { response_chars: result.text.length });

      const output = parseGenerationOutput(result.text, this.maxQuestions, allowedCodes);

      if (output === null) {
        /**
         * §34 rejected the output. The row stays SUCCESS — the *model* did answer, and the audit
         * trail must not claim otherwise — and `statusFor` derives VALIDATION_FAILED from the
         * SUCCESS-with-no-questions shape. The distinction is real: MODEL_ERROR means try again,
         * VALIDATION_FAILED means the prompt or the source text needs work.
         */
        logger.warn('validation_failed', {
          reason: 'The model responded but no question survived the §34 validator.',
        });

        return { outcome: 'VALIDATION_FAILED' };
      }

      logger.info('output_parsed', {
        question_count: output.questions.length,
        mapped_questions: output.questions.filter((question) => question.dimensionCode !== null).length,
        suggested_dimensions: output.suggestedDimensions.length,
      });

      // `addQuestions` reads only `user.id`, and only to stamp `confirmed_by` on MANUAL
      // mappings — which an AI_GENERATED batch never has. A queue job holds a user id, not a
      // session, so the minimal shape is passed rather than paying a D1 read for unused fields.
      const questionIds = await this.builder.addQuestions(
        { id: params.userId } as User,
        params.versionId,
        output.questions.map((question, index) => ({
          questionText: question.questionText,
          questionType: question.questionType,
          orderNumber: index + 1,
          required: true,
          source: 'AI_GENERATED' as const,
          sourceAiRequestId: params.aiRequestId,
          options: question.options.map((option, optionIndex) => ({
            label: option.label,
            value: option.value,
            score: option.score,
            orderNumber: optionIndex + 1,
          })),
          dimensions: question.dimensionCode === null ? [] : [{ code: question.dimensionCode }],
        })),
      );

      logger.info('completed', { question_count: questionIds.length });

      return { outcome: 'DRAFTED', questionCount: questionIds.length };
    } catch (error) {
      /**
       * The catch-all. `addQuestions` throws `ApiError` for a version that stopped being editable
       * between the check above and the insert, and D1 can throw for reasons no guard predicts.
       * Before this existed, the throw propagated to the consumer, which retried it three times
       * and dead-lettered it — and `markAiJobFailed` did not handle this job type, so the row was
       * never touched and the poll stayed PENDING forever. That is the reported bug, in one path.
       */
      return await fail(
        'unhandled_error',
        `INTERNAL_ERROR: the generation job failed — ${describeError(error)}`,
      );
    }
  }

  /** The draft status — see the class comment for the states, the deadline, and why. */
  async statusFor(aiRequestId: string, userId: string): Promise<DraftStatus> {
    const [request] = await this.db
      .select()
      .from(aiRequests)
      .where(eq(aiRequests.id, aiRequestId))
      .limit(1);

    /**
     * Scoped like every "mine" read: a row someone else created is indistinguishable from one
     * that does not exist. Both report PENDING, which is deliberate — an id is a capability here,
     * and a distinguishable answer would turn this endpoint into an oracle for other people's
     * request ids. Neither case can hang a real client: the frontend only ever polls an id it was
     * handed by its own 202, and its own hard timeout covers the rest.
     */
    if (request?.userId !== userId) {
      return { status: 'PENDING' };
    }

    if (request.status === 'PENDING' || request.status === 'PROCESSING') {
      // Non-terminal. If it has been non-terminal for too long, it is not slow — it is stuck, and
      // the reap makes that permanent so every other reader (the admin list, the dashboards) sees
      // the same truth this poll just reported.
      if (Date.parse(request.createdAt) + GENERATION_DEADLINE_MS < Date.now()) {
        await this.reapStale(aiRequestId);

        return { status: 'FAILED', failureReason: GENERATION_TIMED_OUT_REASON };
      }

      return { status: request.status };
    }

    if (request.status === 'FAILED') {
      return { status: 'FAILED', failureReason: failureReasonOf(request) };
    }

    const [drafted] = await this.db
      .select({ total: count() })
      .from(assessmentQuestions)
      .where(eq(assessmentQuestions.sourceAiRequestId, aiRequestId));

    const questionCount = drafted?.total ?? 0;

    if (questionCount === 0) {
      return {
        status: 'VALIDATION_FAILED',
        failureReason:
          'The model responded, but its output failed validation (§34) and nothing was drafted. Request a fresh generation.',
      };
    }

    const output =
      request.responseText === null
        ? null
        : parseGenerationOutput(request.responseText, Number.MAX_SAFE_INTEGER, new Set());

    return {
      status: 'DRAFTED',
      questionCount,
      suggestedDimensions: output?.suggestedDimensions ?? [],
    };
  }

  /**
   * Persist the timeout the poll just observed.
   *
   * A read that writes deserves justification: the alternative is deriving the deadline afresh on
   * every read and leaving the row PENDING forever in storage, which would mean the poll says
   * FAILED while `/admin/ai-requests` and the dashboards still say PENDING — one fact, two
   * answers. The nightly sweep (`jobs/cleanup.ts`) reaps rows nobody polls; this reaps the ones
   * somebody is watching, at the moment they notice. Guarded on the in-flight statuses, so a job
   * that completes in the same instant wins and is never overwritten.
   */
  private async reapStale(aiRequestId: string): Promise<void> {
    await this.db
      .update(aiRequests)
      .set({ status: 'FAILED', failureReason: GENERATION_TIMED_OUT_REASON, updatedAt: now() })
      .where(
        and(
          eq(aiRequests.id, aiRequestId),
          inArray(aiRequests.status, [...AI_REQUEST_IN_FLIGHT_STATUSES]),
        ),
      );
  }

  // --- prompt assembly (§32) -------------------------------------------------------------

  private systemPrompt(): string {
    return ASSESSMENT_GENERATION_SYSTEM_PROMPT.replace(
      '{active_ai_policy.instructions}',
      this.activePolicy?.instructions ?? '',
    )
      .replace('{active_ai_policy.restrictions}', this.activePolicy?.restrictions ?? '')
      .replace('{max_questions}', String(this.maxQuestions));
  }

  private userPrompt(
    params: GenerateDraftParams,
    dimensions: { code: string; name: string; description: string | null }[],
  ): string {
    const dimensionBlock =
      dimensions.length === 0
        ? params.mode === 'DOCUMENT'
          ? 'No dimensions were provided. You may include suggested_dimensions based on the source material; produce questions without dimension_code.'
          : 'No dimensions were provided. This is an ungraded survey: produce questions without dimension_code and no suggested_dimensions.'
        : [
            'Map every question onto exactly one of THESE dimensions (by code), and no others:',
            ...dimensions.map(
              (dimension) =>
                `- ${dimension.code}: ${dimension.name}${dimension.description === null ? '' : ` — ${dimension.description}`}`,
            ),
          ].join('\n');

    return [
      params.mode === 'DOCUMENT'
        ? 'SOURCE DOCUMENT (extracted text) — draft assessment questions from this material:'
        : "CREATOR'S DESCRIPTION — draft the assessment it asks for:",
      params.sourceText,
      '',
      'DIMENSIONS',
      dimensionBlock,
      '',
      'OUTPUT SCHEMA (strict JSON, no prose outside it):',
      ASSESSMENT_GENERATION_OUTPUT_SCHEMA,
    ].join('\n');
  }
}

/**
 * The §30 taxonomy verbatim, from its own column since migration 0015.
 *
 * The `input_context` fallback reads rows written before that migration backfilled them — and
 * rows an older deployment may still be writing during a rolling deploy. Cheap, and the
 * alternative is a status endpoint that reports "the model was unavailable" for a failure whose
 * real reason is sitting one key away.
 */
function failureReasonOf(request: AiRequest): string | null {
  if (typeof request.failureReason === 'string' && request.failureReason.length > 0) {
    return request.failureReason;
  }

  const legacy = request.inputContext?.failure_reason;

  return typeof legacy === 'string' ? legacy : null;
}

/**
 * Reap every non-terminal `ai_requests` row past the deadline, whoever owns it (audit M11 — the
 * nightly Cron in `jobs/cleanup.ts`).
 *
 * `statusFor` only reaps what somebody polls. A reviewer who closed the tab, or a system-triggered
 * request nobody polls at all, would otherwise leave a PENDING row in the table forever — visible
 * in the admin AI list as work that is apparently still running, months later.
 */
export async function reapStaleAiRequests(db: Database, deadlineMs = GENERATION_DEADLINE_MS): Promise<number> {
  const cutoff = new Date(Date.now() - deadlineMs).toISOString();

  const reaped = await db
    .update(aiRequests)
    .set({ status: 'FAILED', failureReason: GENERATION_TIMED_OUT_REASON, updatedAt: now() })
    .where(
      and(
        inArray(aiRequests.status, [...AI_REQUEST_IN_FLIGHT_STATUSES]),
        lt(aiRequests.createdAt, cutoff),
      ),
    )
    .returning({ id: aiRequests.id });

  return reaped.length;
}

/** Guard the §34 source-text caps at the endpoint, before anything is queued. */
export const GENERATION_SOURCE_MIN_CHARS = 20;
export const GENERATION_SOURCE_MAX_CHARS = 500_000;

export function assertGenerationSource(text: string): void {
  const trimmed = text.trim();

  if (trimmed.length < GENERATION_SOURCE_MIN_CHARS) {
    throw ApiError.validation({
      source: ['The source text is too short to draft an assessment from.'],
    });
  }

  if (trimmed.length > GENERATION_SOURCE_MAX_CHARS) {
    throw ApiError.validation({
      source: [
        `The source text exceeds the ${GENERATION_SOURCE_MAX_CHARS.toLocaleString()}-character cap.`,
      ],
    });
  }
}

import { count, eq } from 'drizzle-orm';

import type { Database } from '@/db/client';
import type { QuestionType } from '@/db/enums';
import { aiRequests, assessmentQuestions, type AiRequest, type User } from '@/db/schema';
import { ApiError } from '@/lib/envelope';
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
 * The endpoint answers 202 with a **pre-allocated `ai_requests` id** and enqueues; the job
 * hands that id to the gateway, so the row the gateway writes is the row the client polls.
 * The draft's outcome is then *derived*, never stored twice:
 *
 *   - no row yet            → PENDING   (queued, or the job is running)
 *   - row FAILED            → FAILED    (model/quota trouble — the §30 taxonomy, in the row)
 *   - row SUCCESS, no q's   → VALIDATION_FAILED (§34 rejected the output; regenerate)
 *   - row SUCCESS, q's      → DRAFTED   (the review screen takes over)
 *
 * A Free-plan queue keeps a message for 24 h (§45): a job that never ran leaves the status
 * PENDING forever, and the honest remedy is the same button as a validation failure —
 * request a fresh generation.
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

export type DraftStatus =
  | { status: 'PENDING' }
  | { status: 'FAILED'; failureReason: string | null }
  | { status: 'VALIDATION_FAILED'; failureReason: string }
  | {
      status: 'DRAFTED';
      questionCount: number;
      suggestedDimensions: { name: string; description: string | null }[];
    };

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
   * Run one queued generation (§31, both modes — they differ only in what the source text
   * *is*). Never throws for model trouble: the FAILED `ai_requests` row is the outcome, and
   * retrying into a dead quota cannot succeed (§30 v1.5). Throws only for states that mean
   * the *message* is wrong (missing version), which the consumer acks as unprocessable.
   */
  async generateDraft(params: GenerateDraftParams): Promise<void> {
    const version = await this.builder.findVersion(params.versionId);

    if (version?.status !== 'DRAFT') {
      // The version vanished or published while the message sat in the queue. Nothing to do —
      // and nothing to write, because writing to it is exactly what must not happen.
      return;
    }

    const template = await this.builder.findTemplate(version.assessmentTemplateId);

    if (template === undefined) {
      return;
    }

    /**
     * §32's own rule: "you must never assume that check happened correctly." The endpoint
     * already refused non-CUSTOM categories at the policy layer (§39, category before
     * ownership); the job re-checks because a queue message is an input, not a proof.
     */
    if (template.category !== 'CUSTOM') {
      return;
    }

    const dimensions = await this.builder.dimensionsFor(template.id);
    const allowedCodes = new Set(dimensions.map((dimension) => dimension.code));

    const result = await this.gateway.generate({
      id: params.aiRequestId,
      userId: params.userId,
      requestType: 'ASSESSMENT_GENERATION',
      systemPrompt: this.systemPrompt(),
      userPrompt: this.userPrompt(params, dimensions),
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
      return; // The FAILED row is written; the status endpoint reports it.
    }

    const output = parseGenerationOutput(result.text, this.maxQuestions, allowedCodes);

    if (output === null) {
      // A SUCCESS row with no questions behind it — the status endpoint derives
      // VALIDATION_FAILED from exactly that shape. Nothing to persist from output §34 rejected.
      return;
    }

    // `addQuestions` reads only `user.id`, and only to stamp `confirmed_by` on MANUAL
    // mappings — which an AI_GENERATED batch never has. A queue job holds a user id, not a
    // session, so the minimal shape is passed rather than paying a D1 read for unused fields.
    await this.builder.addQuestions(
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
  }

  /** The derived draft status — see the class comment for the four states and why. */
  async statusFor(aiRequestId: string, userId: string): Promise<DraftStatus> {
    const [request] = await this.db
      .select()
      .from(aiRequests)
      .where(eq(aiRequests.id, aiRequestId))
      .limit(1);

    if (request === undefined) {
      return { status: 'PENDING' };
    }

    // Scoped like every "mine" read: a row someone else created is indistinguishable from
    // one that does not exist (it reports PENDING, which is also what a bogus id reports).
    if (request.userId !== userId) {
      return { status: 'PENDING' };
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

/** The `failure_reason` the gateway tucked into `input_context` (§30's taxonomy, verbatim). */
function failureReasonOf(request: AiRequest): string | null {
  const reason = request.inputContext?.failure_reason;

  return typeof reason === 'string' ? reason : null;
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

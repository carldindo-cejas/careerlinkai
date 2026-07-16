import { Hono, type Context } from 'hono';

import { createDatabase } from '@/db/client';
import type { AppEnv } from '@/env';
import {
  AI_REQUEST_LIMIT,
  AI_REQUEST_WINDOW_SECONDS,
  aiRateLimitGuard,
} from '@/lib/auth-guard';
import { assessmentGenerationMaxQuestions } from '@/lib/config';
import { uuid } from '@/lib/crypto';
import { successEnvelope, ApiError } from '@/lib/envelope';
import { parseBody } from '@/lib/validation';
import { authenticate, requireUser } from '@/middleware/authenticate';
import { ensurePasswordChanged } from '@/middleware/ensure-password-changed';
import { ensureRole } from '@/middleware/ensure-role';
import {
  assertGenerationSource,
  AssessmentGenerationService,
} from '@/modules/ai/assessment-generation-service';
import { aiGatewayFrom } from '@/modules/ai/factory';
import { AssessmentBuilderService } from '@/modules/assessment/assessment-builder-service';
import {
  generateFromDescriptionSchema,
  generateFromDocumentSchema,
} from '@/modules/assessment/schemas';
import { authorizeGenerateWithAi } from '@/policies/assessment';

/**
 * The AI-assisted generation group (FULLPLAN §20, §31) — the AI module's second router.
 *
 * Three endpoints: the two entry modes and the poll. Everything else the §31 flow needs
 * (the review payload, per-mapping confirm, publish-readiness, publish) is builder surface
 * and lives in the assessment module's `builder-routes.ts` — generation *feeds* the
 * builder's gate, it does not own it.
 *
 * `authorizeGenerateWithAi` runs as the first act of both POST endpoints (§39: "checked as
 * the very first line of every endpoint in this group") — category before ownership, 403
 * for RIASEC/SCCT with no role exception, 404 for a template that is not the caller's.
 */
export const generationRoutes = new Hono<AppEnv>();

// Scoped to this router's own prefixes, not '*' — see the same note in builder-routes.ts:
// a root-mounted '*' middleware would turn the API's 404 for unknown paths into a 401.
for (const prefix of ['/assessment-versions/*', '/ai/*']) {
  generationRoutes.use(prefix, authenticate());
  generationRoutes.use(prefix, ensureRole('counselor', 'admin'));
  generationRoutes.use(prefix, ensurePasswordChanged());
}

async function enqueueGeneration(
  c: Context<AppEnv>,
  versionId: string,
  mode: 'DOCUMENT' | 'DESCRIPTION',
  sourceText: string,
) {
  const user = requireUser(c);
  const db = createDatabase(c.env.DB);
  const builder = new AssessmentBuilderService(db);

  const version = await builder.findVersion(versionId);

  if (version === undefined) {
    throw ApiError.notFound('Assessment version not found.');
  }

  const template = await builder.findTemplate(version.assessmentTemplateId);

  // §39: the very first rule of this group — category before ownership, no role exception.
  authorizeGenerateWithAi(user, template);

  if (version.status !== 'DRAFT') {
    throw ApiError.validation(
      { version: [`This version is ${version.status} and can no longer be drafted into.`] },
      'AI generation targets a DRAFT version.',
    );
  }

  assertGenerationSource(sourceText);

  // §34/§41: 10 AI requests/minute per user, charged on every attempt, checked before the
  // job is even queued — the limiter guards a hard daily neuron quota (§45).
  const guard = aiRateLimitGuard(c.env, user.id);
  const state = await guard.check(AI_REQUEST_LIMIT);

  if (state.locked) {
    throw ApiError.tooManyRequests({
      generation: [`Too many AI requests. Try again in ${state.retryAfterSeconds} seconds.`],
    });
  }

  await guard.recordFailure(AI_REQUEST_LIMIT, AI_REQUEST_WINDOW_SECONDS);

  /**
   * The id is allocated HERE and travels with the job, so the `ai_requests` row the gateway
   * eventually writes is the row this response already told the client to poll. Until the
   * job runs, the id resolves to PENDING.
   */
  const aiRequestId = uuid();

  await c.env.QUEUE_AI.send({
    type: 'GenerateAssessmentDraft',
    payload: {
      aiRequestId,
      versionId: version.id,
      userId: user.id,
      mode,
      sourceText: sourceText.trim(),
    },
  });

  return c.json(
    successEnvelope(
      { ai_request_id: aiRequestId, status: 'PENDING' },
      'Generation queued. Poll /ai/requests/{id}/status; the draft lands on this version for review.',
    ),
    202,
  );
}

/** §31 Mode A — the browser already extracted the document's text (the shared §33 utility). */
generationRoutes.post('/assessment-versions/:versionId/ai-generate/document', async (c) => {
  const input = await parseBody(c, generateFromDocumentSchema);

  return enqueueGeneration(c, c.req.param('versionId'), 'DOCUMENT', input.extracted_text);
});

/** §31 Mode B — a typed description; the template's own dimensions are the target set. */
generationRoutes.post('/assessment-versions/:versionId/ai-generate/description', async (c) => {
  const input = await parseBody(c, generateFromDescriptionSchema);

  return enqueueGeneration(c, c.req.param('versionId'), 'DESCRIPTION', input.description);
});

/**
 * `GET /ai/requests/{id}/status` (§20) — the poll. The status is *derived* (see
 * `AssessmentGenerationService.statusFor`): PENDING until the job's row exists, then the
 * row's own outcome, then DRAFTED once questions reference it. A row that is not the
 * caller's reports PENDING — indistinguishable from an id that never existed.
 */
generationRoutes.get('/ai/requests/:aiRequestId/status', async (c) => {
  const user = requireUser(c);
  const db = createDatabase(c.env.DB);

  const service = new AssessmentGenerationService(
    db,
    aiGatewayFrom(db, c.env),
    null, // The policy text shapes prompts, not status reads.
    assessmentGenerationMaxQuestions(c.env),
  );

  const status = await service.statusFor(c.req.param('aiRequestId'), user.id);

  return c.json(
    successEnvelope(
      {
        ai_request_id: c.req.param('aiRequestId'),
        status: status.status,
        ...(status.status === 'FAILED' || status.status === 'VALIDATION_FAILED'
          ? { failure_reason: status.failureReason }
          : {}),
        ...(status.status === 'DRAFTED'
          ? {
              question_count: status.questionCount,
              suggested_dimensions: status.suggestedDimensions.map((suggestion) => ({
                name: suggestion.name,
                description: suggestion.description,
              })),
            }
          : {}),
      },
      'Generation status retrieved.',
    ),
  );
});

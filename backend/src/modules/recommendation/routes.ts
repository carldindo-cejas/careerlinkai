import { Hono, type Context } from 'hono';

import { createDatabase } from '@/db/client';
import type { AppEnv } from '@/env';
import {
  AI_REQUEST_LIMIT,
  AI_REQUEST_WINDOW_SECONDS,
  aiRateLimitGuard,
} from '@/lib/auth-guard';
import { successEnvelope, ApiError } from '@/lib/envelope';
import { authenticate, requireUser } from '@/middleware/authenticate';
import { ensurePasswordChanged } from '@/middleware/ensure-password-changed';
import { ensureRole } from '@/middleware/ensure-role';
import { AiPolicyService } from '@/modules/ai/ai-policy-service';
import { ExplanationService } from '@/modules/ai/explanation-service';
import { aiGatewayFrom, retrievalFrom } from '@/modules/ai/factory';
import { serializeExplanation } from '@/modules/ai/serializers';
import { RecommendationService } from '@/modules/recommendation/recommendation-service';
import { serializeRecommendationSet } from '@/modules/recommendation/serializers';
import { authorizeStudentRecommendations } from '@/policies/recommendation';

/**
 * The Recommendation module's HTTP surface (FULLPLAN §20, §37).
 *
 * ## `data: null` is an answer, not an error
 *
 * A student who has not completed **both** RIASEC and SCCT has no recommendations, and that is the
 * ordinary state of most students most of the time — not a 404. These endpoints answer **200 with
 * `data: null`**, which lets the client distinguish three genuinely different situations that a
 * 404 would flatten into one:
 *
 *   * *"we could not load your recommendations"* — a failed request,
 *   * *"you do not have any yet"* — 200 with null, and
 *   * *"you have these"* — 200 with a set.
 *
 * That distinction is not academic here. Deviation D11 exists precisely because the Phase 3 screens
 * could not tell the first two apart, and told a student they had nothing to do while the endpoint
 * was 404ing. Handing the recommendation screens the same ambiguity, in the same release that fixes
 * D11, would be a poor joke.
 */

// --- /student (role: student only) -----------------------------------------------------------

export const studentRecommendationRoutes = new Hono<AppEnv>();

/**
 * No policy runs on this router, and that is structural rather than an oversight: every route here
 * resolves "me" from the bearer token. There is **no student id in any URL**, so a route that means
 * "my recommendations" cannot be made to mean "someone else's" by editing a parameter. The safest
 * access-control check is the one with nothing to check.
 *
 * `ensurePasswordChanged` is absent for the same reason it is absent on the other `/student` routes:
 * students have no password (§38), so the flag it guards can never be set for them.
 */
studentRecommendationRoutes.use('*', authenticate());
studentRecommendationRoutes.use('*', ensureRole('student'));

/**
 * `GET /student/recommendations` and `/recommendations/latest` are **the same thing in v1**, and
 * the alias is deliberate rather than sloppy: §20 catalogs both, and only one set of
 * recommendations exists at a time per student — regeneration *replaces* a result's rows rather
 * than accumulating versions. The day a student can browse the history of their recommendations
 * (§63), `/recommendations` grows a list shape and `/latest` keeps this one; keeping both names
 * alive now means that change does not break a client.
 */
async function latestFor(c: Context<AppEnv>) {
  const service = new RecommendationService(createDatabase(c.env.DB));
  const set = await service.latestFor(requireUser(c).id);

  return c.json(
    successEnvelope(
      set === null ? null : serializeRecommendationSet(set),
      set === null
        ? 'No recommendations yet. Complete both RIASEC and SCCT to receive them.'
        : 'Recommendations retrieved.',
    ),
  );
}

studentRecommendationRoutes.get('/recommendations', latestFor);
studentRecommendationRoutes.get('/recommendations/latest', latestFor);

/**
 * `POST /student/recommendations/{id}/explain` (§20) — "request AI explanation, if not
 * already generated." The §30 pipeline runs inside this request: the work is one embedding,
 * one Vectorize query, one model call — await time, which costs no CPU (§42), so there is
 * nothing here that needs the queue that the *proactive* generation path uses.
 *
 * Whatever happens to the model, the response is a 200 with `fallback_reason` always
 * present: the deterministic §27 reason is what the card shows when there is no paragraph.
 * The failure modes (no grounding, quota exhausted, model down) differ only in the
 * `failure` field and in what got logged to `ai_requests` (§30 v1.5).
 */
studentRecommendationRoutes.post('/recommendations/:id/explain', async (c) => {
  const user = requireUser(c);
  const db = createDatabase(c.env.DB);
  const recommendationService = new RecommendationService(db);

  // Scoped to "mine" like every /student route: an id that is not yours 404s, identically
  // to one that does not exist.
  const recommendation = await recommendationService.findForStudent(user.id, c.req.param('id'));

  if (recommendation === null) {
    throw ApiError.notFound('Recommendation not found.');
  }

  // An existing explanation costs nothing and is not charged against the AI limit.
  const existing = await recommendationService.explanationFor(recommendation.id);

  if (existing !== null) {
    return c.json(
      successEnvelope(
        {
          explanation: serializeExplanation(existing),
          fallback_reason: recommendation.reason,
          failure: null,
        },
        'Explanation retrieved.',
      ),
    );
  }

  // §41: 10 AI requests/minute per user, enforced before anything is generated. The counter
  // is an AuthGuardDO instance (v1.5) — every attempt is charged, because this limiter
  // guards a hard daily neuron quota (§45), not a failure pattern.
  const guard = aiRateLimitGuard(c.env, user.id);
  const state = await guard.check(AI_REQUEST_LIMIT);

  if (state.locked) {
    throw ApiError.tooManyRequests({
      explanation: [`Too many AI requests. Try again in ${state.retryAfterSeconds} seconds.`],
    });
  }

  await guard.recordFailure(AI_REQUEST_LIMIT, AI_REQUEST_WINDOW_SECONDS);

  const policy = await new AiPolicyService(db).activeGlobal();
  const service = new ExplanationService(db, aiGatewayFrom(db, c.env), retrievalFrom(db, c.env), policy);
  const outcome = await service.explain(recommendation, user.id);

  return c.json(
    successEnvelope(
      {
        explanation: outcome.explanation === null ? null : serializeExplanation(outcome.explanation),
        fallback_reason: outcome.fallbackReason,
        failure: outcome.failure ?? null,
      },
      outcome.explanation === null
        ? 'An AI explanation is not available right now. The deterministic reason still applies.'
        : 'Explanation generated.',
    ),
  );
});

// --- /counselor (role: counselor or admin) ---------------------------------------------------

export const counselorRecommendationRoutes = new Hono<AppEnv>();

counselorRecommendationRoutes.use('*', authenticate());
counselorRecommendationRoutes.use('*', ensureRole('counselor', 'admin'));
counselorRecommendationRoutes.use('*', ensurePasswordChanged());

/**
 * `GET /counselor/students/{id}/recommendations` (§20).
 *
 * This is the one route in the module that names another human being in its URL, so it is the one
 * route that needs a policy. §4: a counselor sees "results and recommendations for their own
 * students only". The policy answers **404** rather than 403 for a student outside their classes —
 * a 403 would confirm the student exists, and a counselor who can enumerate student ids by watching
 * status codes has been handed a roster nobody gave them.
 */
counselorRecommendationRoutes.get('/students/:studentId/recommendations', async (c) => {
  const db = createDatabase(c.env.DB);
  const studentId = c.req.param('studentId');

  await authorizeStudentRecommendations(db, requireUser(c), studentId);

  const set = await new RecommendationService(db).latestFor(studentId);

  return c.json(
    successEnvelope(
      set === null ? null : serializeRecommendationSet(set),
      set === null
        ? 'This student has no recommendations yet.'
        : 'Recommendations retrieved.',
    ),
  );
});

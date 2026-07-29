import { Hono, type Context } from 'hono';

import { createDatabase, type Database } from '@/db/client';
import type { AppEnv } from '@/env';
import {
  AI_REQUEST_LIMIT,
  AI_REQUEST_WINDOW_SECONDS,
  aiRateLimitGuard,
  RECOMMENDATION_REGENERATE_LIMIT,
  RECOMMENDATION_REGENERATE_WINDOW_SECONDS,
  recommendationRegenerateGuard,
} from '@/lib/auth-guard';
import { successEnvelope, ApiError } from '@/lib/envelope';
import { parseBody } from '@/lib/validation';
import { authenticate, requireUser } from '@/middleware/authenticate';
import { ensurePasswordChanged } from '@/middleware/ensure-password-changed';
import { ensureRole } from '@/middleware/ensure-role';
import { AiPolicyService } from '@/modules/ai/ai-policy-service';
import { ChatService } from '@/modules/ai/chat-service';
import { ExplanationService } from '@/modules/ai/explanation-service';
import { aiGatewayFrom, retrievalFrom } from '@/modules/ai/factory';
import { askChatSchema } from '@/modules/ai/schemas';
import { serializeChatMessage, serializeExplanation } from '@/modules/ai/serializers';
import { AcademicCatalogService } from '@/modules/catalog/academic-catalog-service';
import {
  serializeCanonicalProgram,
  serializeCareer,
  serializeCollege,
  serializeProgram,
} from '@/modules/catalog/serializers';
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
 * The chat assistant's dependencies, assembled in one place.
 *
 * The active AI policy is read per request rather than cached: it is the one database-editable
 * part of the system prompt (§13.7), and an admin who edits it expects the next message to obey it.
 */
async function chatServiceForAsync(db: Database, c: Context<AppEnv>): Promise<ChatService> {
  const policy = await new AiPolicyService(db).activeGlobal();

  return new ChatService(db, aiGatewayFrom(db, c.env), retrievalFrom(db, c.env), policy);
}

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
 * `POST /student/recommendations/regenerate` (audit C4) — **the recovery path that did not exist.**
 *
 * Until this endpoint, `RecommendationService.generateFor()` had exactly one caller in the system:
 * the `AssessmentCompleted` listener. `dispatch()` catches and logs every listener failure by
 * design — correctly, since a recommendation engine having a bad day must not turn a completed
 * assessment into a 500 while the student is sitting on the submit screen. But nothing was ever
 * paired with that swallow. A transient D1 error during the listener left a student with both
 * assessments SCORED and **no recommendations, permanently**, being told by their own screen to
 * "complete both assessments" — advice they had already followed. The only escape was a counselor
 * resetting an attempt and the student re-sitting sixty items.
 *
 * The same endpoint also answers the slower problem: recommendations are generated once, at submit,
 * against the catalog as it stood that day. An administrator who adds twenty colleges next month
 * changes nothing for any existing student. This is how they catch up.
 *
 * Safe to call at any time. `generateFor` is idempotent by construction (§26) — it deletes the
 * student's whole set and rewrites it from the same inputs — so pressing this twice produces the
 * same rows, not two sets. `null` is returned unchanged when the student genuinely has not finished
 * both instruments, which keeps this endpoint's "nothing to show" indistinguishable from the GET's.
 */
studentRecommendationRoutes.post('/recommendations/regenerate', async (c) => {
  const user = requireUser(c);
  const db = createDatabase(c.env.DB);

  // Charged on every attempt, allowed or not — this guards D1 write volume, not a failure pattern.
  const state = await recommendationRegenerateGuard(c.env, user.id).charge(
    RECOMMENDATION_REGENERATE_LIMIT,
    RECOMMENDATION_REGENERATE_WINDOW_SECONDS,
  );

  if (state.locked) {
    throw ApiError.tooManyRequests({
      recommendations: [
        `Recommendations were rebuilt very recently. Try again in ${state.retryAfterSeconds} seconds.`,
      ],
    });
  }

  const service = new RecommendationService(db);

  await service.generateFor(user.id);

  // Re-read rather than serializing what `generateFor` returned: it answers with *counts*, and the
  // screen needs the hydrated set (careers, programs, the college join). Reading it back is also
  // what makes the `null` case honest — if generation could not run, this returns exactly what the
  // GET would, instead of a success shape describing a set that is not there.
  const set = await service.latestFor(user.id);

  return c.json(
    successEnvelope(
      set === null ? null : serializeRecommendationSet(set),
      set === null
        ? 'No recommendations could be generated yet. Complete both RIASEC and SCCT first.'
        : 'Recommendations rebuilt from your latest results.',
    ),
  );
});

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
  // One atomic check-and-charge (M1): closes the TOCTOU the check()-then-recordFailure() pair had.
  const state = await guard.charge(AI_REQUEST_LIMIT, AI_REQUEST_WINDOW_SECONDS);

  if (state.locked) {
    throw ApiError.tooManyRequests({
      explanation: [`Too many AI requests. Try again in ${state.retryAfterSeconds} seconds.`],
    });
  }

  const policy = await new AiPolicyService(db).activeGlobal();
  const service = new ExplanationService(
    db,
    aiGatewayFrom(db, c.env),
    retrievalFrom(db, c.env),
    policy,
  );
  const outcome = await service.explain(recommendation, user.id);

  return c.json(
    successEnvelope(
      {
        explanation:
          outcome.explanation === null ? null : serializeExplanation(outcome.explanation),
        fallback_reason: outcome.fallbackReason,
        failure: outcome.failure ?? null,
      },
      outcome.explanation === null
        ? 'An AI explanation is not available right now. The deterministic reason still applies.'
        : 'Explanation generated.',
    ),
  );
});

/**
 * `GET /student/careers/{id}/programs` — **"which college programs lead to this career?"**
 *
 * The `program_careers` mapping, read in the direction nothing needed until now: §27 only ever
 * traversed program → careers, to average their Holland codes. Same rows, same `active` chain.
 *
 * Not scoped to the student's own recommendations, and deliberately so. A student looking at
 * "Software Engineer" is asking what they could study to get there — answering with only the two
 * programs that happen to be in their own top ten would be answering a different, smaller question
 * and would hide the rest of the catalog behind a ranking they did not ask about.
 *
 * The career id is not a leak: `GET /careers/public` already serves the whole active career list to
 * anyone at all, so nothing here is reachable that was not already public. It lives under
 * `/student` because it needs no other scoping and the student shell is where it is used.
 */
studentRecommendationRoutes.get('/careers/:id/programs', async (c) => {
  const service = new AcademicCatalogService(createDatabase(c.env.DB));
  const career = await service.findCareer(c.req.param('id'));
  const rows = await service.programsForCareer(career.id);

  return c.json(
    successEnvelope(
      {
        career: serializeCareer(career),
        programs: rows.map(({ program, college, canonical }) => ({
          program: serializeProgram(program, undefined, { canonical }),
          college: serializeCollege(college),
        })),
      },
      rows.length === 0
        ? 'No college programs are mapped to this career yet.'
        : 'College programs retrieved.',
    ),
  );
});

/**
 * `GET /student/programs/{id}/colleges` — **"which colleges offer this program?"**
 *
 * Answered through `program_catalog` (migration 0018) rather than by matching strings: the program
 * named in the URL is one college's offering, its canonical entry is what it *is*, and the sibling
 * offerings of that entry are the answer.
 *
 * A program with no canonical entry answers 200 with an empty list and `canonical: null`, not a
 * 404. "We have not decided what this program canonically is" is a real state of the data and the
 * screen says so, rather than implying the program does not exist.
 */
studentRecommendationRoutes.get('/programs/:id/colleges', async (c) => {
  const service = new AcademicCatalogService(createDatabase(c.env.DB));
  const program = await service.findProgram(c.req.param('id'));

  if (program.programCatalogId === null) {
    return c.json(
      successEnvelope(
        { canonical: null, offerings: [] },
        'This program has not been matched to the shared program catalog yet.',
      ),
    );
  }

  const canonical = await service.findCanonicalProgram(program.programCatalogId);
  const rows = await service.collegesOfferingCanonical(canonical.id);

  return c.json(
    successEnvelope(
      {
        canonical: serializeCanonicalProgram(canonical),
        offerings: rows.map(({ college, program: offering }) => ({
          college: serializeCollege(college),
          program: serializeProgram(offering),
        })),
      },
      'Colleges retrieved.',
    ),
  );
});

// --- The recommendations chat assistant (migration 0019) --------------------------------------
//
// Three endpoints, all "mine": read the transcript, add a turn, clear it. Same reasoning as the
// rest of this router — there is no student id in any URL, so none of these can be made to mean
// somebody else's conversation by editing a parameter.

/** `GET /student/chat` — the transcript, or an empty one. Never a 404: "no messages" is a state. */
studentRecommendationRoutes.get('/chat', async (c) => {
  const user = requireUser(c);
  const db = createDatabase(c.env.DB);
  const service = await chatServiceForAsync(db, c);

  const conversation = await service.currentFor(user.id);
  const messages =
    conversation === null ? [] : await service.messagesFor(user.id, conversation.id);

  return c.json(
    successEnvelope(
      {
        conversation_id: conversation?.id ?? null,
        messages: messages.map(serializeChatMessage),
      },
      'Conversation retrieved.',
    ),
  );
});

/**
 * `POST /student/chat` — ask one question.
 *
 * Rate-limited on the same §41 counter as `explain`: 10 AI requests per minute per user, charged
 * atomically in an `AuthGuardDO` instance. It is the same limiter rather than a second one because
 * it guards the same thing — a hard daily neuron quota (§45) that both features draw from. Two
 * independent 10/min budgets would be a 20/min budget wearing a disguise.
 */
studentRecommendationRoutes.post('/chat', async (c) => {
  const user = requireUser(c);
  const input = await parseBody(c, askChatSchema);
  const db = createDatabase(c.env.DB);

  const guard = aiRateLimitGuard(c.env, user.id);
  const state = await guard.charge(AI_REQUEST_LIMIT, AI_REQUEST_WINDOW_SECONDS);

  if (state.locked) {
    throw ApiError.tooManyRequests({
      message: [`You are sending messages too quickly. Try again in ${state.retryAfterSeconds} seconds.`],
    });
  }

  // The student's own set, loaded server-side. It is never accepted from the client: a chat that
  // took its "context" from the request body would let anyone put any numbers in front of the
  // model and have it explain them as though they were that student's results.
  const recommendations = await new RecommendationService(db).latestFor(user.id);
  const chat = await chatServiceForAsync(db, c);
  const turn = await chat.ask(user.id, input.message, recommendations);

  return c.json(
    successEnvelope(
      {
        conversation_id: turn.conversation.id,
        question: serializeChatMessage(turn.question),
        answer: serializeChatMessage(turn.answer),
        failure: turn.failure,
      },
      turn.failure === null
        ? 'Answer generated.'
        : 'The assistant is unavailable right now — your computed results are shown instead.',
    ),
    201,
  );
});

/** `DELETE /student/chat` — the student's own transcript, cleared on their own say-so. */
studentRecommendationRoutes.delete('/chat', async (c) => {
  const db = createDatabase(c.env.DB);

  const chat = await chatServiceForAsync(db, c);

  await chat.clearFor(requireUser(c).id);

  return c.json(successEnvelope({ cleared: true }, 'Conversation cleared.'));
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
      set === null ? 'This student has no recommendations yet.' : 'Recommendations retrieved.',
    ),
  );
});

/**
 * `POST /counselor/students/{id}/recommendations/regenerate` (audit C4) — the staff-side recovery.
 *
 * The student-facing sibling above covers a student who notices the problem themselves. This covers
 * the case that actually happens in a school: the *counselor* is the one who spots that a student
 * who finished both instruments has no cards, and the student may not log in again for a week.
 *
 * The same policy as the GET beside it, run first and unchanged — a student outside this
 * counselor's classes answers **404**, not 403, so status codes cannot be used to enumerate student
 * ids. Regenerating is not a more privileged act than reading here: both are "this counselor's own
 * student", and `generateFor` derives everything from that student's own results and the shared
 * catalog. There is no input from the caller that could steer the outcome.
 */
counselorRecommendationRoutes.post(
  '/students/:studentId/recommendations/regenerate',
  async (c) => {
    const db = createDatabase(c.env.DB);
    const studentId = c.req.param('studentId');

    await authorizeStudentRecommendations(db, requireUser(c), studentId);

    // Keyed on the student, not the counselor — see `recommendationRegenerateGuard`. A counselor
    // working through a roster is not throttled after five students; a student cannot dodge their
    // own limit by asking staff to press it either.
    const state = await recommendationRegenerateGuard(c.env, studentId).charge(
      RECOMMENDATION_REGENERATE_LIMIT,
      RECOMMENDATION_REGENERATE_WINDOW_SECONDS,
    );

    if (state.locked) {
      throw ApiError.tooManyRequests({
        recommendations: [
          `This student's recommendations were rebuilt very recently. Try again in ${state.retryAfterSeconds} seconds.`,
        ],
      });
    }

    const service = new RecommendationService(db);

    await service.generateFor(studentId);

    const set = await service.latestFor(studentId);

    return c.json(
      successEnvelope(
        set === null ? null : serializeRecommendationSet(set),
        set === null
          ? 'Nothing could be generated — this student has not completed both RIASEC and SCCT.'
          : 'Recommendations rebuilt from this student’s latest results.',
      ),
    );
  },
);

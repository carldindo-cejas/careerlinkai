import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { createDatabase, type Database } from '@/db/client';
import type { AppEnv } from '@/env';
import {
  AI_REQUEST_LIMIT,
  AI_REQUEST_WINDOW_SECONDS,
  aiRateLimitGuard,
  RECOMMENDATION_REGENERATE_LIMIT,
  RECOMMENDATION_REGENERATE_WINDOW_SECONDS,
  recommendationRegenerateGuard,
  staffAuthGuard,
} from '@/lib/auth-guard';
import { STRANDS } from '@/db/enums';
import { aiVerifierEnabled } from '@/lib/config';
import { successEnvelope, ApiError } from '@/lib/envelope';
import { DEFAULT_FORMULA } from '@/lib/scoring-formula';
import { clientIp, parseBody } from '@/lib/validation';
import { requestGuidanceSync } from '@/jobs/ai-jobs';
import { authenticate, requireUser } from '@/middleware/authenticate';
import { ensurePasswordChanged } from '@/middleware/ensure-password-changed';
import { ensureRole } from '@/middleware/ensure-role';
import { AiPolicyService } from '@/modules/ai/ai-policy-service';
import { ChatService } from '@/modules/ai/chat-service';
import { ExplanationService } from '@/modules/ai/explanation-service';
import { aiGatewayFrom, retrievalFrom } from '@/modules/ai/factory';
import { askChatSchema, explainInChatSchema } from '@/modules/ai/schemas';
import { serializeChatMessage, serializeExplanation } from '@/modules/ai/serializers';
import { AcademicCatalogService } from '@/modules/catalog/academic-catalog-service';
import {
  serializeCanonicalProgram,
  serializeCareer,
  serializeCollege,
  serializeProgram,
} from '@/modules/catalog/serializers';
import { FormulaService, scoringFormulaSchema } from '@/modules/recommendation/formula-service';
import { RecommendationFreshnessService } from '@/modules/recommendation/freshness-service';
import { RecommendationService } from '@/modules/recommendation/recommendation-service';
import { serializeBrief } from '@/modules/recommendation/brief-serializer';
import {
  serializeFormula,
  serializeRecommendationSet,
  serializeStoredFormula,
} from '@/modules/recommendation/serializers';
import { StudentBriefService } from '@/modules/recommendation/student-brief-service';
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

  return new ChatService(
    db,
    aiGatewayFrom(db, c.env),
    retrievalFrom(db, c.env),
    policy,
    aiVerifierEnabled(c.env),
    // The catalog-index cache for Gate 2 (AI-COVERAGE-PLAN.md Phase 2). Optional: absent in the
    // suite, where every turn builds the index from D1.
    c.env.KV,
  );
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

/**
 * `GET /student/brief` — what the assistant knows about this student, and questions to start with
 * (AI-COVERAGE-PLAN.md Phase 4). Scoped by the bearer token; never by a URL id.
 */
studentRecommendationRoutes.get('/brief', async (c) => {
  const brief = await new StudentBriefService(createDatabase(c.env.DB)).briefFor(
    requireUser(c).id,
  );

  return c.json(successEnvelope(serializeBrief(brief), 'Student brief retrieved.'));
});

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
      /**
       * `failure` says which gate answered, not that the service broke, and the envelope message
       * used to report every one of them as *"The assistant is unavailable right now — your
       * computed results are shown instead."* Two claims, both usually false: nothing was
       * unavailable when Gate 0 declined an off-domain question or Gate 2 refused for want of
       * coverage, and neither reply is built from the student's computed results. The answer body
       * already explains itself in each case; the message says only which kind of answer it is.
       *
       * `null` covers both a grounded generation and a Gate 1 verbatim answer, which is correct —
       * an admin's own words are an answer, not a degraded one.
       */
      turn.failure === null
        ? 'Answer generated.'
        : turn.failure.startsWith('OUT_OF_SCOPE_')
          ? 'That question is outside what this assistant covers.'
          : turn.failure === 'NO_GROUNDING'
            ? 'Nothing in the school’s guidance materials covers that question.'
            : 'The assistant could not answer that — a standard reply was sent instead.',
    ),
    201,
  );
});

/**
 * `POST /student/chat/explain` — the recommendation page's "Explain more", answered in the chat
 * (2026-09-22) instead of inline on the card.
 *
 * The student's bubble reads "Explain more about <title>"; what actually runs is the §30
 * explanation pipeline for that one recommendation — the same call `/recommendations/:id/explain`
 * makes, with the same cache (an existing paragraph is free) and the same rate limit on a fresh
 * one. When there is no paragraph, the answer is the deterministic §27 reason, said as such.
 */
studentRecommendationRoutes.post('/chat/explain', async (c) => {
  const user = requireUser(c);
  const input = await parseBody(c, explainInChatSchema);
  const db = createDatabase(c.env.DB);
  const recommendationService = new RecommendationService(db);

  const recommendation = await recommendationService.findForStudent(
    user.id,
    input.recommendation_id,
  );

  if (recommendation === null) {
    throw ApiError.notFound('Recommendation not found.');
  }

  // Charged only when a model call may follow — an already-written paragraph costs nothing.
  if ((await recommendationService.explanationFor(recommendation.id)) === null) {
    const guard = aiRateLimitGuard(c.env, user.id);
    const state = await guard.charge(AI_REQUEST_LIMIT, AI_REQUEST_WINDOW_SECONDS);

    if (state.locked) {
      throw ApiError.tooManyRequests({
        message: [`Too many AI requests. Try again in ${state.retryAfterSeconds} seconds.`],
      });
    }
  }

  const policy = await new AiPolicyService(db).activeGlobal();
  const explainer = new ExplanationService(
    db,
    aiGatewayFrom(db, c.env),
    retrievalFrom(db, c.env),
    policy,
  );
  const target = await explainer.targetLabelFor(recommendation);
  const outcome = await explainer.explain(recommendation, user.id);

  const answer =
    outcome.explanation === null
      ? {
          text: `I don’t have more from the school’s guidance materials on ${target.label} yet, but here is how this match was calculated: ${outcome.fallbackReason}`,
          sources: [],
          kind: 'CANNED' as const,
        }
      : {
          text: outcome.explanation.explanationText,
          // No "From: …" line under this answer: the list of catalog entries was longer than the
          // paragraph. The sources stay on the explanation row, which is where review reads them.
          sources: [],
          kind: 'KNOWLEDGE' as const,
        };

  const recommendations = await recommendationService.latestFor(user.id);
  const chat = await chatServiceForAsync(db, c);
  const turn = await chat.recordTurn(
    user.id,
    recommendations,
    `Explain more about ${target.label}`,
    answer,
  );

  return c.json(
    successEnvelope(
      {
        conversation_id: turn.conversation.id,
        question: serializeChatMessage(turn.question),
        answer: serializeChatMessage(turn.answer),
        failure: outcome.failure ?? null,
      },
      outcome.explanation === null
        ? 'No AI explanation is available — the computed reason was sent instead.'
        : 'Explanation added to the conversation.',
    ),
    201,
  );
});

/**
 * `POST /student/chat/messages/:id/feedback` — *this answer was wrong* (Phase 4).
 *
 * The one signal in this system that leads straight to a fix. The answer's retrieved chunk ids are
 * already on its `ai_requests` row, so an admin can follow a flag to the passage that produced it
 * and correct or archive that entry — both one click away since Phase 1 made every entry editable.
 *
 * 404 for a message that is not this student's assistant message: an id alone is not authority,
 * and the same answer for "not yours" and "does not exist" is the same answer this module gives
 * everywhere else.
 */
studentRecommendationRoutes.post('/chat/messages/:id/feedback', async (c) => {
  const service = await chatServiceForAsync(createDatabase(c.env.DB), c);
  const flagged = await service.flagAnswer(requireUser(c).id, c.req.param('id'));

  if (!flagged) {
    throw ApiError.notFound('Message not found.');
  }

  return c.json(
    successEnvelope(
      { message_id: c.req.param('id'), feedback: 'DOWN' },
      'Thanks — a counselor will review this answer.',
    ),
  );
});

/**
 * `POST /student/chat/messages/:id/knowledge-request` — *please add this to the knowledge base*
 * (migration 0030).
 *
 * The other half of the honest refusal. When nothing covers a question the student is told so and
 * pointed at their counselor, and the question is logged as a gap — but until now that logging was
 * invisible to the person who asked, who had no way to say "yes, this one matters to me".
 *
 * Offered only on an answer the service marked `OFFERED`, which is only ever a no-coverage refusal.
 * 404 for anything else, for the same reason every other message route here does: an id alone is
 * not authority, and "not yours", "not real" and "not a refusal" get one answer.
 */
studentRecommendationRoutes.post('/chat/messages/:id/knowledge-request', async (c) => {
  const service = await chatServiceForAsync(createDatabase(c.env.DB), c);
  const requested = await service.requestKnowledge(requireUser(c).id, c.req.param('id'));

  if (!requested) {
    throw ApiError.notFound('Message not found.');
  }

  return c.json(
    successEnvelope(
      { message_id: c.req.param('id'), knowledge_request: 'REQUESTED' },
      'Thanks — your school has been asked to answer this.',
    ),
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

// --- /admin (role: admin only) ---------------------------------------------------------------

/**
 * **The match formula, as a screen** (2026-09-21).
 *
 * Every number §27 multiplies by used to be a constant in `lib/recommendation.ts`, changeable only
 * by an engineer with a deploy. These three routes make it a configuration a school owns: read it,
 * replace it, put it back. `FormulaService` holds the reasoning about storage and failure; this
 * holds the reasoning about the HTTP shape.
 *
 * ## What changing it does, and what it deliberately does not do
 *
 * A saved formula applies to **every score computed from then on** — a student finishing an
 * assessment, a "rebuild my recommendations", a counselor rebuilding one for a student, a
 * "what should I choose at this campus" lookup. It does **not** retroactively rewrite the rows of
 * students who already have a set. That is not laziness: rescoring every student in the deployment
 * inside one admin request would exceed a Worker's subrequest budget long before it finished (§45),
 * and a half-rescored cohort is a cohort where two students' scores are not comparable. The two
 * regenerate endpoints above are the supported catch-up, one student at a time, and the response
 * below reports how many students are currently holding a set computed under older weights so an
 * administrator can see the size of what they have just changed.
 */
export const adminRecommendationRoutes = new Hono<AppEnv>();

adminRecommendationRoutes.use('*', authenticate());
adminRecommendationRoutes.use('*', ensureRole('admin'));
adminRecommendationRoutes.use('*', ensurePasswordChanged());

const currentPassword = z.string().min(1, 'Your password is required.');

const saveFormulaSchema = scoringFormulaSchema.extend({ current_password: currentPassword });

const resetFormulaSchema = z.object({ current_password: currentPassword }).strict();

/**
 * Both writes re-score every recommendation generated afterwards, so an unattended admin session is
 * not enough to make them — the same re-authentication the account's own password change asks for.
 */
async function confirmAdminPassword(c: Context<AppEnv>, password: string): Promise<void> {
  const user = requireUser(c);
  const verified = await staffAuthGuard(c.env, user.email ?? user.id).verify(
    password,
    user.password,
  );

  if (!verified) {
    throw ApiError.validation({ current_password: ['Your password is incorrect.'] });
  }
}

/**
 * The formula, the shipped defaults, and who last changed it.
 *
 * The defaults travel **with** the current values rather than being duplicated in the client: the
 * "Restore defaults" button and the "changed from 60%" marker beside each field both need to know
 * what shipped, and a frontend copy of these numbers is a second source of truth that drifts on the
 * first release that tunes one.
 */
adminRecommendationRoutes.get('/recommendation-formula', async (c) => {
  const db = createDatabase(c.env.DB);
  const stored = await new FormulaService(db).stored();

  return c.json(
    successEnvelope(
      {
        ...serializeStoredFormula(stored),
        defaults: serializeFormula(DEFAULT_FORMULA),
        students_with_recommendations: await new RecommendationService(db).studentsWithSets(),
      },
      'Recommendation formula retrieved successfully.',
    ),
  );
});

/**
 * Replace it. `PUT`, and the whole object — the fields are not independent (see `FormulaService.set`).
 *
 * A guidance re-sync is requested afterwards because the corpus passage students are cited
 * ("a career match adds up three parts: … 60% … 30% … 10%") is generated from these very weights.
 * Leaving it stale would have the assistant quoting the old formula as fact while the engine used
 * the new one — the one failure mode of a configurable formula that a student would actually
 * notice. It is one queue message, it never throws, and the nightly cron asks again, so a dropped
 * message is a delay rather than a wrong answer that sticks.
 */
adminRecommendationRoutes.put('/recommendation-formula', async (c) => {
  const { current_password, ...input } = await parseBody(c, saveFormulaSchema);
  await confirmAdminPassword(c, current_password);

  const db = createDatabase(c.env.DB);
  const formula = await new FormulaService(db).set(input, requireUser(c), clientIp(c));
  // Every set generated before now is scored under the old weights (see RecommendationFreshnessService).
  await new RecommendationFreshnessService(db).touch(requireUser(c).id);

  await requestGuidanceSync(c.env);

  return c.json(
    successEnvelope(
      serializeFormula(formula),
      'Formula saved. It applies to every recommendation generated from now on.',
    ),
  );
});

/** Back to the shipped formula — the row is deleted, not overwritten. See `FormulaService.reset`. */
adminRecommendationRoutes.post('/recommendation-formula/reset', async (c) => {
  const { current_password } = await parseBody(c, resetFormulaSchema);
  await confirmAdminPassword(c, current_password);

  const db = createDatabase(c.env.DB);
  const formula = await new FormulaService(db).reset(requireUser(c), clientIp(c));
  // Every set generated before now is scored under the old weights (see RecommendationFreshnessService).
  await new RecommendationFreshnessService(db).touch(requireUser(c).id);

  await requestGuidanceSync(c.env);

  return c.json(successEnvelope(serializeFormula(formula), 'Formula restored to the defaults.'));
});

// --- Keeping sets current (2026-09-22) ------------------------------------------------------------
//
// Recommendations are snapshots. Since the catalog links (migration 0040) and the formula are both
// admin-editable, a snapshot can describe a configuration that no longer exists — so the admin
// Matching page shows how many are stale, recomputes them page by page, and previews what a given
// set of results would be shown today.

/** How many stale sets exist — the number the Matching page's "recompute" button works down. */
adminRecommendationRoutes.get('/recommendations/freshness', async (c) => {
  const summary = await new RecommendationFreshnessService(createDatabase(c.env.DB)).summary();

  return c.json(
    successEnvelope(
      {
        inputs_changed_at: summary.inputsChangedAt,
        students_with_sets: summary.studentsWithSets,
        stale_sets: summary.staleSets,
      },
      'Recommendation freshness retrieved successfully.',
    ),
  );
});

/**
 * Three students per request, and the ceiling is five: generation costs ~7 D1 calls a student on
 * top of ~5 shared, and the Free plan allows 50 per invocation (§45). The client calls again while
 * `remaining > 0` and the last page made progress. See `RecommendationService.recomputeStale`.
 */
const recomputeSchema = z
  .object({ limit: z.number().int().min(1).max(5).optional() })
  .strict();

export const RECOMPUTE_PAGE_SIZE = 3;

adminRecommendationRoutes.post('/recommendations/recompute', async (c) => {
  const input = await parseBody(c, recomputeSchema);
  const result = await new RecommendationService(createDatabase(c.env.DB)).recomputeStale(
    input.limit ?? RECOMPUTE_PAGE_SIZE,
  );

  return c.json(
    successEnvelope(
      result,
      result.regenerated === 0 && result.remaining === 0
        ? 'Every recommendation set is current.'
        : `Recomputed ${result.regenerated}; ${result.remaining} still to go.`,
    ),
  );
});

const score = z.number().min(0).max(100);

/**
 * A hypothetical student: six RIASEC scores, an SCCT confidence index, and the two profile fields
 * §27 reads. `formula` scores against an unsaved draft — the same shape `PUT /recommendation-formula`
 * validates, so a draft that previews is a draft that would save.
 */
const previewSchema = z
  .object({
    riasec: z.object({ R: score, I: score, A: score, S: score, E: score, C: score }).strict(),
    career_confidence: score,
    academic_average: z.number().min(60).max(100).nullable(),
    strand: z.enum(STRANDS).nullable(),
    formula: scoringFormulaSchema.optional(),
  })
  .strict();

adminRecommendationRoutes.post('/recommendations/preview', async (c) => {
  const input = await parseBody(c, previewSchema);
  const preview = await new RecommendationService(createDatabase(c.env.DB)).preview(
    {
      riasec: input.riasec,
      careerConfidenceIndex: input.career_confidence,
      academicAverage: input.academic_average,
      strand: input.strand,
    },
    input.formula,
  );

  return c.json(
    successEnvelope(
      {
        careers: preview.careers.map((match) => ({
          id: match.id,
          title: match.title,
          typical_riasec_code: match.typicalRiasecCode,
          match_score: match.matchScore,
          reason: match.reason,
          components: match.components,
        })),
        programs: preview.programs.map((match) => ({
          id: match.id,
          name: match.name,
          college_name: match.collegeName,
          match_score: match.matchScore,
          reason: match.reason,
          components: match.components,
          careers: match.careers,
        })),
      },
      'Preview computed. Nothing was saved.',
    ),
  );
});

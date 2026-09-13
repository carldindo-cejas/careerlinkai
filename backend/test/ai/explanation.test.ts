/* eslint-disable @typescript-eslint/require-await -- async-interface stubs have nothing to await */
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  aiRequests,
  careers,
  knowledgeChunks,
  knowledgeDocuments,
  recommendationExplanations,
  recommendations,
  type Recommendation,
} from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { AiGatewayService, type WorkersAiClient } from '@/modules/ai/ai-gateway-service';
import { ExplanationService } from '@/modules/ai/explanation-service';
import { RetrievalService } from '@/modules/ai/retrieval-service';
import type { VectorStore } from '@/modules/ai/vector-store';
import {
  answerAll,
  api,
  assignVersion,
  attachCareer,
  classWithStudent,
  createCareer,
  createCollege,
  createProgram,
  createStaffUser,
  db,
  enrolStudents,
  joinClass,
  login,
  seedInstruments,
  type StaffUserFixture,
} from '../helpers';

/**
 * The §30 RAG explanation pipeline — the first module in this project with **zero local
 * platform fidelity**: Workers AI and Vectorize are exactly the two bindings the test
 * config deletes. So the split is strict (Phase 4.5 Step 3, and the top-of-PROGRESS
 * lesson):
 *
 *   * The **pipeline** is tested against a stubbed gateway and vector store — grounding,
 *     guardrails, policy injection, the quota taxonomy, persistence.
 *   * The **HTTP surface** is tested with the bindings genuinely absent, which exercises
 *     the one behaviour that must hold on the worst day: the student still gets a 200 and
 *     the deterministic reason (§29 — the AI paragraph is an enhancement, not a dependency).
 *
 * What no test here can prove — real generation latency vs the §6 8-second budget, and
 * Vectorize's async indexing lag — is measured on staging (§57 5a) and recorded in
 * PROGRESS.md.
 */

let admin: StaffUserFixture;
let counselorToken: string;
let studentToken: string;
let classRoomId: string;
let joinCode: string;
/** A career recommendation belonging to the fully-assessed student. */
let recommendation: Recommendation;

beforeAll(async () => {
  admin = await createStaffUser({ role: 'admin' });
  const adminToken = await login(admin);
  const counselor = await createStaffUser({ role: 'counselor' });
  counselorToken = await login(counselor);

  const college = await createCollege(adminToken);
  const program = await createProgram(adminToken, college.id);
  const career = await createCareer(adminToken, { typical_riasec_code: 'IEC' });
  await attachCareer(adminToken, program.id, career.id);

  const seeded = await seedInstruments(admin);

  const fixture = await classWithStudent(counselorToken);
  studentToken = fixture.studentToken;
  classRoomId = fixture.classRoom.id;
  joinCode = fixture.classRoom.join_code;

  for (const versionId of [seeded.riasecVersionId!, seeded.scctVersionId!]) {
    const assignment = await assignVersion(counselorToken, classRoomId, versionId);
    const start = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });
    const attempt = await api('GET', `/student/attempts/${start.body.data.id}`, {
      token: studentToken,
    });

    await answerAll(studentToken, attempt.body.data, () => 3);
    await api('POST', `/student/attempts/${start.body.data.id}/submit`, { token: studentToken });
  }

  const set = await api('GET', '/student/recommendations', { token: studentToken });
  const recommendationId = set.body.data.careers[0].id as string;

  const [row] = await db()
    .select()
    .from(recommendations)
    .where(eq(recommendations.id, recommendationId));

  recommendation = row!;
});

// --- stub plumbing ---------------------------------------------------------------------

/** A knowledge chunk already ingested and embedded, for the stub store to return. */
async function seedChunk(content: string): Promise<string> {
  const documentId = uuid();
  const chunkId = uuid();
  const timestamp = now();

  await db().insert(knowledgeDocuments).values({
    id: documentId,
    uploadedBy: admin.id,
    title: 'seeded.pdf',
    fileName: 'seeded.pdf',
    sourceType: 'pdf',
    storagePath: `knowledge/${documentId}/seeded.pdf`,
    processingStatus: 'COMPLETED',
    visibility: 'GLOBAL',
    archivedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  await db().insert(knowledgeChunks).values({
    id: chunkId,
    documentId,
    chunkNumber: 1,
    content,
    vectorId: chunkId,
    tokenCount: 50,
    createdAt: timestamp,
  });

  return chunkId;
}

function pipeline(options: {
  responses: string[];
  matches: { id: string; score: number }[];
  policy?: { instructions: string | null; restrictions: string | null } | null;
}) {
  const database = db();
  const prompts: { system: string; user: string }[] = [];
  let generationCalls = 0;

  const client: WorkersAiClient = {
    run: async (_model, inputs) => {
      if ('text' in inputs) {
        return { data: (inputs.text as string[]).map(() => [0.1, 0.2]) };
      }

      const messages = inputs.messages as { role: string; content: string }[];

      prompts.push({ system: messages[0]!.content, user: messages[1]!.content });

      const response = options.responses[Math.min(generationCalls, options.responses.length - 1)]!;

      generationCalls += 1;

      return { response, usage: { total_tokens: 30 } };
    },
  };

  const filters: (Record<string, unknown> | undefined)[] = [];

  const vectors: VectorStore = {
    upsert: async () => undefined,
    query: async (_vector, queryOptions) => {
      filters.push(queryOptions.filter);

      return { matches: options.matches };
    },
    deleteByIds: async () => undefined,
  };

  const gateway = new AiGatewayService(database, client, { text: 'stub-text', embedding: 'stub-embed' });
  const service = new ExplanationService(
    database,
    gateway,
    new RetrievalService(database, gateway, vectors),
    options.policy ?? null,
  );

  return {
    service,
    prompts,
    filters,
    generationCalls: () => generationCalls,
  };
}

/**
 * Empty the corpus.
 *
 * Needed since AiNormalisation Phase 2 made retrieval **hybrid**: the keyword half searches D1
 * directly, so a chunk this file seeded three tests ago is genuinely found by a query built from
 * a career called "Software Engineer" — which is the feature working, not a leak. A test asserting
 * *zero retrieval* therefore has to arrange zero retrievable content, rather than relying on a
 * vector stub that returns nothing while a real FTS index sits behind it.
 */
async function clearCorpus(): Promise<void> {
  await db().delete(knowledgeChunks);
}

async function clearExplanationFor(recommendationId: string): Promise<void> {
  await db()
    .delete(recommendationExplanations)
    .where(eq(recommendationExplanations.recommendationId, recommendationId));
}

// --- the pipeline against stubs ----------------------------------------------------------

describe('the §30 pipeline (stubbed model + vector store)', () => {
  it('generates a grounded explanation, persists it, and logs the chunk ids it was shown', async () => {
    await clearExplanationFor(recommendation.id);

    const chunkId = await seedChunk(
      'Software engineering suits Investigative students who enjoy structured problem solving.',
    );
    // Cites the passage it was given, and asserts nothing the passage and the student's own
    // computed results do not already say — which is what the Phase 3 contract requires of every
    // answer that ships.
    const grounded =
      'Because your Investigative interest is strong, careers like this fit the structured problem solving described in our guidance materials [1].';
    const { service } = pipeline({
      responses: [grounded],
      matches: [{ id: chunkId, score: 0.91 }],
    });

    const outcome = await service.explain(recommendation, null);

    expect(outcome.explanation).not.toBeNull();
    expect(outcome.explanation!.explanationText).toBe(grounded);
    expect(outcome.fallbackReason).toBe(recommendation.reason);

    // Persisted in the Recommendation module's table (§13.6 — the structural AI boundary).
    const [row] = await db()
      .select()
      .from(recommendationExplanations)
      .where(eq(recommendationExplanations.recommendationId, recommendation.id));

    expect(row!.explanationText).toBe(grounded);

    // §13.7 provenance: the SUCCESS row names the chunks the model was shown.
    const requests = await db().select().from(aiRequests).where(eq(aiRequests.status, 'SUCCESS'));
    const mine = requests.find(
      (request) => (request.inputContext as any)?.recommendation_id === recommendation.id,
    );

    expect(mine).toBeDefined();
    expect((mine!.inputContext as any).chunk_ids).toContain(chunkId);
  });

  it('returns the existing explanation without a model call — §20\'s "if not already generated"', async () => {
    // The previous test persisted one. A stub that would fail any generation proves no
    // generation happens.
    const { service, generationCalls } = pipeline({ responses: ['unused'], matches: [] });

    const outcome = await service.explain(recommendation, null);

    expect(outcome.explanation).not.toBeNull();
    expect(generationCalls()).toBe(0);
  });

  it('injects the active AI policy text into the system prompt (§32) and the student data into the user prompt', async () => {
    await clearExplanationFor(recommendation.id);

    const chunkId = await seedChunk('Guidance content about careers.');
    const { service, prompts } = pipeline({
      responses: ['A perfectly reasonable grounded explanation for the student.'],
      matches: [{ id: chunkId, score: 0.9 }],
      policy: {
        instructions: 'Always mention that recommendations are not final decisions.',
        restrictions: 'Never reference internal-only documents.',
      },
    });

    await service.explain(recommendation, null);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.system).toContain('Always mention that recommendations are not final decisions.');
    expect(prompts[0]!.system).toContain('Never reference internal-only documents.');
    // §32/§40: named, whitelisted fields only — the deterministic score and reason travel in.
    expect(prompts[0]!.user).toContain(`Match score (computed deterministically): ${recommendation.matchScore}`);
    expect(prompts[0]!.user).toContain(recommendation.reason);
    expect(prompts[0]!.user).toContain('Guidance content about careers.');
  });

  it('refuses to generate ungrounded: zero retrieval → FAILED row, no model call, deterministic fallback (§30)', async () => {
    await clearExplanationFor(recommendation.id);
    await clearCorpus();

    const { service, generationCalls } = pipeline({
      responses: ['should never be generated'],
      // A match below the similarity floor is not grounding.
      matches: [{ id: uuid(), score: 0.4 }],
    });

    const outcome = await service.explain(recommendation, null);

    expect(outcome.explanation).toBeNull();
    expect(outcome.failure).toBe('NO_GROUNDING');
    expect(outcome.fallbackReason).toBe(recommendation.reason);
    expect(generationCalls()).toBe(0);

    const failed = await db().select().from(aiRequests).where(eq(aiRequests.status, 'FAILED'));
    const mine = failed.find(
      (request) =>
        (request.inputContext as any)?.recommendation_id === recommendation.id &&
        String(request.failureReason).includes('similarity threshold'),
    );

    expect(mine).toBeDefined();
  });

  /**
   * AiNormalisation D4. The query used to be a synthetic sentence — *"… college program for a
   * student whose strongest interests are Social, Investigative"* — that no guidance document
   * is written anything like, so it matched the corpus on little but the target's name. The
   * target's own catalog description is written in the register of the material being searched.
   * The student's interests did not disappear: they are in the prompt, which is where context
   * about *who is being answered* belongs, as distinct from what to search for.
   */
  it('retrieves on the target’s own title and description, not a synthetic interest sentence', async () => {
    await clearExplanationFor(recommendation.id);
    // The assertion is on the query that was *issued*, which is only logged when retrieval comes
    // back empty — so the corpus has to be empty for the skip row to exist at all.
    await clearCorpus();

    const description = 'Designs, builds and maintains software systems for hospitals and clinics.';

    await db()
      .update(careers)
      .set({ description })
      .where(eq(careers.id, recommendation.targetCareerId!));

    const { service } = pipeline({
      responses: ['unused'],
      matches: [{ id: uuid(), score: 0.1 }],
    });

    await service.explain(recommendation, null);

    const failed = await db().select().from(aiRequests).where(eq(aiRequests.status, 'FAILED'));
    const mine = failed.find(
      (request) => (request.inputContext as any)?.retrieval_query?.includes(description) === true,
    );

    expect(mine).toBeDefined();
    expect((mine!.inputContext as any).retrieval_query).not.toContain('strongest interests');
  });

  /**
   * **Two-pass retrieval** (AiNormalisation Phase 2).
   *
   * One pass over the whole corpus ranks everything on similarity alone, so a well-written
   * general passage about "choosing a healthcare career" can outrank the catalog entry for the
   * exact career being explained — and the paragraph the student reads then says nothing specific
   * about their own match. The first pass is filtered to this target's `entity_id`, so the entry
   * *about this career* is in the context by construction rather than by winning a contest.
   *
   * Asserted at the seam that proves it: the filter reaching Vectorize. The second call carries
   * none, because the remaining slots are for the general theory chunks that connect those facts
   * to a RIASEC profile — an explanation built only from catalog facts reads like a brochure.
   */
  it('retrieves this target\u2019s own chunks first, then general material for the rest', async () => {
    await clearExplanationFor(recommendation.id);

    const chunkId = await seedChunk('Guidance material about structured problem solving.');
    const { service, filters } = pipeline({
      responses: [
        'Your Investigative interest fits the structured problem solving this field is built on, according to our guidance materials.',
      ],
      matches: [{ id: chunkId, score: 0.8 }],
    });

    await service.explain(recommendation, null);

    expect(filters).toHaveLength(2);
    expect(filters[0]).toEqual({
      entity_type: 'career',
      entity_id: recommendation.targetCareerId,
    });
    expect(filters[1]).toBeUndefined();
  });

  it('regenerates once on an absolute claim, then falls back rather than showing it (§34)', async () => {
    await clearExplanationFor(recommendation.id);

    const chunkId = await seedChunk('More guidance content.');
    const { service, generationCalls } = pipeline({
      // Both attempts trip the filter — the student must never see either.
      responses: ['You are guaranteed to become a software engineer, it is 100% certain.'],
      matches: [{ id: chunkId, score: 0.88 }],
    });

    const outcome = await service.explain(recommendation, null);

    expect(generationCalls()).toBe(2); // one regeneration, not an endless loop
    expect(outcome.explanation).toBeNull();
    expect(outcome.failure).toBe('FAILED_VALIDATION');
    expect(outcome.fallbackReason).toBe(recommendation.reason);
  });

  it('treats quota exhaustion as a model failure with the deterministic fallback — never a retry (§30 v1.5)', async () => {
    await clearExplanationFor(recommendation.id);

    const chunkId = await seedChunk('Yet more guidance content.');
    const database = db();
    let calls = 0;

    const client: WorkersAiClient = {
      run: async (_model, inputs) => {
        if ('text' in inputs) {
          return { data: (inputs.text as string[]).map(() => [0.1]) };
        }

        calls += 1;
        throw new Error('You have exceeded the daily neuron quota for Workers AI');
      },
    };

    const gateway = new AiGatewayService(database, client, { text: 't', embedding: 'e' });
    const vectors: VectorStore = {
      upsert: async () => undefined,
      query: async () => ({ matches: [{ id: chunkId, score: 0.9 }] }),
      deleteByIds: async () => undefined,
    };
    const service = new ExplanationService(
      database,
      gateway,
      new RetrievalService(database, gateway, vectors),
      null,
    );

    const outcome = await service.explain(recommendation, null);

    expect(calls).toBe(1);
    expect(outcome.explanation).toBeNull();
    expect(outcome.failure).toBe('QUOTA_EXHAUSTED');
    expect(outcome.fallbackReason).toBe(recommendation.reason);
  });
});

// --- the HTTP surface, with the bindings genuinely absent --------------------------------

describe('POST /student/recommendations/{id}/explain', () => {
  it('answers 200 with the deterministic fallback when the platform AI is unavailable', async () => {
    await clearExplanationFor(recommendation.id);

    const response = await api('POST', `/student/recommendations/${recommendation.id}/explain`, {
      token: studentToken,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.explanation).toBeNull();
    expect(response.body.data.fallback_reason).toBe(recommendation.reason);
    expect(response.body.data.failure).not.toBeNull();
  });

  it('serves an existing explanation without charging the AI limit', async () => {
    await clearExplanationFor(recommendation.id);

    // Persist one through the pipeline, then fetch it over HTTP.
    const chunkId = await seedChunk('Content for the cached-path test.');
    const { service } = pipeline({
      responses: ['A cached explanation that the endpoint should simply return [1].'],
      matches: [{ id: chunkId, score: 0.9 }],
    });

    await service.explain(recommendation, null);

    const response = await api('POST', `/student/recommendations/${recommendation.id}/explain`, {
      token: studentToken,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.explanation).toMatchObject({
      recommendation_id: recommendation.id,
      explanation_text: 'A cached explanation that the endpoint should simply return [1].',
    });
    expect(response.body.data.failure).toBeNull();
  });

  it("404s another student's recommendation and an unknown id identically", async () => {
    // A classmate with no assessment history: cheap to create, and exactly the caller who
    // must not learn whether the id was real. `confirm` answers with the WHOLE roster, so
    // the new student is found by username — `roster[0]` is Juan, and joining as Juan would
    // revoke the fixture's own token (§38: a join replaces the prior session).
    const roster = await enrolStudents(counselorToken, classRoomId, ['Other Student']);
    const other = roster.find((row: any) => row.username === 'other.student')!;
    const otherToken = await joinClass(joinCode, other.username);

    const foreign = await api('POST', `/student/recommendations/${recommendation.id}/explain`, {
      token: otherToken,
    });
    const unknown = await api('POST', `/student/recommendations/${uuid()}/explain`, {
      token: otherToken,
    });

    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(foreign.body).toEqual(unknown.body);
  });

  it('is rate-limited to 10 AI requests per minute per user (§41) — runs last, it locks the student out', async () => {
    await clearExplanationFor(recommendation.id);

    let limited = 0;

    // The fallback path still counts as an AI request — the limiter guards attempts, and
    // charges land on the student's AuthGuardDO instance.
    for (let i = 0; i < 12; i += 1) {
      const response = await api('POST', `/student/recommendations/${recommendation.id}/explain`, {
        token: studentToken,
      });

      if (response.status === 429) {
        limited += 1;
      }
    }

    expect(limited).toBeGreaterThan(0);
  });
});

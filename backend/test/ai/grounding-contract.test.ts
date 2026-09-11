/* eslint-disable @typescript-eslint/require-await -- async-interface stubs have nothing to await */
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import { aiRequests, chatConversations, knowledgeChunks, knowledgeDocuments } from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { AiGatewayService, type WorkersAiClient } from '@/modules/ai/ai-gateway-service';
import { ChatService } from '@/modules/ai/chat-service';
import { RetrievalService } from '@/modules/ai/retrieval-service';
import type { VectorStore } from '@/modules/ai/vector-store';
import { RecommendationService } from '@/modules/recommendation/recommendation-service';
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
  login,
  seedInstruments,
  type StaffUserFixture,
} from '../helpers';

/**
 * **The grounding contract, end to end** (AiNormalisation Phase 3).
 *
 * The honest framing from the plan: you cannot make an 8B model stop hallucinating. What you can
 * guarantee is that **no ungrounded claim reaches a student as fact** — and that is an
 * architecture, not a prompt. This file is the assertion that the architecture holds, using a
 * stubbed model that says exactly the wrong things on purpose.
 *
 * Each test drives one gate: an admin's answer returned verbatim with no model call, a question
 * nothing covers refused rather than answered, an invented figure caught after the model produced
 * it, and the sources a student is shown under what survives.
 */

let admin: StaffUserFixture;
let studentId: string;
let studentToken: string;

beforeAll(async () => {
  admin = await createStaffUser({ role: 'admin' });
  const adminToken = await login(admin);
  const counselor = await createStaffUser({ role: 'counselor' });
  const counselorToken = await login(counselor);

  const college = await createCollege(adminToken);
  const program = await createProgram(adminToken, college.id);
  const career = await createCareer(adminToken, { typical_riasec_code: 'IEC' });

  await attachCareer(adminToken, program.id, career.id);

  const seeded = await seedInstruments(admin);
  const fixture = await classWithStudent(counselorToken);

  studentToken = fixture.studentToken;

  for (const versionId of [seeded.riasecVersionId!, seeded.scctVersionId!]) {
    const assignment = await assignVersion(counselorToken, fixture.classRoom.id, versionId);
    const start = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });
    const attempt = await api('GET', `/student/attempts/${start.body.data.id}`, {
      token: studentToken,
    });

    await answerAll(studentToken, attempt.body.data, () => 3);
    await api('POST', `/student/attempts/${start.body.data.id}/submit`, { token: studentToken });
  }

  studentId = fixture.student.student_id ?? fixture.student.id;
});

async function seedEntry(
  title: string,
  content: string,
  sourceType: 'text' | 'qa' = 'text',
): Promise<string> {
  const documentId = uuid();
  const chunkId = uuid();
  const timestamp = now();

  await db().insert(knowledgeDocuments).values({
    id: documentId,
    uploadedBy: admin.id,
    title,
    fileName: title,
    sourceType,
    storagePath: null,
    entityType: null,
    entityId: null,
    contentHash: null,
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
    sourceType,
    entityType: null,
    entityId: null,
    createdAt: timestamp,
  });

  return chunkId;
}

function pipeline(options: { responses?: string[]; matches?: { id: string; score: number }[] }) {
  const database = db();
  let generationCalls = 0;

  const client: WorkersAiClient = {
    run: async (model, inputs) => {
      if ('text' in inputs) {
        return { data: (inputs.text as string[]).map(() => [0.1, 0.2]) };
      }

      if (model === 'stub-rerank') {
        return {
          response: (inputs.contexts as unknown[]).map((_context, index) => ({
            id: index,
            score: 1 - index / 100,
          })),
        };
      }

      const response = options.responses?.[Math.min(generationCalls, (options.responses.length || 1) - 1)];

      generationCalls += 1;

      return { response: response ?? 'unused', usage: { total_tokens: 10 } };
    },
  };

  const vectors: VectorStore = {
    upsert: async () => undefined,
    query: async () => ({ matches: options.matches ?? [] }),
    deleteByIds: async () => undefined,
  };

  const gateway = new AiGatewayService(database, client, {
    text: 'stub-text',
    embedding: 'stub-embed',
    rerank: 'stub-rerank',
  });

  return {
    service: new ChatService(
      database,
      gateway,
      new RetrievalService(database, gateway, vectors),
      null,
    ),
    generationCalls: () => generationCalls,
  };
}

async function currentSet() {
  return new RecommendationService(db()).latestFor(studentId);
}

async function clearConversation(): Promise<void> {
  await db().delete(chatConversations).where(eq(chatConversations.studentId, studentId));
}

describe('Gate 1 — an admin already answered this', () => {
  /**
   * The gate the whole flywheel turns on. The questions students repeat most are the ones that
   * never reach the model at all: zero neurons, zero hallucination, and the admin's words reach
   * the student unaltered rather than paraphrased by an 8B model that might drop a digit.
   */
  it('returns the admin’s answer verbatim, with no model call', async () => {
    await clearConversation();
    await seedEntry(
      'Tuition FAQ',
      'Q: How much is tuition for BS Nursing?\nA: Tuition for BS Nursing is PHP 25,000 per semester for AY 2026-2027.',
      'qa',
    );

    const { service, generationCalls } = pipeline({ responses: ['should never be generated'] });
    const turn = await service.ask(studentId, 'how much is tuition for bs nursing???', await currentSet());

    expect(turn.answer.content).toBe(
      'Tuition for BS Nursing is PHP 25,000 per semester for AY 2026-2027.',
    );
    expect(generationCalls()).toBe(0);
    expect(turn.answer.sources).toEqual(['Tuition FAQ']);
    // Not a generation, so no `ai_requests` row is pointed at — §29's rule that a non-model answer
    // must never be recorded as model output.
    expect(turn.answer.aiRequestId).toBeNull();
  });

  it('does not fire on a different question that merely shares words', async () => {
    await clearConversation();
    await seedEntry(
      'Enrolment FAQ',
      'Q: When does enrolment close?\nA: Enrolment closes on 30 June.',
      'qa',
    );

    const { service, generationCalls } = pipeline({
      responses: ['A generated answer about enrolment [1].'],
      matches: [],
    });

    await service.ask(studentId, 'When does enrolment open for my top program?', await currentSet());

    // Gate 1 is exact-after-normalisation on purpose: it hands back an admin's words with no model
    // in the loop to notice the question was actually a different one.
    expect(generationCalls()).toBe(1);
  });
});

describe('Gate 0 — questions this assistant declines', () => {
  it('declines homework and points at a person, without calling the model', async () => {
    await clearConversation();

    const { service, generationCalls } = pipeline({ responses: ['x = 4'] });
    const turn = await service.ask(studentId, 'solve this equation for x: 2x + 3 = 11', await currentSet());

    expect(turn.failure).toBe('OUT_OF_SCOPE_HOMEWORK');
    expect(turn.answer.content).toMatch(/counselor/i);
    expect(generationCalls()).toBe(0);
  });
});

describe('Gate 4 — refusing rather than inventing', () => {
  /**
   * D7, narrowed. With nothing retrieved and a question the student's own results cannot answer,
   * the only thing between them and an invented figure used to be a prompt rule an 8B model obeys
   * perhaps four times in five. Now it does not reach the model at all.
   */
  it('refuses a question nothing covers, and logs it as the gap it is', async () => {
    await clearConversation();

    const { service, generationCalls } = pipeline({
      responses: ['Tuition is about PHP 40,000 per semester.'],
      matches: [],
    });

    const turn = await service.ask(studentId, 'how much is the dormitory fee?', await currentSet());

    expect(turn.failure).toBe('NO_GROUNDING');
    expect(generationCalls()).toBe(0);
    expect(turn.answer.content).toMatch(/guidance counselor/i);
    // NULL rather than []: a refusal has nothing to name, and the absence of a source line is
    // itself the signal that this is not a sourced fact.
    expect(turn.answer.sources).toBeNull();
    // Migration 0030: the refusal is marked as one, so the panel can offer "Request to add to
    // knowledge" on a transcript reloaded next week rather than matching the reply text.
    expect(turn.answer.knowledgeRequest).toBe('OFFERED');
  });

  /**
   * The refusal's second half (migration 0030).
   *
   * The question was always logged — that is the SKIPPED `ai_requests` row above — and the student
   * had no way to know it. Pressing the button puts their own voice on the backlog, which is what
   * ranks it above the questions the retrieval merely missed.
   */
  it('lets the student ask for a refused question to be answered', async () => {
    await clearConversation();

    const { service } = pipeline({ responses: ['Tuition is about PHP 40,000 per semester.'], matches: [] });
    const turn = await service.ask(studentId, 'how much is the dormitory fee?', await currentSet());

    expect(await service.requestKnowledge(studentId, turn.answer.id)).toBe(true);

    const [answer] = (await service.messagesFor(studentId, turn.conversation.id)).filter(
      (message) => message.role === 'assistant',
    );

    expect(answer!.knowledgeRequest).toBe('REQUESTED');

    // Idempotent, like the wrong-answer flag: pressing twice is the same state, not an error.
    expect(await service.requestKnowledge(studentId, turn.answer.id)).toBe(true);
  });

  /**
   * The state the transition starts from *is* the authorisation. A generated answer, a Gate 1
   * answer and an off-domain redirect all carry NULL, so none of them can be nominated — there is
   * nothing for an admin to write in any of those cases, and a backlog padded with them is a
   * backlog nobody works.
   */
  it('refuses to file an answer that was not a coverage gap', async () => {
    await clearConversation();

    const { service } = pipeline({ responses: ['Your strongest match is the first one on your list.'] });
    const turn = await service.ask(studentId, 'which of my matches scored highest?', await currentSet());

    expect(turn.answer.knowledgeRequest).toBeNull();
    expect(await service.requestKnowledge(studentId, turn.answer.id)).toBe(false);
  });

  it('still answers a question the student’s own results cover', async () => {
    await clearConversation();

    const { service } = pipeline({
      responses: ['Your strongest match is the first one on your list.'],
      matches: [],
    });

    const turn = await service.ask(studentId, 'which of my matches scored highest?', await currentSet());

    expect(turn.failure).toBeNull();
  });
});

describe('Gate 3 — cite or refuse, and the claim check', () => {
  it('discards an answer that used the passages without citing them', async () => {
    await clearConversation();

    const chunkId = await seedEntry(
      'Admissions Handbook',
      'Applicants to BS Nursing submit Form 138 and two ID photos before 30 April.',
    );

    const { service } = pipeline({
      responses: ['Applicants submit Form 138 and two ID photos before 30 April.'],
      matches: [{ id: chunkId, score: 0.8 }],
    });

    const turn = await service.ask(studentId, 'what do I submit for nursing admission?', await currentSet());

    // True, as it happens — and discarded anyway. An answer with no marker was written from
    // somewhere other than the passages supplied, and that is not distinguishable from invention
    // by reading it.
    expect(turn.failure).toBe('NO_CITATION');

    /**
     * What the student is told changed on 2026-09-05, and this assertion is the record of why.
     *
     * It used to be the deterministic reply, which opens *"the assistant is unavailable at the
     * moment"* and closes *"try again in a moment"*. Measured against production, that was simply
     * untrue: the assistant was working, the passages just did not support an answer, and a retry
     * produces the same refusal. Telling a student to retry something that cannot succeed is the
     * one failure this file exists to prevent, committed by the error message rather than by the
     * model.
     *
     * The refusal now names the gap and routes to a person, and it is logged as a coverage
     * failure so it reaches the admin's unanswered-questions report.
     */
    expect(turn.answer.content).toContain('guidance counselor can help');
    expect(turn.answer.content).not.toContain('Try again in a moment');
  });

  /**
   * The half of that fix which is not visible to the student, and matters more.
   *
   * Phase 4's unanswered-questions report reads `ai_requests` rows whose status is FAILED and
   * whose reason starts `SKIPPED`. A chat rejection used to write neither: `generate()` had
   * already recorded SUCCESS, the rejection happened afterwards in the service, and nothing
   * recorded it. So the most common failure a student can actually hit was invisible to the one
   * screen built to surface it, and the admin's weekly routine would have shown an empty list on
   * exactly the weeks it mattered.
   *
   * A rejection is a coverage gap by definition — the passages did not support an answer — which
   * is precisely the backlog item an admin closes with one Q&A entry.
   */
  it('records a rejected answer as a coverage failure the admin report can see', async () => {
    await clearConversation();

    const chunkId = await seedEntry(
      'Admissions Handbook',
      'Applicants to BS Nursing submit Form 138 and two ID photos before 30 April.',
    );

    const { service } = pipeline({
      responses: ['Applicants submit Form 138 and two ID photos before 30 April.'],
      matches: [{ id: chunkId, score: 0.8 }],
    });

    // Counted as a delta across the one call: earlier cases in this file leave their own skipped
    // rows behind, so an absolute count would assert the fixture's history rather than this fix.
    const coverageFailures = async () =>
      (await db().select().from(aiRequests)).filter(
        (row) =>
          row.status === 'FAILED' &&
          (row.failureReason ?? '').startsWith('SKIPPED') &&
          (row.failureReason ?? '').includes('NO_CITATION'),
      ).length;

    const before = await coverageFailures();

    await service.ask(studentId, 'what do I submit for nursing admission?', await currentSet());

    expect(await coverageFailures()).toBe(before + 1);
  });

  /**
   * The headline case: the invented tuition fee. The model cites correctly and fabricates inside
   * the cited sentence, which is a thing models do — so the marker is checked and then ignored,
   * and the figure is compared against the material.
   */
  it('discards a figure that appears in no passage, even when correctly cited', async () => {
    await clearConversation();

    const chunkId = await seedEntry(
      'Fees Circular',
      'Tuition for BS Nursing is PHP 25,000 per semester.',
    );

    const { service } = pipeline({
      responses: ['Tuition for that program is about PHP 48,500 per semester [1].'],
      matches: [{ id: chunkId, score: 0.8 }],
    });

    const turn = await service.ask(studentId, 'what is the tuition for nursing?', await currentSet());

    expect(turn.failure).toBe('UNSUPPORTED_CLAIM');
    expect(turn.answer.content).not.toContain('48,500');
  });

  it('names the entries behind an answer that survives every check', async () => {
    await clearConversation();

    const chunkId = await seedEntry(
      '2026 Admissions Handbook',
      'BS Nursing applicants must submit Form 138 before the deadline.',
    );

    const { service } = pipeline({
      responses: ['You need to submit Form 138 before the deadline [1].'],
      matches: [{ id: chunkId, score: 0.8 }],
    });

    const turn = await service.ask(studentId, 'what do I need to submit for nursing?', await currentSet());

    expect(turn.failure).toBeNull();
    // What a student sees under the answer. An answer whose source they can see is one they can
    // judge — and an answer with no source is visibly not a fact.
    expect(turn.answer.sources).toEqual(['2026 Admissions Handbook']);
  });
});

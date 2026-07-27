/* eslint-disable @typescript-eslint/require-await -- async-interface stubs have nothing to await */
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import { chatConversations, knowledgeChunks, knowledgeDocuments } from '@/db/schema';
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
 * The recommendations chat assistant (migration 0019).
 *
 * Split the same way `explanation.test.ts` is split, and for the same reason — Workers AI and
 * Vectorize are the two bindings with **no local emulation at all**, and the test config deletes
 * them:
 *
 *   * The **service** is tested against a stubbed gateway and vector store: what reaches the
 *     prompt, what is persisted, what happens when the model misbehaves.
 *   * The **HTTP surface** is tested with the bindings genuinely absent, which exercises the one
 *     behaviour that has to hold on the worst day — the student still gets a 201 and a true answer
 *     built from their own computed results (§29: the AI is an enhancement, not a dependency).
 */

let admin: StaffUserFixture;
let studentToken: string;
let studentId: string;

beforeAll(async () => {
  admin = await createStaffUser({ role: 'admin' });
  const adminToken = await login(admin);
  const counselorToken = await login(await createStaffUser({ role: 'counselor' }));

  const college = await createCollege(adminToken, { name: 'Chat University' });
  const program = await createProgram(adminToken, college.id);
  const career = await createCareer(adminToken, { typical_riasec_code: 'IEC' });
  await attachCareer(adminToken, program.id, career.id);

  const seeded = await seedInstruments(admin);
  const fixture = await classWithStudent(counselorToken);

  studentToken = fixture.studentToken;
  studentId = fixture.student.student_id ?? fixture.student.id;

  // Both instruments, so the student has a real recommendation set to be asked about.
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
});

// --- stub plumbing ---------------------------------------------------------------------

async function seedChunk(content: string): Promise<string> {
  const documentId = uuid();
  const chunkId = uuid();
  const timestamp = now();

  await db().insert(knowledgeDocuments).values({
    id: documentId,
    uploadedBy: admin.id,
    fileName: 'guidance.pdf',
    fileType: 'pdf',
    storagePath: `knowledge/${documentId}/guidance.pdf`,
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
  matches?: { id: string; score: number }[];
  policy?: { instructions: string | null; restrictions: string | null } | null;
  failGeneration?: boolean;
}) {
  const database = db();
  const prompts: { system: string; user: string }[] = [];
  let calls = 0;

  const client: WorkersAiClient = {
    run: async (_model, inputs) => {
      if ('text' in inputs) {
        return { data: (inputs.text as string[]).map(() => [0.1, 0.2]) };
      }

      if (options.failGeneration === true) {
        throw new Error('The model is on fire.');
      }

      const messages = inputs.messages as { role: string; content: string }[];

      prompts.push({ system: messages[0]!.content, user: messages[1]!.content });

      const response = options.responses[Math.min(calls, options.responses.length - 1)]!;
      calls += 1;

      return { response, usage: { total_tokens: 30 } };
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
  });

  return {
    service: new ChatService(
      database,
      gateway,
      new RetrievalService(database, gateway, vectors),
      options.policy ?? null,
    ),
    prompts,
  };
}

async function clearConversation(): Promise<void> {
  await db().delete(chatConversations).where(eq(chatConversations.studentId, studentId));
}

async function currentSet() {
  return new RecommendationService(db()).latestFor(studentId);
}

// --- the service against stubs -----------------------------------------------------------

describe('the chat pipeline (stubbed model + vector store)', () => {
  it('answers, and persists both sides of the turn', async () => {
    await clearConversation();

    const { service } = pipeline({ responses: ['Your top match leans Investigative.'] });
    const turn = await service.ask(studentId, 'Why is this my top match?', await currentSet());

    expect(turn.failure).toBeNull();
    expect(turn.answer.content).toBe('Your top match leans Investigative.');
    // The generation is linked to its `ai_requests` row — the §13.7 provenance pointer.
    expect(turn.answer.aiRequestId).not.toBeNull();

    const messages = await service.messagesFor(studentId, turn.conversation.id);

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[0]!.content).toBe('Why is this my top match?');
  });

  /**
   * §32/§40: the prompt is assembled from named values. The student's *own* scores and
   * deterministic reasons are what the model is given to reason about.
   */
  it('puts the student’s own recommendations in the prompt', async () => {
    await clearConversation();

    const set = await currentSet();
    const { service, prompts } = pipeline({ responses: ['Sure.'] });

    await service.ask(studentId, 'What are my options?', set);

    const user = prompts[0]!.user;

    expect(user).toContain('THE STUDENT’S RECOMMENDATIONS');
    expect(user).toContain(set!.careers[0]!.career.title);
    // The computed score travels, and the prompt states that the model did not produce it.
    expect(user).toContain('you did not produce these and may not revise them');
  });

  it('injects the active AI policy into the system prompt (§13.7)', async () => {
    await clearConversation();

    const { service, prompts } = pipeline({
      responses: ['Understood.'],
      policy: { instructions: 'Mention the guidance office.', restrictions: 'No fees.' },
    });

    await service.ask(studentId, 'Hello', await currentSet());

    expect(prompts[0]!.system).toContain('Mention the guidance office.');
    expect(prompts[0]!.system).toContain('No fees.');
  });

  it('grounds the answer in retrieved knowledge when there is any', async () => {
    await clearConversation();

    const chunkId = await seedChunk('Nursing programs at this school require a Grade 11 average.');
    const { service, prompts } = pipeline({
      responses: ['The materials mention a Grade 11 average.'],
      matches: [{ id: chunkId, score: 0.9 }],
    });

    await service.ask(studentId, 'What do I need for nursing?', await currentSet());

    expect(prompts[0]!.user).toContain('KNOWLEDGE CONTEXT');
    expect(prompts[0]!.user).toContain('require a Grade 11 average');
  });

  /**
   * **The deliberate divergence from `ExplanationService`.** That pipeline refuses to generate
   * without grounding, because an ungrounded paragraph attached to a computed score reads as
   * evidence for it. A chat turn is different: "which of my top three pays best?" is answerable
   * from the student's own data, and refusing it because the PDF corpus is silent on salaries
   * would be refusing a question the system can actually answer.
   */
  it('still answers when retrieval finds nothing', async () => {
    await clearConversation();

    const { service } = pipeline({ responses: ['Here is what your results say.'], matches: [] });
    const turn = await service.ask(studentId, 'Tell me about my results', await currentSet());

    expect(turn.failure).toBeNull();
    expect(turn.answer.content).toBe('Here is what your results say.');
  });

  it('carries the recent transcript into the next turn', async () => {
    await clearConversation();

    const set = await currentSet();
    const { service, prompts } = pipeline({ responses: ['One.', 'Two.'] });

    await service.ask(studentId, 'First question', set);
    await service.ask(studentId, 'Second question', set);

    expect(prompts[1]!.user).toContain('RECENT CONVERSATION');
    expect(prompts[1]!.user).toContain('First question');
    expect(prompts[1]!.user).toContain('One.');
  });

  /**
   * §34's absolute-claim filter. A model that promises an outcome is not shown to a student —
   * they get the computed truth instead.
   */
  it('replaces a guaranteed-outcome answer with the deterministic reply', async () => {
    await clearConversation();

    const { service } = pipeline({
      responses: ['You will definitely get into this program.'],
    });
    const turn = await service.ask(studentId, 'Will I get in?', await currentSet());

    expect(turn.failure).toBe('FAILED_VALIDATION');
    expect(turn.answer.content).not.toContain('definitely');
    expect(turn.answer.content).toContain('here is what your results already say');
    // §29: a fallback is not model output and must not be recorded as one.
    expect(turn.answer.aiRequestId).toBeNull();
  });

  /** A dead model is a typed failure and a true answer, never a 500 and never an empty panel. */
  it('falls back to the student’s computed results when the model fails', async () => {
    await clearConversation();

    const { service } = pipeline({ responses: [], failGeneration: true });
    const set = await currentSet();
    const turn = await service.ask(studentId, 'Anything?', set);

    expect(turn.failure).toBe('MODEL_ERROR');
    expect(turn.answer.content).toContain(set!.careers[0]!.career.title);
    expect(turn.answer.aiRequestId).toBeNull();
  });

  /**
   * The question is stored **before** the model is called, so a generation that dies outright
   * still leaves what the student typed in the transcript.
   */
  it('keeps the student’s question even when the answer fails', async () => {
    await clearConversation();

    const { service } = pipeline({ responses: [], failGeneration: true });
    const turn = await service.ask(studentId, 'A question worth keeping', await currentSet());

    const messages = await service.messagesFor(studentId, turn.conversation.id);

    expect(messages[0]!.content).toBe('A question worth keeping');
  });

  /** A student with no recommendations gets an honest answer, not a crash. */
  it('answers a student who has no recommendations yet', async () => {
    await clearConversation();

    const { service } = pipeline({ responses: [], failGeneration: true });
    const turn = await service.ask(studentId, 'What are my results?', null);

    expect(turn.answer.content).toContain('completed both the RIASEC and SCCT assessments');
  });
});

// --- the HTTP surface, with the AI bindings genuinely absent -------------------------------

describe('the chat endpoints', () => {
  it('starts empty', async () => {
    await clearConversation();

    const response = await api('GET', '/student/chat', { token: studentToken });

    expect(response.status).toBe(200);
    expect(response.body.data.conversation_id).toBeNull();
    expect(response.body.data.messages).toEqual([]);
  });

  /**
   * **The worst-day behaviour**, exercised for real: `env.AI` is deleted by the test config, so
   * this is a genuine model outage. The student gets a 201 and a true answer either way.
   */
  it('answers with the deterministic reply when the AI binding is absent', async () => {
    await clearConversation();

    const response = await api('POST', '/student/chat', {
      token: studentToken,
      body: { message: 'What should I take?' },
    });

    expect(response.status).toBe(201);
    expect(response.body.data.failure).toBe('MODEL_UNAVAILABLE');
    expect(response.body.data.answer.content).toContain('your results already say');
    expect(response.body.data.answer.ai_request_id).toBeNull();
  });

  it('returns the transcript, oldest first', async () => {
    await clearConversation();

    await api('POST', '/student/chat', { token: studentToken, body: { message: 'First' } });
    await api('POST', '/student/chat', { token: studentToken, body: { message: 'Second' } });

    const response = await api('GET', '/student/chat', { token: studentToken });
    const contents = response.body.data.messages.map((message: any) => message.content);

    expect(contents[0]).toBe('First');
    expect(contents[2]).toBe('Second');
  });

  it('clears the transcript on request', async () => {
    await clearConversation();

    await api('POST', '/student/chat', { token: studentToken, body: { message: 'Forget this' } });

    const cleared = await api('DELETE', '/student/chat', { token: studentToken });

    expect(cleared.status).toBe(200);

    const after = await api('GET', '/student/chat', { token: studentToken });

    expect(after.body.data.messages).toEqual([]);
  });

  it('rejects an empty or oversized message', async () => {
    const empty = await api('POST', '/student/chat', {
      token: studentToken,
      body: { message: '   ' },
    });

    expect(empty.status).toBe(422);

    const huge = await api('POST', '/student/chat', {
      token: studentToken,
      body: { message: 'x'.repeat(1001) },
    });

    expect(huge.status).toBe(422);
  });

  /**
   * `.strict()`: the recommendation context is loaded server-side from the caller's own token. A
   * client that could supply its own context could have the model explain any numbers it liked as
   * though they were this student's results.
   */
  it('refuses a client-supplied context', async () => {
    const response = await api('POST', '/student/chat', {
      token: studentToken,
      body: { message: 'Hello', recommendations: [{ title: 'Astronaut', score: 100 }] },
    });

    expect(response.status).toBe(422);
  });

  it('requires a student', async () => {
    const counselorToken = await login(await createStaffUser({ role: 'counselor' }));

    const response = await api('POST', '/student/chat', {
      token: counselorToken,
      body: { message: 'Hello' },
    });

    expect(response.status).toBe(403);
  });

  it('requires authentication', async () => {
    const response = await api('GET', '/student/chat');

    expect(response.status).toBe(401);
  });
});

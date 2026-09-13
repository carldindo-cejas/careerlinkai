/* eslint-disable @typescript-eslint/require-await -- async-interface stubs have nothing to await */
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import { chatConversations } from '@/db/schema';
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
} from '../helpers';

/**
 * **Gate 2 — exact answers from the student's own results and the catalog** (2026-09-13).
 *
 * The two questions a real student asked on production and was refused — *"why certified public
 * accountant?"* and *"Where to study my first top program recommendation"* — are lookups. These
 * tests pin that they are answered from the rows with no model call, and that a question the gate
 * cannot bind still reaches the model.
 */

let studentId: string;
let collegeName: string;

beforeAll(async () => {
  const admin = await createStaffUser({ role: 'admin' });
  const adminToken = await login(admin);
  const counselor = await createStaffUser({ role: 'counselor' });
  const counselorToken = await login(counselor);

  const college = await createCollege(adminToken);
  const program = await createProgram(adminToken, college.id);
  const career = await createCareer(adminToken, { typical_riasec_code: 'IEC' });

  collegeName = college.name;
  await attachCareer(adminToken, program.id, career.id);

  const seeded = await seedInstruments(admin);
  const fixture = await classWithStudent(counselorToken);

  for (const versionId of [seeded.riasecVersionId!, seeded.scctVersionId!]) {
    const assignment = await assignVersion(counselorToken, fixture.classRoom.id, versionId);
    const start = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: fixture.studentToken,
    });
    const attempt = await api('GET', `/student/attempts/${start.body.data.id}`, {
      token: fixture.studentToken,
    });

    await answerAll(fixture.studentToken, attempt.body.data, () => 4);
    await api('POST', `/student/attempts/${start.body.data.id}/submit`, {
      token: fixture.studentToken,
    });
  }

  studentId = fixture.student.student_id ?? fixture.student.id;
});

function pipeline() {
  const database = db();
  let generations = 0;

  const client: WorkersAiClient = {
    run: async (_model, inputs) => {
      if ('text' in inputs) {
        return { data: (inputs.text as string[]).map(() => [0.1, 0.2]) };
      }

      generations += 1;

      return { response: 'Here is what your results say.', usage: { total_tokens: 10 } };
    },
  };

  const vectors: VectorStore = {
    upsert: async () => undefined,
    query: async () => ({ matches: [] }),
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
      null,
    ),
    generations: () => generations,
  };
}

async function fresh() {
  await db().delete(chatConversations).where(eq(chatConversations.studentId, studentId));

  return new RecommendationService(db()).latestFor(studentId);
}

describe('Gate 2 — questions the results and catalog answer exactly', () => {
  it('explains why a career is a match from the stored reason, with no model call', async () => {
    const set = await fresh();
    const top = set!.careers[0]!;
    const { service, generations } = pipeline();

    const turn = await service.ask(studentId, `why ${top.career.title.toLowerCase()}?`, set);

    expect(generations()).toBe(0);
    expect(turn.failure).toBeNull();
    expect(turn.answer.content).toContain(`${top.career.title} is your #1 career match`);
    expect(turn.answer.content).toContain(top.recommendation.reason);
    expect(turn.answer.sources).toEqual(['Your results']);
  });

  it('says where to study the top program, naming its college', async () => {
    const set = await fresh();
    const { service, generations } = pipeline();

    const turn = await service.ask(
      studentId,
      'Where to study my first top program recommendation',
      set,
    );

    expect(generations()).toBe(0);
    expect(turn.answer.content).toContain('Your #1 program match is');
    expect(turn.answer.content).toContain(set!.programs[0]!.college.name);
    expect(turn.answer.content).toContain(collegeName);
  });

  it('lists the programs and colleges that lead to a career', async () => {
    const set = await fresh();
    const career = set!.careers[0]!.career;
    const { service } = pipeline();

    const turn = await service.ask(
      studentId,
      `where can I study to become ${career.title}`,
      set,
    );

    expect(turn.answer.content).toContain(`These programs lead to ${career.title}`);
    expect(turn.answer.content).toContain('BS Computer Science');
    expect(turn.answer.content).toContain(collegeName);
  });

  it('leaves a question it cannot bind to the model', async () => {
    const set = await fresh();
    const { service, generations } = pipeline();

    await service.ask(studentId, 'Tell me about my results', set);

    expect(generations()).toBe(1);
  });
});

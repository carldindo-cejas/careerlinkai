/* eslint-disable @typescript-eslint/require-await -- async-interface stubs have nothing to await */
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import { chatConversations } from '@/db/schema';
import { collegeAliases } from '@/lib/aliases';
import { AiGatewayService, type WorkersAiClient } from '@/modules/ai/ai-gateway-service';
import { ChatService } from '@/modules/ai/chat-service';
import { RetrievalService } from '@/modules/ai/retrieval-service';
import type { VectorStore } from '@/modules/ai/vector-store';
import { suggestedQuestions } from '@/modules/recommendation/brief-serializer';
import { RecommendationService } from '@/modules/recommendation/recommendation-service';
import {
  StudentBriefService,
  briefToProse,
} from '@/modules/recommendation/student-brief-service';
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
 * AI-COVERAGE-PLAN.md Phases 1, 2 and 5: the Student Brief, the Gate 2 intents, follow-ups, and
 * that a question Gate 2 cannot bind still reaches the model with the brief in its prompt.
 */

const COLLEGE = 'Holy Name University';
let studentId: string;
let studentToken: string;
let careerTitle: string;

beforeAll(async () => {
  const admin = await createStaffUser({ role: 'admin' });
  const adminToken = await login(admin);
  const counselor = await createStaffUser({ role: 'counselor' });
  const counselorToken = await login(counselor);

  const college = await createCollege(adminToken, { name: COLLEGE });
  const program = await createProgram(adminToken, college.id, { name: 'BS Computer Science' });
  const career = await createCareer(adminToken, {
    title: 'Data Scientist',
    typical_riasec_code: 'IRC',
    salary_min: 55000,
    salary_max: 180000,
  });

  careerTitle = career.title;
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

    await answerAll(studentToken, attempt.body.data, (_question, index) => index % 5);
    await api('POST', `/student/attempts/${start.body.data.id}/submit`, {
      token: studentToken,
    });
  }

  studentId = fixture.student.student_id ?? fixture.student.id;
});

function pipeline() {
  const database = db();
  const prompts: string[] = [];

  const client: WorkersAiClient = {
    run: async (_model, inputs) => {
      if ('text' in inputs) {
        return { data: (inputs.text as string[]).map(() => [0.1, 0.2]) };
      }

      const messages = inputs.messages as { role: string; content: string }[];

      prompts.push(messages[1]!.content);

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
    prompts,
  };
}

async function ask(question: string) {
  const set = await new RecommendationService(db()).latestFor(studentId);
  const run = pipeline();
  const turn = await run.service.ask(studentId, question, set);

  return { turn, prompts: run.prompts, set };
}

async function fresh() {
  await db().delete(chatConversations).where(eq(chatConversations.studentId, studentId));
}

describe('college aliases', () => {
  it('derives the short names students type', () => {
    expect(collegeAliases('Holy Name University')).toContain('HNU');
    expect(collegeAliases('Bohol Island State University - Bilar Campus')).toContain('BISU');
    expect(collegeAliases('BIT International College - Jagna Campus')).toContain('BIT');
    expect(collegeAliases('University of Bohol')).toContain('UB');
    // Two-letter initials that collide with program names are refused.
    expect(collegeAliases('Cristal e-College')).not.toContain('CE');
  });
});

describe('the Student Brief', () => {
  it('carries the profile, both instruments, and score components', async () => {
    const brief = await new StudentBriefService(db()).briefFor(studentId);

    expect(brief.riasec.complete).toBe(true);
    expect(brief.riasec.dimensions).toHaveLength(6);
    expect(brief.riasec.hollandCode).toMatch(/^[RIASEC]{3}$/);
    expect(brief.scct.complete).toBe(true);
    expect(brief.scct.dimensions).toHaveLength(3);
    expect(brief.scct.confidenceIndex).not.toBeNull();
    expect(brief.careers[0]!.components).not.toBeNull();

    const prose = briefToProse(brief);

    expect(prose).toContain('RIASEC interest scores');
    expect(prose).toContain(`Holland code: ${brief.riasec.hollandCode}`);
    expect(prose).toContain('Components: RIASEC fit');
  });

  it('suggests questions that Gate 2 answers without a model call', async () => {
    const brief = await new StudentBriefService(db()).briefFor(studentId);

    for (const question of suggestedQuestions(brief)) {
      await fresh();
      const { prompts } = await ask(question);

      expect(prompts, question).toHaveLength(0);
    }
  });

  it('is served to the student who owns it', async () => {
    const response = await api('GET', '/student/brief', { token: studentToken });

    expect(response.status).toBe(200);
    expect(response.body.data.has_recommendations).toBe(true);
    expect(response.body.data.suggestions.length).toBeGreaterThan(0);
  });
});

describe('Gate 2 intents', () => {
  it('describes what it can do', async () => {
    await fresh();
    const { turn, prompts } = await ask('What can you do?');

    expect(prompts).toHaveLength(0);
    expect(turn.answer.content).toContain('The college catalog');
    expect(turn.answer.answerKind).toBe('CANNED');
  });

  it('states the Holland code from the brief', async () => {
    await fresh();
    const brief = await new StudentBriefService(db()).briefFor(studentId);
    const { turn } = await ask('What is my Holland code?');

    expect(turn.answer.content).toContain(`Your Holland code is ${brief.riasec.hollandCode}`);
  });

  it('lists the top careers', async () => {
    await fresh();
    const { turn, set } = await ask('Whats my top 1 career?');

    expect(turn.answer.content).toContain(`#1 ${set!.careers[0]!.career.title}`);
  });

  it('finds a college by its alias', async () => {
    await fresh();
    const { turn, prompts } = await ask('HNU location');

    expect(prompts).toHaveLength(0);
    expect(turn.answer.content).toContain(COLLEGE);
    expect(turn.answer.sources).toEqual(['College catalog']);
  });

  it('answers a follow-up about the college named a moment ago', async () => {
    await fresh();
    await ask('Where is Holy Name University?');
    const { turn, prompts } = await ask('what programs do they offer');

    expect(prompts).toHaveLength(0);
    expect(turn.answer.content).toContain('BS Computer Science');
  });

  // Production, 2026-09-13: both were answered from the previous subject — a college's program list,
  // then "careers after BS Computer Science" — instead of reaching the knowledge base.
  it('does not borrow the last subject for a question that does not point back', async () => {
    await fresh();
    await ask('Where is Holy Name University?');

    for (const question of [
      'What is the purpose of the career guidance program in senior high school?',
      'How can I prepare for choosing a career after Grade 12?',
    ]) {
      const { turn } = await ask(question);

      expect(turn.answer.content, question).not.toContain('offers:');
      expect(turn.answer.content, question).not.toContain('commonly go into these careers');
      expect(turn.answer.content, question).not.toContain('lists colleges in');
    }
  });

  it('lists the careers a program leads to, with pay', async () => {
    await fresh();
    const { turn } = await ask('What careers can I take after BS Computer Science?');

    expect(turn.answer.content).toContain(careerTitle);
    expect(turn.answer.content).toContain('₱55,000');
  });

  it('states a career salary from the catalog', async () => {
    await fresh();
    const { turn } = await ask(`What is the salary of a ${careerTitle}?`);

    expect(turn.answer.content).toContain('₱55,000 – ₱180,000 a month');
  });

  it('says where the catalog stops', async () => {
    await fresh();
    const { turn } = await ask('What colleges in Cebu offer BS Computer Science?');

    expect(turn.answer.content).toContain('only');
    expect(turn.answer.content).toContain('cebu');
    expect(turn.answer.content).toContain(COLLEGE);
  });

  it('leaves an open question to the model, with the brief in its prompt', async () => {
    await fresh();
    const { prompts } = await ask('Is BS Computer Science a good fit for someone like me?');

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('STUDENT PROFILE');
    expect(prompts[0]).toContain('SCCT confidence scores');
  });

  /**
   * Found on production, 2026-09-13: the student's top programs are not taught at the campus they
   * want, and "what should I choose" was answered with the campus's program list. The campus is
   * added *after* the student's recommendations were generated, so none of its programs is in the
   * stored top list — exactly the production situation.
   */
  it('ranks a chosen campus’s programs for the student when none is on their list', async () => {
    await fresh();
    const adminToken = await login(await createStaffUser({ role: 'admin' }));
    const calape = await createCollege(adminToken, {
      name: 'Bohol Island State University - Calape Campus',
    });
    const fisheries = await createProgram(adminToken, calape.id, { name: 'BS Fisheries' });
    const foodTech = await createProgram(adminToken, calape.id, { name: 'BS Food Technology' });
    const fishCareer = await createCareer(adminToken, {
      title: 'Fisheries Technologist',
      typical_riasec_code: 'RIE',
    });
    const foodCareer = await createCareer(adminToken, {
      title: 'Food Technologist',
      typical_riasec_code: 'IRC',
    });

    await attachCareer(adminToken, fisheries.id, fishCareer.id);
    await attachCareer(adminToken, foodTech.id, foodCareer.id);

    const { turn, prompts } = await ask(
      'the top programs are not offered in bisu calape but i want to study there, what should i choose based on my assessment results',
    );

    expect(prompts).toHaveLength(0);
    expect(turn.answer.content).toContain('None of your top');
    expect(turn.answer.content).toContain('scored for you with the same formula');
    expect(turn.answer.content).toContain('BS Fisheries');
    expect(turn.answer.content).toContain('BS Food Technology');
    expect(turn.answer.content).toMatch(/Your strongest fit there is BS F\w+ \w* ?\(\d/);
    expect(turn.answer.content).toContain('leads to Food Technologist');
    expect(turn.answer.sources).toEqual(['Your results', 'College catalog']);
  });

  it('does not answer tuition questions from data it does not have', async () => {
    await fresh();
    const { turn } = await ask('How much is the tuition fee for BS Computer Science at HNU?');

    expect(turn.answer.content).not.toContain('₱');
  });
});

/* eslint-disable @typescript-eslint/require-await -- async-interface stubs have nothing to await */
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import { chatConversations } from '@/db/schema';
import {
  CAREER_ALIASES,
  CATALOG_GAPS,
  VAGUE_CAREER_TERMS,
} from '@/knowledge/catalog-vocabulary';
import { normaliseQuestion } from '@/lib/grounding';
import { AiGatewayService, type WorkersAiClient } from '@/modules/ai/ai-gateway-service';
import { careerForms, exclusiveCareerForms, programForms } from '@/modules/ai/catalog-index';
import { ChatService } from '@/modules/ai/chat-service';
import { RetrievalService } from '@/modules/ai/retrieval-service';
import type { VectorStore } from '@/modules/ai/vector-store';
import {
  attachCareer,
  classWithStudent,
  createCareer,
  createCollege,
  createProgram,
  createStaffUser,
  db,
  login,
} from '../helpers';

/**
 * IMPLEMENT-kb-grounding.md §2 and §9 — the words students actually use.
 *
 * A student asked *"where to study certified public accountant"* and *"what programs to become a
 * certified public accountant"*. The same question arrives as "CPA", "accountant", "unsaon
 * pag-accountant" and "paano maging pulis"; next to it come "I want to be a doctor" (no college
 * offers it) and "how do I become an engineer" (which one?). Each is pinned here to a complete
 * answer from the catalog rows, with no model call.
 */

let adminToken: string;
let studentId: string;
let hnuId: string;

async function offer(collegeId: string, name: string, code: string, careerId: string) {
  const program = await createProgram(adminToken, collegeId, { name, code });

  await attachCareer(adminToken, program.id, careerId);
}

beforeAll(async () => {
  adminToken = await login(await createStaffUser({ role: 'admin' }));
  const counselorToken = await login(await createStaffUser({ role: 'counselor' }));

  const hnu = await createCollege(adminToken, { name: 'Holy Name University' });
  const ub = await createCollege(adminToken, { name: 'University of Bohol' });
  const career = async (title: string): Promise<string> =>
    (await createCareer(adminToken, { title })).id;

  hnuId = hnu.id;

  const cpa = await career('Certified Public Accountant');
  const developer = await career('Software Developer');

  await offer(hnu.id, 'BS Accountancy', 'BSA', cpa);
  await offer(ub.id, 'BS Accountancy', 'BSA', cpa);
  await offer(ub.id, 'BS Computer Science', 'BSCS', developer);
  await offer(ub.id, 'BS Information Technology', 'BSIT', developer);
  await offer(ub.id, 'BS Information Systems', 'BSIS', developer);
  await offer(ub.id, 'BS Computer Engineering', 'BSCPE', developer);
  await offer(hnu.id, 'BS Nursing', 'BSN', await career('Registered Nurse'));
  await offer(ub.id, 'BS Criminology', 'BSCRIM', await career('Police Officer'));
  await offer(ub.id, 'BS Civil Engineering', 'BSCE', await career('Civil Engineer'));
  await offer(ub.id, 'BS Mechanical Engineering', 'BSME', await career('Mechanical Engineer'));
  await offer(ub.id, 'BS Marine Transportation', 'BSMARTRANS', await career('Deck Officer'));
  await offer(ub.id, 'BS Marine Engineering', 'BSMARE', await career('Marine Engineer'));
  // Its initials are `bsa` — BS Accountancy's code.
  await career('Business Systems Analyst');

  const fixture = await classWithStudent(counselorToken);

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

/** A fresh conversation each time, so no answer inherits the last one's subject. */
async function ask(question: string) {
  await db().delete(chatConversations).where(eq(chatConversations.studentId, studentId));

  const run = pipeline();
  const turn = await run.service.ask(studentId, question, null);

  return { text: turn.answer.content, prompts: run.prompts };
}

describe('the vocabulary tables', () => {
  const owners = new Map<string, string[]>();

  for (const [title, aliases] of Object.entries(CAREER_ALIASES)) {
    for (const alias of aliases) {
      owners.set(alias, [...(owners.get(alias) ?? []), title]);
    }
  }

  it('writes every form the way questions are normalised', () => {
    const forms = [
      ...owners.keys(),
      ...VAGUE_CAREER_TERMS.flatMap((term) => term.forms),
      ...CATALOG_GAPS.flatMap((gap) => [...gap.forms, ...gap.offeredAs]),
    ];

    for (const form of forms) {
      expect(normaliseQuestion(form), form).toBe(form);
    }
  });

  it('gives every alias exactly one career', () => {
    for (const [alias, titles] of owners) {
      expect(titles, alias).toHaveLength(1);
    }

    // Nor may an alias be another listed career's title, plural or initials.
    for (const [title, aliases] of Object.entries(CAREER_ALIASES)) {
      const others = Object.keys(CAREER_ALIASES)
        .filter((other) => other !== title)
        .flatMap((other) => careerForms(other));

      for (const alias of aliases) {
        expect(others, `${alias} (${title})`).not.toContain(alias);
      }
    }
  });

  it('never puts one word in two places', () => {
    const all = [
      ...owners.keys(),
      ...VAGUE_CAREER_TERMS.flatMap((term) => term.forms),
      ...CATALOG_GAPS.flatMap((gap) => gap.forms),
    ];

    expect(all.filter((form, i) => all.indexOf(form) !== i)).toEqual([]);
  });

  it('drops a career name that a program or another career also claims', () => {
    const [analyst, developer, engineer] = exclusiveCareerForms(
      [
        { title: 'Business Systems Analyst', forms: careerForms('Business Systems Analyst') },
        { title: 'Software Developer', forms: careerForms('Software Developer') },
        { title: 'Software Engineer', forms: careerForms('Software Engineer') },
      ],
      programForms('BS Accountancy', 'BSA'),
    );

    expect(analyst).not.toContain('bsa');
    expect(analyst).toContain('business systems analyst');
    expect(developer).not.toContain('software engineer');
    expect(developer).toContain('programmer');
    expect(engineer).toContain('software engineer');
    expect(engineer).toContain('software engineers');
  });
});

describe('asking by career, in the words students use', () => {
  it.each([
    'where to study certified public accountant',
    'what programs to become a certified public accountant',
    'how do I become a CPA',
    'unsaon pag-accountant',
    'where can I study to be an accountant',
  ])('answers “%s” with every college on the route', async (question) => {
    const { text, prompts } = await ask(question);

    expect(prompts).toHaveLength(0);
    expect(text).toContain('These programs lead to Certified Public Accountant');
    expect(text).toContain('BS Accountancy: Holy Name University, University of Bohol');
  });

  it('lists every program that leads to a career', async () => {
    const { text } = await ask('how do I become a software developer');

    for (const name of [
      'BS Computer Science',
      'BS Information Technology',
      'BS Information Systems',
      'BS Computer Engineering',
    ]) {
      expect(text).toContain(name);
    }
  });

  it('understands Tagalog and everyday job names', async () => {
    expect((await ask('paano maging pulis')).text).toContain(
      'These programs lead to Police Officer',
    );
    expect((await ask('I want to be a nurse')).text).toContain(
      '• BS Nursing: Holy Name University',
    );
  });

  it('does not let a career’s initials take a program’s code', async () => {
    const { text } = await ask('where to study BSA');

    expect(text).toContain('BS Accountancy is offered at');
    expect(text).not.toContain('Business Systems Analyst');
  });
});

describe('words that cover several careers', () => {
  it('asks which engineer rather than picking one', async () => {
    const { text, prompts } = await ask('how do I become an engineer');

    expect(prompts).toHaveLength(0);
    expect(text).toContain('“Engineer” can mean several careers. Which one do you mean?');
    expect(text).toContain('• Civil Engineer — BS Civil Engineering');
    expect(text).toContain('• Mechanical Engineer — BS Mechanical Engineering');
    expect(text).toContain('how do I become a civil engineer?');
  });

  it('answers the example it suggests', async () => {
    const { text } = await ask('how do I become a civil engineer?');

    expect(text).toContain('These programs lead to Civil Engineer');
  });

  it('names both routes to sea for "seaman"', async () => {
    const { text } = await ask('where can I study to be a seaman');

    expect(text).toContain('• Deck Officer — BS Marine Transportation');
    expect(text).toContain('• Marine Engineer — BS Marine Engineering');
  });
});

describe('programs no college in the catalog offers', () => {
  it('says so, and lists the related programs that are offered', async () => {
    const { text, prompts } = await ask('I want to be a doctor');

    expect(prompts).toHaveLength(0);
    expect(text).toContain('No college in the catalog offers a Doctor of Medicine program.');
    expect(text).toContain('NMAT');
    expect(text).toContain('• BS Nursing: Holy Name University');
    // Named in the gap's list, but no college in this catalog offers it.
    expect(text).not.toContain('BS Pharmacy');
  });

  // Last in the file: it adds a program.
  it('stops calling it a gap once a college offers it', async () => {
    await createProgram(adminToken, hnuId, { name: 'Doctor of Medicine', code: 'DRMED' });

    const { text } = await ask('I want to be a doctor');

    expect(text).not.toContain('offers a Doctor of Medicine program');
  });
});

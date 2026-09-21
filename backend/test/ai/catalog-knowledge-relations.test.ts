import { env } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { knowledgeDocuments } from '@/db/schema';
import { requestCatalogResync } from '@/jobs/ai-jobs';
import { syncCatalogKnowledge } from '@/modules/ai/catalog-knowledge-service';
import {
  api,
  attachCareer,
  createCareer,
  createCollege,
  createProgram,
  createStaffUser,
  db,
  login,
} from '../helpers';

/**
 * **What the catalog knows, and what the assistant could read** (2026-09-09).
 *
 * Measured on production before this change, against a fully-synced career corpus:
 *
 *   * *"Where is Holy Name University located?"* — refused, three times out of three.
 *   * *"Tell me about BS Accountancy at Holy Name University"* — answered correctly, **including
 *     the address**, from a chunk whose subject was the program.
 *
 * Retrieval was working. There was simply no passage whose subject was an institution, so a
 * question about one matched career passages and the grounding contract correctly refused. The
 * same hole ran through `program_careers`: the links are richly populated (BS Accountancy maps to
 * five careers) and reached the corpus nowhere, so *"what school should i enroll for database
 * administrator career"* — a real question in the production refusal log — could not be answered
 * from a join the system had always been able to make.
 *
 * These tests pin the three passages against the catalog rows behind them.
 */

const unique = () => crypto.randomUUID().slice(0, 8);

async function bodyOf(
  entityType: 'career' | 'program' | 'college',
  entityId: string,
): Promise<string> {
  const [entry] = await db()
    .select()
    .from(knowledgeDocuments)
    .where(
      and(
        eq(knowledgeDocuments.entityType, entityType),
        eq(knowledgeDocuments.entityId, entityId),
      ),
    );

  expect(entry, `no ${entityType} entry for ${entityId}`).toBeDefined();

  const object = await env.STORAGE.get(`knowledge/${entry!.id}/extracted.txt`);

  return object!.text();
}

/** A full Region → Province → Town chain through the real bulk endpoints. */
async function addressChain(token: string) {
  const one = async (url: string, name: string) => {
    const response = await api('POST', url, { token, body: { items: [{ name }] } });

    if (response.status !== 201) {
      throw new Error(`Fixture import failed: ${JSON.stringify(response.body)}`);
    }

    return response.body.data.created[0] as { id: string; name: string };
  };

  const region = await one('/admin/regions/bulk', `Region ${unique()}`);
  const province = await one(`/admin/regions/${region.id}/provinces/bulk`, `Province ${unique()}`);
  const town = await one(`/admin/provinces/${province.id}/towns/bulk`, `Town ${unique()}`);

  return { region, province, town };
}

describe('the college entry — the subject the corpus was missing', () => {
  it('states where the college is and what it offers', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const { region, province, town } = await addressChain(token);

    const response = await api('POST', '/admin/colleges', {
      token,
      body: {
        name: `University of ${unique()}`,
        description: 'A private non-sectarian university focused on health sciences.',
        region_id: region.id,
        province_id: province.id,
        town_id: town.id,
      },
    });

    expect(response.status).toBe(201);

    const college = response.body.data;

    await createProgram(token, college.id, { name: 'BS Computer Science' });
    await createProgram(token, college.id, { name: 'BS Nursing' });

    await syncCatalogKnowledge(db(), env, admin.id);

    const text = await bodyOf('college', college.id);

    expect(text).toContain(`College: ${college.name}.`);
    // Down to the region, so "colleges in <province>" and "colleges in <region>" both match.
    expect(text).toContain(`is located in ${town.name}, ${province.name}, ${region.name}.`);
    expect(text).toContain('A private non-sectarian university focused on health sciences.');
    // The half that answers "what colleges in Cebu offer BS Computer Science?" from one chunk.
    expect(text).toContain('BS Computer Science');
    expect(text).toContain('BS Nursing');
  });

  /**
   * Silence would leave the model free to assume the usual degrees. Saying so is the grounding.
   */
  it('says so plainly when a college has no programs yet', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const college = await createCollege(token);

    await syncCatalogKnowledge(db(), env, admin.id);

    await expect(bodyOf('college', college.id)).resolves.toContain(
      `No programs are listed for ${college.name} in this system yet.`,
    );
  });

  it('retires the entry when the college leaves the catalog', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const college = await createCollege(token);

    await syncCatalogKnowledge(db(), env, admin.id);

    const [before] = await db()
      .select()
      .from(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.entityType, 'college'),
          eq(knowledgeDocuments.entityId, college.id as string),
        ),
      );

    expect(before!.archivedAt).toBeNull();

    const deleted = await api('DELETE', `/admin/colleges/${college.id}`, { token });

    expect(deleted.status).toBe(204);

    await syncCatalogKnowledge(db(), env, admin.id);

    const [after] = await db()
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, before!.id));

    // An assistant still describing a withdrawn institution is the worse of the two failures.
    expect(after!.archivedAt).not.toBeNull();
  });
});

describe('program_careers reaches the corpus, in both directions', () => {
  it('names where a program leads, and where a career is taught', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const college = await createCollege(token, { name: `Holy Name ${unique()}` });
    const program = await createProgram(token, college.id, { name: 'BS Accountancy' });
    const career = await createCareer(token, { title: `Certified Public Accountant ${unique()}` });

    await attachCareer(token, program.id, career.id);
    await syncCatalogKnowledge(db(), env, admin.id);

    // Forward: the school's own mapping, not an 8B model noticing that the two names rhyme.
    await expect(bodyOf('program', program.id)).resolves.toContain(
      `Graduates of BS Accountancy commonly go into these careers: ${career.title}.`,
    );

    // Reverse: "what school should i enroll for <career>", straight from one retrieved chunk.
    await expect(bodyOf('career', career.id)).resolves.toContain(
      `Programs that lead to this career: BS Accountancy at ${college.name}.`,
    );
  });

  /**
   * The lists are sorted, and that is load-bearing rather than cosmetic: the passage's SHA-256 is
   * what decides whether an entry is re-embedded (migration 0024), so an order that varied between
   * runs would re-embed the whole catalog every night on a budget that cannot afford it.
   */
  it('orders the list so an unchanged catalog stays unchanged', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const college = await createCollege(token);
    const program = await createProgram(token, college.id, { name: 'BS Information Technology' });

    const zulu = await createCareer(token, { title: `Zulu Analyst ${unique()}` });
    const alpha = await createCareer(token, { title: `Alpha Analyst ${unique()}` });

    await attachCareer(token, program.id, zulu.id);
    await attachCareer(token, program.id, alpha.id);
    await syncCatalogKnowledge(db(), env, admin.id);

    const text = await bodyOf('program', program.id);

    expect(text.indexOf(alpha.title as string)).toBeLessThan(text.indexOf(zulu.title as string));

    // And the second run is a no-op: nothing rewritten, nothing re-embedded.
    const again = await syncCatalogKnowledge(db(), env, admin.id);

    expect(again.changed).toBe(0);
  });

  it('drops a career from the program passage once it is unlinked', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const college = await createCollege(token);
    const program = await createProgram(token, college.id);
    const career = await createCareer(token);

    await attachCareer(token, program.id, career.id);
    await syncCatalogKnowledge(db(), env, admin.id);

    await expect(bodyOf('program', program.id)).resolves.toContain(career.title as string);

    const detached = await api('DELETE', `/admin/programs/${program.id}/careers/${career.id}`, {
      token,
    });

    expect(detached.status).toBe(200);

    await syncCatalogKnowledge(db(), env, admin.id);

    await expect(bodyOf('program', program.id)).resolves.not.toContain(career.title as string);
  });
});

describe('an admin save tells the knowledge pipeline the catalog moved', () => {
  /**
   * The gap this closes: the sync ran at 03:00 and on a button, and nowhere else, so an admin who
   * added a college at 2pm and asked the assistant at 2:05 was told nothing covered it — for
   * another thirteen hours.
   */
  function recordingQueue() {
    const sent: { type: string; payload: unknown }[] = [];

    return {
      sent,
      env: {
        ...env,
        QUEUE_AI: {
          send: (message: { type: string; payload: unknown }) => {
            sent.push(message);

            return Promise.resolve();
          },
        },
      } as unknown as typeof env,
    };
  }

  it('asks for a sync starting at the first page', async () => {
    const { env: recorded, sent } = recordingQueue();

    await requestCatalogResync(recorded);

    expect(sent).toEqual([{ type: 'SyncCatalogKnowledge', payload: { page: 1 } }]);
  });

  /**
   * A queue that is unreachable must not turn a successful college edit into a 500: the catalog
   * write is already committed and correct, and the nightly cron makes a dropped message a delay
   * rather than a loss.
   */
  it('never throws when the queue is unreachable', async () => {
    const broken = {
      ...env,
      QUEUE_AI: {
        send: () => Promise.reject(new Error('queue unreachable')),
      },
    } as unknown as typeof env;

    await expect(requestCatalogResync(broken)).resolves.toBeUndefined();
  });
});

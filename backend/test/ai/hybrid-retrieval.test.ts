/* eslint-disable @typescript-eslint/require-await -- async-interface stubs have nothing to await */
import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import { knowledgeChunks, knowledgeDocuments } from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { AiGatewayService, type WorkersAiClient } from '@/modules/ai/ai-gateway-service';
import {
  fuseByReciprocalRank,
  RetrievalService,
  toFtsQuery,
} from '@/modules/ai/retrieval-service';
import type { VectorFilter, VectorStore } from '@/modules/ai/vector-store';
import { createStaffUser, db, type StaffUserFixture } from '../helpers';

/**
 * **Hybrid retrieval** (AiNormalisation Phase 2) — metadata filtering, FTS5 keyword search,
 * reciprocal-rank fusion, and the KV embedding cache.
 *
 * The claim under test is precision: Phase 0 made retrieval return things and Phase 1 made the
 * corpus grow, and a bigger corpus searched on similarity alone gets *noisier*. Two assertions
 * carry most of the weight — that a query naming something exactly finds it even when the
 * embedding disagrees, and that explaining one program can prefer chunks about that program.
 */

let admin: StaffUserFixture;

beforeAll(async () => {
  admin = await createStaffUser({ role: 'admin' });
});

async function seedChunk(
  content: string,
  entity?: { type: 'career' | 'program'; id: string },
): Promise<string> {
  const documentId = uuid();
  const chunkId = uuid();
  const timestamp = now();

  await db()
    .insert(knowledgeDocuments)
    .values({
      id: documentId,
      uploadedBy: admin.id,
      title: 'seeded',
      fileName: 'seeded',
      sourceType: entity === undefined ? 'text' : 'catalog',
      storagePath: null,
      entityType: entity?.type ?? null,
      entityId: entity?.id ?? null,
      processingStatus: 'COMPLETED',
      visibility: 'GLOBAL',
      archivedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

  await db()
    .insert(knowledgeChunks)
    .values({
      id: chunkId,
      documentId,
      chunkNumber: 1,
      content,
      vectorId: chunkId,
      tokenCount: 50,
      sourceType: entity === undefined ? 'text' : 'catalog',
      entityType: entity?.type ?? null,
      entityId: entity?.id ?? null,
      createdAt: timestamp,
    });

  return chunkId;
}

interface Recorded {
  embedCalls: string[];
  filters: (VectorFilter | undefined)[];
}

function harness(options: {
  matches?: { id: string; score: number }[];
  cache?: KVNamespace;
} = {}) {
  const database = db();
  const recorded: Recorded = { embedCalls: [], filters: [] };

  const client: WorkersAiClient = {
    run: async (model, inputs) => {
      if (model === 'stub-rerank') {
        // Identity rerank: keep the fused order, so these tests assert fusion rather than a
        // cross-encoder's opinion (which has no local emulation to assert against anyway).
        return {
          response: (inputs.contexts as unknown[]).map((_context, index) => ({
            id: index,
            score: 1 - index / 100,
          })),
        };
      }

      recorded.embedCalls.push(...(inputs.text as string[]));

      return { data: (inputs.text as string[]).map(() => [0.1, 0.2]) };
    },
  };

  const vectors: VectorStore = {
    upsert: async () => undefined,
    query: async (_vector, queryOptions) => {
      recorded.filters.push(queryOptions.filter);

      return { matches: options.matches ?? [] };
    },
    deleteByIds: async () => undefined,
  };

  const gateway = new AiGatewayService(database, client, {
    text: 'stub-text',
    embedding: 'stub-embed',
    rerank: 'stub-rerank',
  });

  return {
    service: new RetrievalService(database, gateway, vectors, undefined, options.cache),
    recorded,
  };
}

describe('toFtsQuery — a question is not a boolean expression', () => {
  it('quotes every content word and joins with OR, dropping stopwords', () => {
    // "for" carries no evidence: a chunk matching only on it is not a weak match, it is not a
    // match. Dropping it is what keeps an honest refusal reachable.
    expect(toFtsQuery('tuition for nursing')).toBe('"tuition" OR "nursing"');
  });

  /**
   * The reason this function exists at all. FTS5 treats `"`, `*`, `:`, `^`, `-`, `AND`, `OR` and
   * `NEAR` as operators, so a question with an apostrophe or a stray quote is a **syntax error**,
   * not a search — and an unparseable query would take the keyword half down on exactly the
   * questions students phrase most naturally.
   */
  it('neutralises FTS5 operator syntax rather than passing it through', () => {
    const match = toFtsQuery('what"s the NEAR cost -of "BSCS"* ?');

    expect(match).not.toBeNull();
    expect(match).not.toContain('*');
    expect(match).not.toContain('-');
    // FTS5 operators survive only as quoted literal tokens, never as syntax — the ones that are
    // not also stopwords, at least: "the" and "what" are dropped before this point.
    expect(match).toContain('"near"');
    expect(match).toContain('"bscs"');
    expect(match).toContain('"cost"');
  });

  it('returns null when nothing searchable survives', () => {
    expect(toFtsQuery('?!  ... ')).toBeNull();
    // Single characters are noise, not terms.
    expect(toFtsQuery('a b c')).toBeNull();
  });
});

describe('fuseByReciprocalRank', () => {
  it('ranks a chunk both halves agree on above one either half loves alone', () => {
    const fused = fuseByReciprocalRank(['vector-only', 'both'], ['both', 'keyword-only']);

    // Rank 2 in both lists beats rank 1 in one — that agreement is the whole point of RRF, and
    // it is why the two halves' incomparable scores never have to be normalised.
    expect(fused[0]).toBe('both');
    expect(fused).toContain('vector-only');
    expect(fused).toContain('keyword-only');
  });

  it('keeps a list that is empty from removing the other half', () => {
    expect(fuseByReciprocalRank([], ['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('hybrid retrieval', () => {
  /**
   * The headline claim: a query naming something exactly finds it **even when the embedding
   * returns nothing at all**. Program codes, school names and figures are precisely what a
   * bi-encoder is worst at, and this half costs zero neurons.
   */
  it('finds a chunk by keyword when vector search misses it entirely', async () => {
    const chunkId = await seedChunk(
      'The BSCS program at Saint Louis College requires the STEM strand.',
    );
    const { service } = harness({ matches: [] });

    const retrieved = await service.retrieve('BSCS at Saint Louis College');

    expect(retrieved.map(({ chunk }) => chunk.id)).toContain(chunkId);
  });

  it('passes a metadata filter to Vectorize when a target entity is named', async () => {
    const careerId = uuid();

    await seedChunk('Nurses work in hospitals and clinics.', { type: 'career', id: careerId });

    const { service, recorded } = harness({ matches: [] });

    await service.retrieve('nursing', { entity: { type: 'career', id: careerId } });

    expect(recorded.filters[0]).toEqual({ entity_type: 'career', entity_id: careerId });
  });

  /**
   * The filter has to constrain the keyword half too. Vectorize filters inside the index; D1 has
   * to be told separately, and a keyword hit from a different program would walk straight past a
   * filter that only existed on the vector side.
   */
  it('constrains the keyword half to the same entity', async () => {
    const wanted = uuid();
    const other = uuid();

    const mine = await seedChunk('Radiologic Technology admits STEM strand applicants.', {
      type: 'program',
      id: wanted,
    });
    const theirs = await seedChunk('Radiologic Technology is also offered elsewhere.', {
      type: 'program',
      id: other,
    });

    const { service } = harness({ matches: [] });

    const retrieved = await service.retrieve('Radiologic Technology', {
      entity: { type: 'program', id: wanted },
    });

    const ids = retrieved.map(({ chunk }) => chunk.id);

    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
  });

  it('honours the limit, so the two-pass caller can split the context block', async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedChunk(`Scholarship guidance passage number ${i} about financial assistance.`);
    }

    const { service } = harness({ matches: [] });

    const retrieved = await service.retrieve('scholarship financial assistance', { limit: 2 });

    expect(retrieved.length).toBeLessThanOrEqual(2);
  });
});

describe('the KV embedding cache', () => {
  /**
   * A class of forty asking the same five questions is the normal load, and a string's embedding
   * never changes — so this is a high hit rate against a hard daily neuron budget, with no
   * staleness risk to trade against it.
   */
  it('embeds a repeated question once', async () => {
    await seedChunk('Guidance about choosing a senior high school strand.');

    const { service, recorded } = harness({ matches: [], cache: env.KV });

    await service.retrieve('which strand should I choose');
    await service.retrieve('which strand should I choose');

    expect(recorded.embedCalls).toHaveLength(1);
  });

  it('still retrieves when the cache throws — an optimisation must not break the request', async () => {
    const chunkId = await seedChunk('Enrolment for the first semester opens in May.');

    const broken = {
      get: async () => {
        throw new Error('KV unavailable');
      },
      put: async () => {
        throw new Error('KV unavailable');
      },
    } as unknown as KVNamespace;

    const { service, recorded } = harness({ matches: [], cache: broken });

    const retrieved = await service.retrieve('when does enrolment open');

    expect(retrieved.map(({ chunk }) => chunk.id)).toContain(chunkId);
    expect(recorded.embedCalls).toHaveLength(1);
  });
});

describe('the FTS index tracks its table', () => {
  /**
   * External-content FTS5 stores only the index, so it is a projection of the table kept in step
   * by triggers. Ingestion replaces a document's chunks wholesale on **every** reprocess, so the
   * delete trigger is not an edge case — it fires on every re-run, and an index that missed it
   * would keep answering students from wording that no longer exists anywhere.
   */
  it('stops matching a chunk that has been deleted', async () => {
    const chunkId = await seedChunk('Kinesiology electives include biomechanics coursework.');
    const { service } = harness({ matches: [] });

    await expect(service.retrieve('biomechanics coursework')).resolves.toHaveLength(1);

    await db().delete(knowledgeChunks).where(eq(knowledgeChunks.id, chunkId));

    await expect(service.retrieve('biomechanics coursework')).resolves.toEqual([]);
  });

  it('matches the new wording after a chunk is updated, not the old', async () => {
    const chunkId = await seedChunk('The seminar covers photogrammetry fundamentals.');
    const { service } = harness({ matches: [] });

    await db()
      .update(knowledgeChunks)
      .set({ content: 'The seminar covers hydrogeology fundamentals.' })
      .where(eq(knowledgeChunks.id, chunkId));

    await expect(service.retrieve('photogrammetry')).resolves.toEqual([]);
    await expect(service.retrieve('hydrogeology')).resolves.toHaveLength(1);
  });
});

describe('stemming, so both sides agree on what a word is', () => {
  /**
   * Migration 0027. Phase 0's acceptance run measured three failures out of twenty real student
   * questions, and all three were one defect: `unicode61` matches whole tokens, so the corpus
   * saying *nursing*, *Architect* and *computer* was invisible to a student typing *nurse*,
   * *architects* and *computers*. Not one was a coverage gap — the passages existed and said the
   * right thing.
   *
   * These run with the vector half returning nothing, which is deliberate: the embeddings cover
   * this class of miss too, and a test that let them help would pass whether or not the tokenizer
   * was ever fixed. The keyword half has to stand on its own here, exactly as it did when the
   * three failures were measured against production.
   */
  it.each([
    ['nursing', 'A career in nursing means working in hospitals and clinics.', 'nurse'],
    [
      'plural noun',
      'The Architect designs buildings and supervises construction.',
      'architects',
    ],
    ['plural noun', 'Programmers work with a computer for most of the day.', 'computers'],
  ])(
    'matches a %s passage against the wording a student actually types',
    async (_label, passage, question) => {
      const chunkId = await seedChunk(passage);
      const { service } = harness({ matches: [] });

      const retrieved = await service.retrieve(question);

      expect(retrieved.map(({ chunk }) => chunk.id)).toContain(chunkId);
    },
  );

  /**
   * The half of the trade that had to be measured rather than assumed. Porter's rules key off
   * English suffixes, and this is the specific word the plan named as the thing that must not
   * break — the students this corpus serves ask *magkano* far more often than they ask *how
   * much*.
   */
  it('leaves a Filipino query alone', async () => {
    const chunkId = await seedChunk(
      'Magkano ang tuition sa BS Nutrition? Ito ay 45,000 pesos.',
    );
    const { service } = harness({ matches: [] });

    const retrieved = await service.retrieve('magkano ang tuition');

    expect(retrieved.map(({ chunk }) => chunk.id)).toContain(chunkId);
  });

  /**
   * Stemming widens what a token matches, so the thing worth pinning is that it does not widen it
   * to everything. A stemmer that folded unrelated roots together would show up here and nowhere
   * else until a student read the answer.
   */
  it('does not fold unrelated words into each other', async () => {
    await seedChunk('The dentistry programme requires a licensure examination.');
    const { service } = harness({ matches: [] });

    await expect(service.retrieve('astronomy')).resolves.toEqual([]);
  });
});

describe('the archive guarantee, under hybrid retrieval', () => {
  /**
   * §13.7's promise is that archiving puts content beyond the AI's reach, and §30 records *how*:
   * archiving deletes the chunks' vectors from Vectorize, so archived content "cannot match in the
   * first place" — an exclusion that is structural rather than a WHERE clause someone can forget.
   *
   * Phase 2 added a second retrieval path that reads `knowledge_chunks` **directly**, and the
   * chunk rows deliberately survive archiving (they are referenced by `ai_requests` for
   * provenance). So the structural exclusion covers only half of retrieval now, and the keyword
   * half needs the WHERE clause the original design was right to avoid needing.
   */
  it('does not return chunks belonging to an archived document', async () => {
    const chunkId = await seedChunk('Withdrawn policy: the entrance exam fee was 500 pesos.');

    await db()
      .update(knowledgeDocuments)
      .set({ archivedAt: now() })
      .where(
        eq(
          knowledgeDocuments.id,
          (
            await db()
              .select({ documentId: knowledgeChunks.documentId })
              .from(knowledgeChunks)
              .where(eq(knowledgeChunks.id, chunkId))
          )[0]!.documentId,
        ),
      );

    const { service } = harness({ matches: [] });

    await expect(service.retrieve('entrance exam fee')).resolves.toEqual([]);
  });
});

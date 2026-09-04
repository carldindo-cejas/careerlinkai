/* eslint-disable @typescript-eslint/require-await -- async-interface stubs have nothing to await */
import { beforeAll, describe, expect, it } from 'vitest';

import { knowledgeChunks, knowledgeDocuments } from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import {
  AiGatewayService,
  BGE_QUERY_PREFIX,
  type WorkersAiClient,
} from '@/modules/ai/ai-gateway-service';
import {
  RETRIEVAL_CANDIDATE_K,
  RETRIEVAL_SIMILARITY_THRESHOLD,
  RETRIEVAL_TOP_K,
  RetrievalService,
} from '@/modules/ai/retrieval-service';
import type { VectorStore } from '@/modules/ai/vector-store';
import { createStaffUser, db, type StaffUserFixture } from '../helpers';

/**
 * `RetrievalService` against stubs — Workers AI and Vectorize are the two bindings the test
 * config deletes, so the seam *is* the test (§49).
 *
 * What is asserted here is exactly what AiNormalisation Phase 0 changed, and each assertion
 * exists because the defect it guards was **silent**: a query embedded as a passage, a floor
 * above where the model scores, a candidate set too narrow to rerank. None of those produced an
 * error — they produced an empty result set and a `NO_GROUNDING` refusal that read like correct
 * behaviour.
 */

let admin: StaffUserFixture;

beforeAll(async () => {
  admin = await createStaffUser({ role: 'admin' });
});

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

interface Recorded {
  embedded: string[];
  rerankQueries: string[];
  topK: number | null;
}

function harness(options: {
  matches: { id: string; score: number }[];
  /** Rerank output, as `{ id, score }` pairs over the supplied contexts; `null` = model absent. */
  rerank?: { id: number; score: number }[] | 'throws' | null;
  threshold?: number;
}) {
  const database = db();
  const recorded: Recorded = { embedded: [], rerankQueries: [], topK: null };

  const client: WorkersAiClient = {
    run: async (model, inputs) => {
      if (model === 'stub-rerank') {
        recorded.rerankQueries.push(inputs.query as string);

        if (options.rerank === 'throws') {
          throw new Error('reranker exploded');
        }

        return { response: options.rerank };
      }

      recorded.embedded.push(...(inputs.text as string[]));

      return { data: (inputs.text as string[]).map(() => [0.1, 0.2]) };
    },
  };

  const vectors: VectorStore = {
    upsert: async () => undefined,
    query: async (_vector, queryOptions) => {
      recorded.topK = queryOptions.topK;

      return { matches: options.matches };
    },
    deleteByIds: async () => undefined,
  };

  const gateway = new AiGatewayService(database, client, {
    text: 'stub-text',
    embedding: 'stub-embed',
    rerank: options.rerank === null ? undefined : 'stub-rerank',
  });

  return {
    service: new RetrievalService(database, gateway, vectors, options.threshold),
    recorded,
  };
}

describe('RetrievalService', () => {
  it('embeds the query with the BGE retrieval prefix, and reranks on the bare text (D3)', async () => {
    const ids = [
      await seedChunk('Tuition at the college is PHP 25,000 per semester.'),
      await seedChunk('Enrolment opens in May for the first semester.'),
    ];
    const { service, recorded } = harness({
      matches: ids.map((id) => ({ id, score: 0.61 })),
      rerank: [{ id: 0, score: 0.88 }],
    });

    await service.retrieve('how much is tuition');

    expect(recorded.embedded).toEqual([`${BGE_QUERY_PREFIX}how much is tuition`]);
    // The cross-encoder reads the query as written; the prefix is an instruction to the
    // *bi-encoder* and would be noise here.
    expect(recorded.rerankQueries).toEqual(['how much is tuition']);
  });

  it('keeps matches the old 0.75 floor would have thrown away (D2)', async () => {
    const chunkId = await seedChunk('Nursing graduates work in hospitals and community clinics.');
    const { service } = harness({
      matches: [{ id: chunkId, score: 0.62 }],
      rerank: [{ id: 0, score: 0.9 }],
    });

    expect(RETRIEVAL_SIMILARITY_THRESHOLD).toBeLessThan(0.75);
    await expect(service.retrieve('nursing careers')).resolves.toHaveLength(1);
  });

  it('asks Vectorize for a wide candidate set, not the context size', async () => {
    const chunkId = await seedChunk('A passage.');
    const { service, recorded } = harness({
      matches: [{ id: chunkId, score: 0.7 }],
      rerank: [{ id: 0, score: 0.8 }],
    });

    await service.retrieve('anything');

    expect(recorded.topK).toBe(RETRIEVAL_CANDIDATE_K);
    expect(RETRIEVAL_CANDIDATE_K).toBeGreaterThan(RETRIEVAL_TOP_K);
  });

  it('returns the reranked order, cut to the context size, carrying the rerank scores', async () => {
    const ids = [
      await seedChunk('First seeded passage about strands.'),
      await seedChunk('Second seeded passage about salaries.'),
      await seedChunk('Third seeded passage about admissions.'),
    ];
    const { service } = harness({
      // Vector similarity likes the first chunk most; the cross-encoder disagrees.
      matches: ids.map((id, index) => ({ id, score: 0.7 - index * 0.05 })),
      rerank: [
        { id: 2, score: 0.95 },
        { id: 0, score: 0.4 },
        { id: 1, score: 0.1 },
      ],
    });

    // Deliberately nonsense, sharing no word with anything this file seeds: retrieval is hybrid
    // since Phase 2, so a keyword hit — on a passage from another test in this same file — would
    // reorder the very candidate list this test exists to hold still. What is under test here is
    // the reranker's ordering, and the vector stub supplies every candidate for it to order.
    const retrieved = await service.retrieve('quantum metallurgy apprenticeship');

    expect(retrieved.map(({ chunk }) => chunk.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect(retrieved[0]!.score).toBe(0.95);
  });

  it('falls back to similarity order when the reranker is unavailable or fails', async () => {
    const ids = [await seedChunk('Alpha passage.'), await seedChunk('Beta passage.')];
    const matches = [
      { id: ids[0]!, score: 0.8 },
      { id: ids[1]!, score: 0.6 },
    ];

    for (const rerank of ['throws', null] as const) {
      const { service } = harness({ matches, rerank });
      const retrieved = await service.retrieve('alpha');

      // Degraded ordering, never a failed retrieval: the candidates were already found.
      expect(retrieved.map(({ chunk }) => chunk.id)).toEqual(ids);
    }
  });

  it('honours a threshold override, so the floor is tunable without a deploy', async () => {
    const chunkId = await seedChunk('A passage scoring in the middle.');
    const matches = [{ id: chunkId, score: 0.6 }];

    await expect(
      harness({ matches, rerank: [{ id: 0, score: 0.9 }], threshold: 0.5 }).service.retrieve('q'),
    ).resolves.toHaveLength(1);

    await expect(
      harness({ matches, rerank: [{ id: 0, score: 0.9 }], threshold: 0.9 }).service.retrieve('q'),
    ).resolves.toEqual([]);
  });
});

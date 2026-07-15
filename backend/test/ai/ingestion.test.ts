/* eslint-disable @typescript-eslint/require-await -- async-interface stubs have nothing to await */
import { env, SELF } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createDatabase } from '@/db/client';
import { knowledgeChunks, knowledgeDocuments } from '@/db/schema';
import { AiGatewayService, type WorkersAiClient } from '@/modules/ai/ai-gateway-service';
import { KnowledgeIngestionService } from '@/modules/ai/knowledge-ingestion-service';
import type { VectorRecord, VectorStore } from '@/modules/ai/vector-store';
import { BASE_URL, createStaffUser, db, findUser, login } from '../helpers';

/**
 * The §33 ingestion pipeline. Two layers, tested at two seams:
 *
 *   * **The HTTP surface** runs against the real router, real R2 (Miniflare emulates it)
 *     and the real queue producer — everything that exists locally.
 *   * **The processing pipeline** runs against a stubbed gateway and vector store, because
 *     Workers AI and Vectorize have no local emulation at all. What the stubs let us pin is
 *     precisely what the deploy would otherwise discover first: the §33 batching shape —
 *     one embed call and one upsert per ≤100 chunks (the 50-subrequest ceiling, §45).
 */

// ~40k chars of clean prose → a comfortably multi-chunk document.
const LONG_TEXT = Array.from(
  { length: 400 },
  (_, i) =>
    `Paragraph ${i}: The RIASEC model describes six interest dimensions that guide career exploration and program selection for senior high school students.`,
).join('\n\n');

function stubVectors() {
  const upserts: VectorRecord[][] = [];
  const deleted: string[][] = [];

  const store: VectorStore = {
    upsert: async (vectors) => {
      upserts.push(vectors);
    },
    query: async () => ({ matches: [] }),
    deleteByIds: async (ids) => {
      deleted.push(ids);
    },
  };

  return { store, upserts, deleted };
}

function stubEmbedder() {
  const calls: number[] = [];

  const client: WorkersAiClient = {
    run: async (_model, inputs) => {
      const texts = inputs.text as string[];

      calls.push(texts.length);

      return { data: texts.map(() => [0.5, 0.5, 0.5]) };
    },
  };

  return { client, calls };
}

/** The service wired with stubs and NO queue — the pipeline runs inline, start to finish. */
function inlineService(vectors: VectorStore, client: WorkersAiClient) {
  const database = db();

  return new KnowledgeIngestionService(
    database,
    env.STORAGE,
    new AiGatewayService(database, client, { text: 't', embedding: 'e' }),
    vectors,
    undefined,
  );
}

async function uploadOverHttp(token: string, options: { name?: string; text?: string } = {}) {
  const form = new FormData();

  form.append(
    'file',
    new File([new Uint8Array([37, 80, 68, 70])], options.name ?? 'riasec-theory.pdf', {
      type: 'application/pdf',
    }),
  );
  form.append('extracted_text', options.text ?? LONG_TEXT);

  const response = await SELF.fetch(`${BASE_URL}/admin/knowledge-documents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  return { status: response.status, body: (await response.json()) as any };
}

describe('POST /admin/knowledge-documents (§33 — browser-extracted text, raw file for provenance)', () => {
  it('accepts an upload: UPLOADED row, raw file AND text sidecar in R2, processing queued', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);

    const { status, body } = await uploadOverHttp(token);

    expect(status).toBe(201);
    expect(body.data).toMatchObject({
      file_name: 'riasec-theory.pdf',
      file_type: 'pdf',
      processing_status: 'UPLOADED',
      visibility: 'GLOBAL',
      archived_at: null,
    });

    const id = body.data.id as string;

    // Provenance: the original bytes are retrievable, and the sidecar carries the exact
    // text the pipeline will chunk — the durable input every re-run reads (§42 v1.5).
    const raw = await env.STORAGE.get(`knowledge/${id}/riasec-theory.pdf`);
    const sidecar = await env.STORAGE.get(`knowledge/${id}/extracted.txt`);

    expect(raw).not.toBeNull();
    await expect(sidecar!.text()).resolves.toBe(LONG_TEXT);
  });

  it('rejects a non-PDF/DOCX file, an oversized text, and an empty text — §34 caps, server-side', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);

    expect((await uploadOverHttp(token, { name: 'notes.txt' })).status).toBe(422);
    expect((await uploadOverHttp(token, { text: '' })).status).toBe(422);
    expect((await uploadOverHttp(token, { text: 'x'.repeat(500_001) })).status).toBe(422);
  });

  it('is admin-only — a counselor gets a flat 403', async () => {
    const counselor = await createStaffUser({ role: 'counselor' });
    const token = await login(counselor);

    expect((await uploadOverHttp(token)).status).toBe(403);
  });
});

describe('the processing pipeline (stubbed gateway + vector store)', () => {
  it('chunks, embeds in ≤100-text batches, upserts once per batch, and completes', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const adminRow = await findUser(admin.id);
    const { store, upserts } = stubVectors();
    const { client, calls } = stubEmbedder();
    const service = inlineService(store, client);

    // No queue bound → upload runs the whole pipeline inline.
    const document = await service.upload(
      adminRow!,
      {
        fileName: 'riasec.pdf',
        fileType: 'pdf',
        fileBytes: new Uint8Array([1]).buffer,
        extractedText: LONG_TEXT,
      },
      null,
    );

    const chunks = await db()
      .select()
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.documentId, document.id));

    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk embedded, vector id = chunk id (the §30 retrieval mapping).
    for (const chunk of chunks) {
      expect(chunk.vectorId).toBe(chunk.id);
    }

    // The §33 batching contract: one AI call per ≤100 chunks, one upsert per batch.
    expect(calls.length).toBe(Math.ceil(chunks.length / 100));
    for (const size of calls) {
      expect(size).toBeLessThanOrEqual(100);
    }
    expect(upserts.length).toBe(calls.length);

    const [row] = await db()
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, document.id));

    expect(row!.processingStatus).toBe('COMPLETED');
  });

  it('re-processing replaces chunks wholesale and removes the old vectors first — idempotent by replacement', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const adminRow = await findUser(admin.id);
    const { store, deleted } = stubVectors();
    const { client } = stubEmbedder();
    const service = inlineService(store, client);

    const document = await service.upload(
      adminRow!,
      { fileName: 'r.pdf', fileType: 'pdf', fileBytes: new Uint8Array([1]).buffer, extractedText: LONG_TEXT },
      null,
    );

    const before = await db()
      .select()
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.documentId, document.id));

    await service.process(document.id);

    const after = await db()
      .select()
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.documentId, document.id));

    // Same text, same chunking (§43): equal count, no duplicates, and the first run's
    // vectors were deleted from the index before the second run's were added.
    expect(after.length).toBe(before.length);
    expect(deleted.flat().sort()).toEqual(before.map((chunk) => chunk.id).sort());
  });

  it('embedBatch skips chunks that already have a vector_id — a redelivered message re-embeds nothing', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const adminRow = await findUser(admin.id);
    const { store } = stubVectors();
    const { client, calls } = stubEmbedder();
    const service = inlineService(store, client);

    const document = await service.upload(
      adminRow!,
      { fileName: 'r.pdf', fileType: 'pdf', fileBytes: new Uint8Array([1]).buffer, extractedText: LONG_TEXT },
      null,
    );

    const chunks = await db()
      .select()
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.documentId, document.id));

    const callsBefore = calls.length;

    await service.embedBatch(
      document.id,
      chunks.map((chunk) => chunk.id),
    );

    expect(calls.length).toBe(callsBefore); // nothing left to embed → no model call
  });

  it('archives without deleting: vectors leave the index, rows stay for provenance (§13.7)', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const adminRow = await findUser(admin.id);
    const { store, deleted } = stubVectors();
    const { client } = stubEmbedder();
    const service = inlineService(store, client);

    const document = await service.upload(
      adminRow!,
      { fileName: 'r.pdf', fileType: 'pdf', fileBytes: new Uint8Array([1]).buffer, extractedText: LONG_TEXT },
      null,
    );

    const archived = await service.archive(adminRow!, document.id, null);

    expect(archived.archivedAt).not.toBeNull();

    const chunks = await db()
      .select()
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.documentId, document.id));

    // Structurally unretrievable (§30): every vector deleted…
    expect(deleted.flat().sort()).toEqual(chunks.map((chunk) => chunk.id).sort());
    // …while the rows survive, because ai_requests.input_context points at chunk ids.
    expect(chunks.length).toBeGreaterThan(0);

    // And an archived document refuses to re-enter the index.
    await expect(service.reprocess(adminRow!, document.id, null)).rejects.toMatchObject({
      status: 422,
    });
  });
});

describe('GET /admin/knowledge-documents', () => {
  it('lists documents with the nested pagination envelope and chunk counts', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const { body } = await uploadOverHttp(token);

    const response = await SELF.fetch(`${BASE_URL}/admin/knowledge-documents?per_page=100`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const list = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(list.data.pagination).toMatchObject({ current_page: 1, per_page: 100 });

    const mine = list.data.items.find((item: any) => item.id === body.data.id);

    expect(mine).toMatchObject({ file_name: 'riasec-theory.pdf', processing_status: 'UPLOADED' });
  });
});

describe('DELETE /admin/knowledge-documents/{id}', () => {
  it('archives over HTTP — 200 with archived_at set, never a hard delete', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const { body } = await uploadOverHttp(token);
    const id = body.data.id as string;

    const response = await SELF.fetch(`${BASE_URL}/admin/knowledge-documents/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    const archived = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(archived.data.archived_at).not.toBeNull();

    // The row is still there — archive, don't delete (Part I principle #4).
    const rows = await createDatabase(env.DB)
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, id));

    expect(rows).toHaveLength(1);
  });
});

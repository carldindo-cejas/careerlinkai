/* eslint-disable @typescript-eslint/require-await -- async-interface stubs have nothing to await */
import { env, SELF } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createDatabase } from '@/db/client';
import { auditLogs, knowledgeChunks, knowledgeDocuments } from '@/db/schema';
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
      title: 'riasec-theory.pdf',
      file_name: 'riasec-theory.pdf',
      source_type: 'pdf',
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

  it('rejects an unsupported extension, an oversized text, and an empty text — §34 caps, server-side', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);

    expect((await uploadOverHttp(token, { name: 'notes.rtf' })).status).toBe(422);
    expect((await uploadOverHttp(token, { text: '' })).status).toBe(422);
    expect((await uploadOverHttp(token, { text: 'x'.repeat(500_001) })).status).toBe(422);
  });

  /**
   * `.txt` and `.md` cost nothing to accept — the browser reads them with `File.text()`, so no
   * parser exists on either side — and they are the format a school's existing handouts are most
   * likely to already be in (AiNormalisation Phase 1). Both land as `text`: the extension said
   * how to read the file, not what kind of knowledge it holds.
   */
  it('accepts .txt and .md as source_type "text"', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);

    for (const name of ['handbook.txt', 'faq.md']) {
      const { status, body } = await uploadOverHttp(token, { name });

      expect(status).toBe(201);
      expect(body.data.source_type).toBe('text');
    }
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
        sourceType: 'pdf',
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

  /**
   * AiNormalisation Phase 2. A vector's only metadata used to be `{ document_id }`, so when
   * explaining one program there was no way to prefer chunks *about that program* — it competed
   * against the whole corpus on cosine distance alone.
   *
   * The chunk row and the vector must carry the **same** three values: the keyword half of hybrid
   * retrieval filters on the row, the vector half filters inside Vectorize, and two subtly
   * different definitions of "about this program" would make the two halves disagree.
   */
  it('carries source and entity metadata onto both the chunk rows and the vectors', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const adminRow = await findUser(admin.id);
    const { store, upserts } = stubVectors();
    const { client } = stubEmbedder();
    const service = inlineService(store, client);

    const { document } = await service.upsertCatalogEntry(adminRow!.id, {
      entityType: 'career',
      entityId: 'career-metadata-fixture',
      title: 'Career: Radiologic Technologist',
      body: 'Career: Radiologic Technologist.\nOperates imaging equipment in hospitals.',
      contentHash: 'fixture-hash',
    });

    const chunks = await db()
      .select()
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.documentId, document.id));

    expect(chunks[0]).toMatchObject({
      sourceType: 'catalog',
      entityType: 'career',
      entityId: 'career-metadata-fixture',
    });

    expect(upserts.at(-1)![0]!.metadata).toEqual({
      document_id: document.id,
      source_type: 'catalog',
      entity_type: 'career',
      entity_id: 'career-metadata-fixture',
    });
  });

  /**
   * Vectorize metadata is string-valued, so an absent entity must be **absent**, not `''`. An
   * empty string would make "has no entity" a value an equality filter could match, which is the
   * wrong answer to "is this chunk about a career?".
   */
  it('omits entity metadata entirely for an entry that is not about a catalog row', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const adminRow = await findUser(admin.id);
    const { store, upserts } = stubVectors();
    const { client } = stubEmbedder();
    const service = inlineService(store, client);

    await service.createEntry(
      adminRow!,
      { sourceType: 'text', title: 'General guidance', body: 'Choosing a strand is a decision about interests, not only grades.' },
      null,
    );

    const metadata = upserts.at(-1)![0]!.metadata!;

    expect(metadata.source_type).toBe('text');
    expect(metadata).not.toHaveProperty('entity_type');
    expect(metadata).not.toHaveProperty('entity_id');
  });

  it('re-processing replaces chunks wholesale and removes the old vectors first — idempotent by replacement', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const adminRow = await findUser(admin.id);
    const { store, deleted } = stubVectors();
    const { client } = stubEmbedder();
    const service = inlineService(store, client);

    const document = await service.upload(
      adminRow!,
      { fileName: 'r.pdf', sourceType: 'pdf', fileBytes: new Uint8Array([1]).buffer, extractedText: LONG_TEXT },
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
      { fileName: 'r.pdf', sourceType: 'pdf', fileBytes: new Uint8Array([1]).buffer, extractedText: LONG_TEXT },
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
      { fileName: 'r.pdf', sourceType: 'pdf', fileBytes: new Uint8Array([1]).buffer, extractedText: LONG_TEXT },
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

  /**
   * Search and the status filter (audit F4). The status one is the useful half: a document stuck in
   * `PROCESSING`, or one that came back `FAILED`, contributes nothing to retrieval and is
   * indistinguishable from a healthy document in a list ordered by upload date.
   */
  it('filters by file name and by processing status', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);

    const holland = await uploadOverHttp(token, { name: 'holland-codes.pdf' });
    const scct = await uploadOverHttp(token, { name: 'scct-overview.pdf' });

    // One of the two is marked FAILED directly: the only route to that state is the queue
    // consumer, and this is a test of the list, not of the pipeline.
    await db()
      .update(knowledgeDocuments)
      .set({ processingStatus: 'FAILED' })
      .where(eq(knowledgeDocuments.id, scct.body.data.id));

    async function list(query: string): Promise<any> {
      const response = await SELF.fetch(`${BASE_URL}/admin/knowledge-documents?${query}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      return ((await response.json()) as any).data;
    }

    const byName = await list('search=holland');

    expect(byName.items.map((item: any) => item.id)).toEqual([holland.body.data.id]);
    expect(byName.pagination.total).toBe(1);

    const failed = await list('status=FAILED');

    expect(failed.items.map((item: any) => item.file_name)).toEqual(['scct-overview.pdf']);

    // Both filters at once — earlier tests in this file left their own UPLOADED documents behind
    // (isolation is per file), so an unscoped status query would be reading those. Composing the
    // two is the assertion worth making anyway: they must AND, not replace one another.
    const uploaded = await list('search=scct&status=UPLOADED');

    expect(uploaded.items).toEqual([]);

    const uploadedHolland = await list('search=holland&status=UPLOADED');

    expect(uploadedHolland.items.map((item: any) => item.file_name)).toEqual(['holland-codes.pdf']);

    // The chunk count still belongs to the document it is reported against — the filter narrows the
    // rows, and the GROUP BY that produces the count has to narrow with them.
    expect(failed.items[0].chunk_count).toBe(0);
  });

  it('rejects a processing status that is not one of the four', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);

    const response = await SELF.fetch(`${BASE_URL}/admin/knowledge-documents?status=STUCK`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(422);
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

/**
 * The live/archived split (prompt-driven).
 *
 * Archived entries used to sit in the same list as live ones, so the question the page exists to
 * answer — *what can the AI actually answer from?* — could not be answered by looking at it. The
 * default is now the live half, which is a behaviour change and the one worth pinning: a caller
 * that asks for nothing must not be shown retired content.
 */
describe('GET /admin/knowledge-documents — the live/archived split', () => {
  it('defaults to live entries and hides archived ones', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);

    await uploadOverHttp(token, { name: 'still-in-use.pdf' });

    const retired = await uploadOverHttp(token, { name: 'retired.pdf' });

    await SELF.fetch(`${BASE_URL}/admin/knowledge-documents/${retired.body.data.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });

    async function list(query: string): Promise<any> {
      const response = await SELF.fetch(
        `${BASE_URL}/admin/knowledge-documents?per_page=100&${query}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      return ((await response.json()) as any).data;
    }

    const byDefault = await list('');
    const names = byDefault.items.map((item: any) => item.file_name);

    expect(names).toContain('still-in-use.pdf');
    expect(names).not.toContain('retired.pdf');

    const archived = await list('archived=archived');
    const archivedNames = archived.items.map((item: any) => item.file_name);

    expect(archivedNames).toContain('retired.pdf');
    expect(archivedNames).not.toContain('still-in-use.pdf');

    // Each half paginates over its own total, or the two tabs would disagree about how many pages
    // they have — which is how a pager ends up offering a page that renders empty.
    expect(byDefault.pagination.total).toBeGreaterThanOrEqual(1);
    expect(archived.pagination.total).toBeGreaterThanOrEqual(1);

    const all = await list('archived=all');
    const allNames = all.items.map((item: any) => item.file_name);

    expect(allNames).toContain('still-in-use.pdf');
    expect(allNames).toContain('retired.pdf');
  });

  it('rejects a value that is not one of the three', async () => {
    const token = await login(await createStaffUser({ role: 'admin' }));

    const response = await SELF.fetch(`${BASE_URL}/admin/knowledge-documents?archived=maybe`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(422);
  });

  it('unarchived live entries keep their chunk counts under the filter', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const { body } = await uploadOverHttp(token, { name: 'counted.pdf' });

    const response = await SELF.fetch(
      `${BASE_URL}/admin/knowledge-documents?per_page=100&archived=live`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const list = (await response.json()) as any;
    const mine = list.data.items.find((item: any) => item.id === body.data.id);

    // The GROUP BY that produces the count has to narrow with the new predicate, same as it does
    // for search and status.
    expect(mine).toMatchObject({ file_name: 'counted.pdf', chunk_count: 0 });
  });
});

/**
 * **Permanent removal** (prompt-driven) — the second button, and the one that cannot be undone.
 *
 * Archiving is the everyday act and stays the default; this exists because "we keep everything
 * forever" is not an answer to a bad paste, a document somebody was not entitled to upload, or a
 * request to delete personal data. Three things are worth pinning, and each fails quietly:
 *
 *   1. **It refuses a live entry.** Removal is always the second of two deliberate decisions about
 *      something already out of service — never one click on something students are being answered
 *      from right now.
 *   2. **Everything goes**: the row, its chunks, and its vectors.
 *   3. **Questions it answered come back.** Their answer no longer exists, so the gap is real
 *      again, and the backlog growing with no explanation is how this report lost trust before.
 */
describe('DELETE /admin/knowledge-documents/{id}/permanently', () => {
  async function removePermanently(token: string, id: string) {
    const response = await SELF.fetch(
      `${BASE_URL}/admin/knowledge-documents/${id}/permanently`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    );

    return { status: response.status, body: (await response.json()) as any };
  }

  it('refuses an entry that has not been archived first', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const { body } = await uploadOverHttp(token);

    const refused = await removePermanently(token, body.data.id);

    expect(refused.status).toBe(422);
    expect(refused.body.errors.document[0]).toMatch(/Archive this entry before removing it/i);

    // Still there, and still exactly as it was.
    const rows = await createDatabase(env.DB)
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, body.data.id));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.archivedAt).toBeNull();
  });

  it('destroys the row and its chunks once it is archived', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const { body } = await uploadOverHttp(token);
    const id = body.data.id as string;

    await SELF.fetch(`${BASE_URL}/admin/knowledge-documents/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });

    const removed = await removePermanently(token, id);

    expect(removed.status).toBe(200);
    expect(removed.body.message).toMatch(/gone for good/i);

    const database = createDatabase(env.DB);

    expect(
      await database.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, id)),
    ).toHaveLength(0);
    expect(
      await database.select().from(knowledgeChunks).where(eq(knowledgeChunks.documentId, id)),
    ).toHaveLength(0);
  });

  it('is gone from both halves of the list afterwards', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const { body } = await uploadOverHttp(token, { name: 'destroyed.pdf' });
    const id = body.data.id as string;

    await SELF.fetch(`${BASE_URL}/admin/knowledge-documents/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    await removePermanently(token, id);

    const response = await SELF.fetch(
      `${BASE_URL}/admin/knowledge-documents?per_page=100&archived=all`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const list = (await response.json()) as any;

    expect(list.data.items.map((item: any) => item.file_name)).not.toContain('destroyed.pdf');
  });

  it('records what was destroyed, since nothing else survives to describe it', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const { body } = await uploadOverHttp(token, { name: 'audited.pdf' });
    const id = body.data.id as string;

    await SELF.fetch(`${BASE_URL}/admin/knowledge-documents/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    await removePermanently(token, id);

    const rows = await createDatabase(env.DB)
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetId, id));
    const deletion = rows.find((row) => row.action === 'KNOWLEDGE_DOCUMENT_DELETED');

    expect(deletion).toBeDefined();
    expect(deletion!.userId).toBe(admin.id);
    // The title and source, never the text: an audit log is not a place to reconstitute content
    // somebody asked to have deleted.
    expect(deletion!.oldValues).toMatchObject({ title: 'audited.pdf', source_type: 'pdf' });
  });

  it('is refused for a counselor who does not own the entry', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const adminToken = await login(admin);
    const { body } = await uploadOverHttp(adminToken);
    const id = body.data.id as string;

    await SELF.fetch(`${BASE_URL}/admin/knowledge-documents/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    const counselorToken = await login(await createStaffUser({ role: 'counselor' }));
    const response = await SELF.fetch(
      `${BASE_URL}/counselor/knowledge-documents/${id}/permanently`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${counselorToken}` } },
    );

    expect(response.status).toBe(404);

    // And it is still there — a refused removal must not half-happen.
    expect(
      await createDatabase(env.DB)
        .select()
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.id, id)),
    ).toHaveLength(1);
  });
});

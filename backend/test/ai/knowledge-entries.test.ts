/* eslint-disable @typescript-eslint/require-await -- async-interface stubs have nothing to await */
import { env, SELF } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { knowledgeChunks, knowledgeDocuments } from '@/db/schema';
import { AiGatewayService, type WorkersAiClient } from '@/modules/ai/ai-gateway-service';
import { syncCatalogKnowledge } from '@/modules/ai/catalog-knowledge-service';
import { KnowledgeIngestionService } from '@/modules/ai/knowledge-ingestion-service';
import type { VectorStore } from '@/modules/ai/vector-store';
import {
  api,
  BASE_URL,
  createCareer,
  createCollege,
  createProgram,
  createStaffUser,
  db,
  findUser,
  login,
} from '../helpers';

/**
 * **Knowledge an admin writes** (AiNormalisation Phase 1) — pasted notes, Q&A pairs, editing in
 * place, and the catalog auto-sync.
 *
 * The measurement behind this whole surface: on 2026-09-04 the production corpus held **zero
 * documents and had never held one**. Upload-only was not one bottleneck among several — it was
 * the reason the §30 pipeline had nothing to retrieve and refused on every question. So what is
 * asserted here is not decoration on an existing feature; it is whether knowledge can enter the
 * system at all without somebody first producing a PDF.
 *
 * The HTTP layer runs against the real router and real R2 (Miniflare emulates it). Chunking and
 * embedding run against stubs, because Workers AI and Vectorize have no local emulation.
 */

function stubbedService() {
  const database = db();
  const client: WorkersAiClient = {
    run: async (_model, inputs) => ({
      data: (inputs.text as string[]).map(() => [0.5, 0.5, 0.5]),
    }),
  };
  const vectors: VectorStore = {
    upsert: async () => undefined,
    query: async () => ({ matches: [] }),
    deleteByIds: async () => undefined,
  };

  // No queue → the pipeline runs inline, so one call covers create → chunk → embed → COMPLETED.
  return new KnowledgeIngestionService(
    database,
    env.STORAGE,
    new AiGatewayService(database, client, { text: 't', embedding: 'e' }),
    vectors,
    undefined,
  );
}

async function chunksOf(documentId: string) {
  return db()
    .select()
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.documentId, documentId));
}

describe('POST /admin/knowledge-entries — writing knowledge instead of uploading it', () => {
  it('stores a Q&A pair as one passage carrying both halves', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);

    const response = await api('POST', '/admin/knowledge-entries', {
      token,
      body: {
        type: 'qa',
        question: 'How much is tuition for BS Nursing?',
        answer: 'Tuition for BS Nursing is approximately PHP 25,000 per semester for AY 2026-2027.',
      },
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      title: 'How much is tuition for BS Nursing?',
      source_type: 'qa',
      processing_status: 'UPLOADED',
      visibility: 'GLOBAL',
    });

    /**
     * Both halves in one passage. A question embedded without its answer retrieves the question
     * back, which is not knowledge — and the pairing is what lets the answer eventually be
     * returned to a student word for word.
     */
    const sidecar = await env.STORAGE.get(`knowledge/${response.body.data.id}/extracted.txt`);

    await expect(sidecar!.text()).resolves.toBe(
      'Q: How much is tuition for BS Nursing?\nA: Tuition for BS Nursing is approximately PHP 25,000 per semester for AY 2026-2027.',
    );
  });

  it('stores a pasted note with no file behind it — storage_path stays NULL', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);

    const response = await api('POST', '/admin/knowledge-entries', {
      token,
      body: {
        type: 'text',
        title: 'Admissions requirements 2026',
        body: 'Applicants submit Form 138, a birth certificate and two ID photos before 30 April.',
      },
    });

    expect(response.status).toBe(201);

    const [row] = await db()
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, response.body.data.id as string));

    // The point of migration 0022: a row no longer needs an R2 object to exist.
    expect(row!.storagePath).toBeNull();
    expect(row!.sourceType).toBe('text');
  });

  it('rejects a mixed shape rather than half-saving it', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);

    // `.strict()` on each arm: a `body` sent alongside a `question` is a 422, not a silent drop.
    const response = await api('POST', '/admin/knowledge-entries', {
      token,
      body: { type: 'qa', question: 'What is RIASEC?', answer: 'Six interests.', body: 'extra' },
    });

    expect(response.status).toBe(422);
  });

  it('caps a Q&A answer so the pair stays one chunk', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);

    const response = await api('POST', '/admin/knowledge-entries', {
      token,
      body: { type: 'qa', question: 'A real question?', answer: 'x'.repeat(1201) },
    });

    expect(response.status).toBe(422);
  });

  it('is admin-only', async () => {
    const counselor = await createStaffUser({ role: 'counselor' });
    const token = await login(counselor);

    const response = await api('POST', '/admin/knowledge-entries', {
      token,
      body: { type: 'text', title: 'Sneaking this in', body: 'Not allowed.' },
    });

    expect(response.status).toBe(403);
  });

  /**
   * The shape claim the caps exist to guarantee: a Q&A pair at the size limits still embeds as a
   * single passage. Half an answer retrievable without the other half is the exact failure the
   * §33 overlap exists to prevent, reintroduced at the source.
   */
  it('chunks a maximum-length Q&A pair into exactly one chunk', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const adminRow = await findUser(admin.id);
    const service = stubbedService();

    const document = await service.createEntry(
      adminRow!,
      {
        sourceType: 'qa',
        title: 'q'.repeat(300),
        body: `Q: ${'q'.repeat(300)}\nA: ${'a'.repeat(1200)}`,
      },
      null,
    );

    expect(await chunksOf(document.id)).toHaveLength(1);
  });
});

describe('editing an entry in place', () => {
  it('rewrites the text, re-chunks it, and leaves no trace of the old wording', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const adminRow = await findUser(admin.id);
    const service = stubbedService();

    const document = await service.createEntry(
      adminRow!,
      { sourceType: 'qa', title: 'When does enrolment close?', body: 'Q: When does enrolment close?\nA: Enrolment closes on 15 May.' },
      null,
    );

    await service.updateEntry(
      adminRow!,
      document.id,
      {
        title: 'When does enrolment close?',
        body: 'Q: When does enrolment close?\nA: Enrolment closes on 30 June.',
      },
      null,
    );

    const chunks = await chunksOf(document.id);

    // Replacement, not accumulation: the corrected answer must not sit in the index next to the
    // wrong one, because retrieval would then be free to hand a student either.
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toContain('30 June');
    expect(chunks[0]!.content).not.toContain('15 May');
  });

  /**
   * An uploaded file's text is editable, and the original file is not touched.
   *
   * These used to be refused on the reasoning that the retained original must keep matching what
   * the AI reads. That protected the wrong thing: it protected a **bad transcription** — a PDF
   * whose columns interleaved, a table that came out as word salad — and left "archive it and
   * re-upload" as the only remedy for a typo. The provenance is the file in R2, which stays
   * exactly where it was.
   */
  it('edits an upload\u2019s extracted text while leaving the original file untouched', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const adminRow = await findUser(admin.id);
    const service = stubbedService();

    const uploaded = await service.upload(
      adminRow!,
      {
        fileName: 'guide.pdf',
        sourceType: 'pdf',
        fileBytes: new Uint8Array([1, 2, 3]).buffer,
        extractedText: 'Sem ester one enrolment opens in Ma y.',
      },
      null,
    );

    await service.updateEntry(
      adminRow!,
      uploaded.id,
      { body: 'Semester one enrolment opens in May.' },
      null,
    );

    const chunks = await chunksOf(uploaded.id);

    expect(chunks[0]!.content).toBe('Semester one enrolment opens in May.');

    // Still a PDF entry, and the bytes that were uploaded are still the bytes in storage.
    const [row] = await db()
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, uploaded.id));

    expect(row!.sourceType).toBe('pdf');

    const original = await env.STORAGE.get(row!.storagePath!);

    expect(new Uint8Array(await original!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  /**
   * A catalog entry is editable too, and the edit **survives** — until its career changes.
   *
   * `content_hash` is the sync's fingerprint of the text it last *generated*, not a checksum of
   * the current body, so an untouched career means an untouched entry. That precedence is the
   * right way round: the catalog is the source of truth for what a catalog entry says, and the
   * edit is a stopgap until someone fixes the record itself.
   */
  it('keeps an edited catalog entry until its career changes, then regenerates it', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const adminRow = await findUser(admin.id);
    const token = await login(admin);
    const career = await createCareer(token, { description: 'The generated description.' });

    await syncCatalogKnowledge(db(), env, admin.id);

    const [entry] = await db()
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.entityId, career.id as string));

    const service = stubbedService();

    await service.updateEntry(
      adminRow!,
      entry!.id,
      { body: 'A hand-corrected description of this career.' },
      null,
    );

    // The career has not changed, so the sync leaves the edit alone.
    const untouched = await syncCatalogKnowledge(db(), env, admin.id);

    expect(untouched.changed).toBe(0);

    const kept = await env.STORAGE.get(`knowledge/${entry!.id}/extracted.txt`);

    await expect(kept!.text()).resolves.toContain('hand-corrected');

    // Change the career itself, and the generated text wins.
    await api('PATCH', `/admin/careers/${career.id}`, {
      token,
      body: { description: 'An officially corrected description.' },
    });

    const resynced = await syncCatalogKnowledge(db(), env, admin.id);

    expect(resynced.changed).toBe(1);

    const regenerated = await env.STORAGE.get(`knowledge/${entry!.id}/extracted.txt`);
    const text = await regenerated!.text();

    expect(text).toContain('An officially corrected description.');
    expect(text).not.toContain('hand-corrected');
  });

  it('still refuses to edit an archived entry — archiving is how content leaves the index', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const adminRow = await findUser(admin.id);
    const service = stubbedService();

    const document = await service.createEntry(
      adminRow!,
      { sourceType: 'text', title: 'Withdrawn note', body: 'This guidance was withdrawn.' },
      null,
    );

    await service.archive(adminRow!, document.id, null);

    await expect(
      service.updateEntry(adminRow!, document.id, { body: 'quietly back' }, null),
    ).rejects.toMatchObject({
      status: 422,
      errors: { document: [expect.stringMatching(/archived entry cannot be edited/i)] },
    });
  });

  it('serves the entry text back for the edit form', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);

    const created = await api('POST', '/admin/knowledge-entries', {
      token,
      body: { type: 'text', title: 'Scholarship notes', body: 'The DOST scholarship opens in August.' },
    });

    const response = await SELF.fetch(
      `${BASE_URL}/admin/knowledge-documents/${created.body.data.id}/content`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(200);

    const body = (await response.json()) as any;

    expect(body.data.body).toBe('The DOST scholarship opens in August.');
    expect(body.data.title).toBe('Scholarship notes');
  });
});

describe('catalog auto-sync — the corpus that needs nobody to write it', () => {
  it('writes one entry per career and program, carrying the facts the catalog already holds', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const college = await createCollege(token);
    const program = await createProgram(token, college.id);
    const career = await createCareer(token, {
      description: 'Cares for patients in hospitals and community clinics.',
      salary_min: 25000,
      salary_max: 40000,
    });

    const result = await syncCatalogKnowledge(db(), env, admin.id);

    expect(result.total).toBeGreaterThanOrEqual(2);
    expect(result.changed).toBeGreaterThanOrEqual(2);

    const [careerEntry] = await db()
      .select()
      .from(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.entityType, 'career'),
          eq(knowledgeDocuments.entityId, career.id as string),
        ),
      );

    expect(careerEntry).toBeDefined();
    expect(careerEntry!.sourceType).toBe('catalog');

    const body = await env.STORAGE.get(`knowledge/${careerEntry!.id}/extracted.txt`);
    const text = await body!.text();

    // Prose, not a field dump: this passage is embedded by a bi-encoder and read by an 8B model,
    // and both do better with a sentence than with `salary_min=25000`.
    expect(text).toContain(career.title as string);
    expect(text).toContain('Cares for patients');
    expect(text).toContain('PHP 25,000');

    const [programEntry] = await db()
      .select()
      .from(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.entityType, 'program'),
          eq(knowledgeDocuments.entityId, program.id as string),
        ),
      );

    expect(programEntry).toBeDefined();
  });

  /**
   * The property that makes it safe to leave on a nightly cron with a 10,000-neuron daily
   * budget: a second run over an unchanged catalog does **no work at all** — no rewrite, no
   * re-queue, no re-embedding. Without this the cron would re-embed the whole catalog every
   * night to produce byte-identical vectors.
   */
  it('is a no-op on a second run, and updates rather than duplicates after an edit', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const career = await createCareer(token, { description: 'The original description.' });

    await syncCatalogKnowledge(db(), env, admin.id);

    const second = await syncCatalogKnowledge(db(), env, admin.id);

    expect(second.changed).toBe(0);

    await api('PATCH', `/admin/careers/${career.id}`, {
      token,
      body: { description: 'A corrected description.' },
    });

    const third = await syncCatalogKnowledge(db(), env, admin.id);

    expect(third.changed).toBe(1);

    const entries = await db()
      .select()
      .from(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.entityType, 'career'),
          eq(knowledgeDocuments.entityId, career.id as string),
        ),
      );

    // One entry per career, always — that is what the partial unique index guarantees, and what
    // makes "re-sync" a correction rather than an accumulation.
    expect(entries).toHaveLength(1);

    const body = await env.STORAGE.get(`knowledge/${entries[0]!.id}/extracted.txt`);

    await expect(body!.text()).resolves.toContain('A corrected description.');
  });

  it('leaves an archived catalog entry archived — the admin outranks the sync', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const career = await createCareer(token, { description: 'Some description.' });

    await syncCatalogKnowledge(db(), env, admin.id);

    const [entry] = await db()
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.entityId, career.id as string));

    await api('DELETE', `/admin/knowledge-documents/${entry!.id}`, { token });

    await syncCatalogKnowledge(db(), env, admin.id);

    const [after] = await db()
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, entry!.id));

    // Recreating it nightly would make archiving a catalog entry impossible, which is worse than
    // a stale one: it takes a decision away from the person who made it.
    expect(after!.archivedAt).not.toBeNull();
  });
});

describe('catalog entries follow their subject out of the catalog', () => {
  /**
   * Without this the sync only ever *adds*. Archiving a career stops it being recommended, but its
   * knowledge entry would stay in the index — so the assistant could still describe, price and
   * advise on a career the school deliberately withdrew, citing an entry this system generated.
   */
  it('archives the entry when its career is archived', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const career = await createCareer(token, { description: 'A career about to be withdrawn.' });

    await syncCatalogKnowledge(db(), env, admin.id);

    await api('PATCH', `/admin/careers/${career.id}`, {
      token,
      body: { status: 'archived' },
    });

    const result = await syncCatalogKnowledge(db(), env, admin.id);

    expect(result.retired).toBeGreaterThanOrEqual(1);

    const [entry] = await db()
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.entityId, career.id as string));

    expect(entry!.archivedAt).not.toBeNull();
  });
});

describe('the catalog sync inside a free Worker invocation', () => {
  /**
   * The defect this pins (found 2026-09-04, before deploy): the sync decided "has this changed?"
   * by reading each entry's text back from **R2**. Every binding call is a subrequest, a free
   * Worker invocation gets 50 (§45), and seed 0004 alone puts 68 careers in the catalog — so the
   * first press of Sync would have breached the ceiling before writing anything, and the nightly
   * cron would have breached it *every night even when nothing had changed*.
   *
   * A hash on the row makes an unchanged entry cost nothing, which is asserted here by counting
   * storage access rather than by trusting the shape of the code.
   */
  it('touches storage for nothing when the catalog has not changed', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);

    await createCareer(token, { description: 'A career that will not change.' });
    await syncCatalogKnowledge(db(), env, admin.id);

    let storageCalls = 0;
    const counting = new Proxy(env.STORAGE, {
      get(target, property, receiver) {
        if (property === 'get' || property === 'put') {
          storageCalls += 1;
        }

        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const second = await syncCatalogKnowledge(
      db(),
      { ...env, STORAGE: counting },
      admin.id,
    );

    expect(second.changed).toBe(0);
    expect(storageCalls).toBe(0);
  });

  it('stops at its subrequest budget and reports the backlog rather than exceeding it', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);

    for (let i = 0; i < 3; i += 1) {
      await createCareer(token, { description: `Budget fixture career ${i}.` });
    }

    // A budget of one: the run must do one entry and say how many it did not do, rather than
    // working through the whole catalog in a single invocation.
    const first = await syncCatalogKnowledge(db(), env, admin.id, { limit: 1 });

    expect(first.changed).toBe(1);
    expect(first.remaining).toBeGreaterThan(0);

    // And the next run picks up exactly where it left off — the backlog drains, it does not stall.
    const second = await syncCatalogKnowledge(db(), env, admin.id, { limit: 1 });

    expect(second.changed).toBe(1);
    expect(second.remaining).toBe(first.remaining - 1);
  });
});

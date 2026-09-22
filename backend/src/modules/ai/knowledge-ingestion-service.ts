import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';

import type { Database } from '@/db/client';
import type { KnowledgeEntityType } from '@/db/enums';
import {
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeQuestionResolutions,
  users,
  type KnowledgeDocument,
  type User,
} from '@/db/schema';
import { chunkText, cleanText } from '@/lib/chunker';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import {
  dispatch,
  type KnowledgeDocumentProcessedEvent,
  type Listener,
} from '@/events/dispatcher';
import { ApiError, paginate, type PaginatedData } from '@/lib/envelope';
import { contains } from '@/lib/search';
import { EMBEDDING_BATCH_LIMIT, type AiGatewayService } from '@/modules/ai/ai-gateway-service';
// `import type` deliberately: schemas.ts imports MAX_EXTRACTED_TEXT_CHARS from this file, so a value
// import here would close the cycle at runtime. A type import is erased and cannot.
import type { ListKnowledgeDocumentsQuery } from '@/modules/ai/schemas';
import type { VectorStore } from '@/modules/ai/vector-store';
import { AuditService } from '@/modules/platform/audit-service';
import { authorizeManageKnowledge, authorizeViewKnowledge } from '@/policies/knowledge';

/**
 * `KnowledgeIngestionService` — the §33 pipeline, built to the v1.5 Free-plan shape from the
 * first line:
 *
 *   * **Extraction already happened in the admin's browser.** The Worker receives
 *     `{ file, extracted_text }`, validates and caps the text (§34), and stores the raw file
 *     in R2 unchanged for provenance. There is no server-side parser: request handlers and
 *     queue consumers both get 10 ms of CPU on Free, and a pure-JS parser would also eat
 *     most of the 3 MB bundle cap. Trust is unchanged — the same admin could already type
 *     anything into the knowledge base.
 *   * **The extracted text is persisted as an R2 sidecar** (`…/extracted.txt`), because the
 *     chunking runs in a queue consumer that may execute long after the upload request died
 *     — and because Free-plan queues retain messages for only 24 hours (§42), every job here
 *     must be re-runnable from durable state, not from anything the message alone carries.
 *   * **Embedding is batched** (§33 v1.5): one AI call and one Vectorize upsert per ≤100
 *     chunks, never one per chunk — a free invocation gets 50 subrequests total.
 *   * **Vector ids are chunk ids**, so retrieval maps matches straight back to rows, and
 *     `vector_id IS NULL` doubles as the §43 idempotency check for re-embedding.
 *
 * `COMPLETED` means "vectors accepted". Vectorize indexes asynchronously — an immediate
 * query returning nothing is indexing lag, not a failed write (§33).
 */

const MODULE = 'AiKnowledge';

/** §33: the raw upload is capped at 10 MB. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * §34's server-side hard cap on the browser-extracted text. 500k characters is ~125k tokens
 * — more than any plausible guidance document, small enough that chunking stays inside a
 * consumer's CPU budget.
 */
export const MAX_EXTRACTED_TEXT_CHARS = 500_000;

/**
 * D1 refuses >100 bound parameters per statement (D18). A chunk row binds **10** columns
 * (id, document_id, chunk_number, content, vector_id, token_count, source_type, entity_type,
 * entity_id, created_at), so 9 rows bind 90 — the same headroom rule as `chunkForD1` in the
 * recommendation service: one added column must not silently push a statement over the ceiling.
 *
 * This constant has now been wrong twice, in both directions, which is the argument for the
 * comment naming every column rather than just the count. The first cut said 16 and miscounted
 * the columns at 6. It then said 12 against 7 columns and was correct until migration 0023 added
 * three — 12 × 10 = 120, and every ingestion failed with "too many SQL variables". Miniflare's
 * D1 enforces the cap locally, so the ingestion suite caught it the moment the columns landed;
 * without that it would have been a clean deploy that could not ingest anything.
 */
const CHUNK_ROWS_PER_INSERT = 9;

/** Cloudflare Queues accepts up to 100 messages per `sendBatch` call. */
const QUEUE_BATCH_LIMIT = 100;

export interface UploadInput {
  fileName: string;
  /** `pdf` / `docx` for a parsed upload; `text` for a `.txt` or `.md`, which needs no parser. */
  sourceType: 'pdf' | 'docx' | 'text';
  fileBytes: ArrayBuffer;
  extractedText: string;
}

/**
 * A knowledge entry an admin **wrote**, rather than uploaded (migration 0022).
 *
 * `body` is the text that gets chunked and embedded, and for a Q&A pair it is already shaped
 * `Q: …
A: …` by the caller — the route owns that formatting, because it is the wire contract
 * (two fields) meeting the corpus contract (one passage), and doing it here would mean this
 * service knowing about form fields.
 */
export interface AuthoredEntryInput {
  sourceType: 'text' | 'qa';
  title: string;
  body: string;
}

/** An entry generated from a catalog row, addressed by what it is *about* rather than by uuid. */
export interface CatalogEntryInput {
  entityType: KnowledgeEntityType;
  entityId: string;
  title: string;
  body: string;
  /** SHA-256 of `body`, computed by the caller that already had the text in hand. */
  contentHash: string;
  /**
   * `qa` for a Guidance corpus Q&A pair, whose body is already shaped `Q: …\nA: …` so Gate 1 can
   * return its answer verbatim. Defaults to `catalog`.
   */
  sourceType?: 'catalog' | 'qa';
}

/** The two §43 job messages this pipeline enqueues; consumed in `src/jobs/ai-jobs.ts`. */
export interface ProcessKnowledgeDocumentPayload {
  documentId: string;
}

export interface GenerateEmbeddingBatchPayload {
  documentId: string;
  chunkIds: string[];
}

/**
 * A listed entry with the person behind it resolved.
 *
 * Authorship was always on the row (`uploaded_by`, NOT NULL since §33) and never left the server.
 * It has to now: once counselors contribute to the same corpus, "who wrote this" is the difference
 * between an answer a school published and one a single counselor did — and an admin reviewing a
 * wrong answer needs to know who to talk to before they can do anything but archive it.
 */
export type KnowledgeDocumentWithAuthor = KnowledgeDocument & {
  chunkCount: number;
  authorName: string;
  authorRole: string;
};

export class KnowledgeIngestionService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: Database,
    private readonly storage: R2Bucket,
    private readonly gateway: AiGatewayService,
    private readonly vectors: VectorStore,
    private readonly aiQueue: Queue | undefined,
    /**
     * §60's `KnowledgeDocumentProcessed` subscribers (Phase 6 — the §44 notification). Passed
     * in rather than imported so the pipeline stays ignorant of who reacts to it, exactly like
     * every other event seam — and so the stub-driven tests can run with none registered.
     */
    private readonly processedListeners: Listener<KnowledgeDocumentProcessedEvent>[] = [],
  ) {
    this.audit = new AuditService(db);
  }

  /**
   * Accept an upload: raw file to R2 (provenance), extracted text to an R2 sidecar (the
   * durable input every later step re-reads), one `UPLOADED` row, one queued job.
   */
  async upload(
    admin: User,
    input: UploadInput,
    ipAddress: string | null,
  ): Promise<KnowledgeDocument> {
    const id = uuid();
    const timestamp = now();
    const storagePath = `knowledge/${id}/${input.fileName}`;

    await this.storage.put(storagePath, input.fileBytes);
    await this.storage.put(this.sidecarPath(id), input.extractedText);

    const document = {
      id,
      uploadedBy: admin.id,
      title: input.fileName,
      fileName: input.fileName,
      sourceType: input.sourceType,
      storagePath,
      entityType: null,
      entityId: null,
      // Only the catalog sync compares hashes; an upload's source of truth is its R2 file.
      contentHash: null,
      processingStatus: 'UPLOADED' as const,
      visibility: 'GLOBAL' as const,
      archivedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.db.insert(knowledgeDocuments).values(document);

    await this.enqueueProcessing(id);

    await this.audit.write({
      action: 'KNOWLEDGE_DOCUMENT_UPLOADED',
      module: MODULE,
      userId: admin.id,
      targetType: 'knowledge_document',
      targetId: id,
      newValues: { file_name: input.fileName, source_type: input.sourceType },
      ipAddress,
    });

    return document;
  }

  /**
   * Create an entry the admin **wrote** — a pasted note or a Q&A pair (AiNormalisation Phase 1).
   *
   * There is no raw file, so `storage_path` stays NULL; the body goes straight to the R2 sidecar
   * the pipeline already re-reads, which is why `process()` needs no branch for this at all. The
   * whole feature is one write to a path that already existed.
   */
  async createEntry(
    admin: User,
    input: AuthoredEntryInput,
    ipAddress: string | null,
  ): Promise<KnowledgeDocument> {
    const id = uuid();
    const timestamp = now();

    await this.storage.put(this.sidecarPath(id), input.body);

    const document = {
      id,
      uploadedBy: admin.id,
      title: input.title,
      // §44's notification and the audit trail both read `file_name`; the title is the honest
      // answer to "what is this called" for a row that never was a file.
      fileName: input.title,
      sourceType: input.sourceType,
      storagePath: null,
      entityType: null,
      entityId: null,
      contentHash: null,
      processingStatus: 'UPLOADED' as const,
      visibility: 'GLOBAL' as const,
      archivedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.db.insert(knowledgeDocuments).values(document);

    await this.enqueueProcessing(id);

    await this.audit.write({
      action: 'KNOWLEDGE_DOCUMENT_UPLOADED',
      module: MODULE,
      userId: admin.id,
      targetType: 'knowledge_document',
      targetId: id,
      newValues: { title: input.title, source_type: input.sourceType },
      ipAddress,
    });

    return document;
  }

  /**
   * Edit **any** live entry's text in place, and re-chunk it immediately.
   *
   * The point of this method is the *time* it takes: correcting a wrong fact used to mean
   * archiving the document and re-uploading a fixed file. Now it is a save, and the reprocess
   * that follows is the existing idempotent-by-replacement path — old vectors out, new chunks
   * in — so a corrected answer replaces the wrong one in the index rather than joining it.
   *
   * ## Why every source type is editable, including the two that used to be refused
   *
   * The thing being edited is **the text the AI reads**, which is the R2 sidecar. That is not the
   * same object as the provenance:
   *
   *   * **An upload** keeps its original file in R2, untouched, exactly as §33 intends. What the
   *     admin corrects here is the *extraction* — and extraction is precisely what goes wrong: a
   *     PDF's columns interleave, a table becomes a word salad, a ligature eats a digit. Refusing
   *     the edit did not protect the original; it protected a bad transcription of it, and left
   *     "archive it and re-upload" as the only remedy for a typo.
   *   * **A catalog entry** is regenerated from `careers` / `programs`, so an edit to it is
   *     temporary by nature. It survives until the underlying row changes, because
   *     `content_hash` records the *generated* text the entry was last synced from and the sync
   *     compares against that — so an unchanged career means an untouched entry, edit and all.
   *     When the career does change, the generated text wins, which is the right precedence: the
   *     catalog is the source of truth for what a catalog entry says. The UI states this, because
   *     a rule the admin cannot see is a rule that will surprise them.
   *
   * Archived entries are still refused. They are archived so that they stay out of the index, and
   * editing one would be a way to quietly bring it back.
   */
  async updateEntry(
    admin: User,
    documentId: string,
    input: { title?: string; body?: string },
    ipAddress: string | null,
  ): Promise<KnowledgeDocument> {
    // Authorized before anything is read back to the caller: a counselor must not be able to
    // discover the title of a colleague's entry through the error on a failed edit.
    const document = await this.findFor(admin, documentId, 'manage');

    if (document.archivedAt !== null) {
      throw ApiError.validation({
        document: [
          'An archived entry cannot be edited. It is archived precisely so it stays out of the index.',
        ],
      });
    }

    if (input.body !== undefined) {
      await this.storage.put(this.sidecarPath(documentId), input.body);
    }

    const timestamp = now();
    const changes = {
      ...(input.title === undefined ? {} : { title: input.title, fileName: input.title }),
      // Back to the start of the pipeline: the chunks on this row describe the old text until
      // the reprocess lands, and saying UPLOADED is how the list says so.
      //
      // `contentHash` is deliberately NOT touched. On a catalog entry it is the sync's fingerprint
      // of the text it last generated, not a checksum of the current body — leaving it alone is
      // what makes the sync skip this entry, and therefore what makes the edit survive.
      processingStatus: 'UPLOADED' as const,
      updatedAt: timestamp,
    };

    await this.db
      .update(knowledgeDocuments)
      .set(changes)
      .where(eq(knowledgeDocuments.id, documentId));

    await this.enqueueProcessing(documentId);

    await this.audit.write({
      action: 'KNOWLEDGE_DOCUMENT_UPDATED',
      module: MODULE,
      userId: admin.id,
      targetType: 'knowledge_document',
      targetId: documentId,
      oldValues: { title: document.title },
      newValues: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { body_chars: input.body.length }),
      },
      ipAddress,
    });

    return { ...document, ...changes };
  }

  /**
   * The text this entry was built from — the sidecar, which for an authored entry *is* the
   * source. Read by the edit form, so that correcting one word does not mean retyping the rest.
   */
  async bodyOf(documentId: string): Promise<string> {
    const sidecar = await this.storage.get(this.sidecarPath(documentId));

    if (sidecar === null) {
      throw ApiError.notFound('The text for this entry is no longer in storage.');
    }

    return sidecar.text();
  }

  /**
   * Create or update the one knowledge entry for a career or program (catalog auto-sync).
   *
   * Idempotent in the sense that matters for a nightly cron: **an unchanged body does no work at
   * all** — no sidecar write, no queue message, no re-embedding. Every career and program is
   * synced on every run, so without that check the cron would re-embed the whole catalog nightly
   * and spend a meaningful slice of a 10,000-neuron day rewriting identical vectors.
   *
   * `uploadedBy` is an admin id the caller resolves, because the column is NOT NULL and a
   * system-generated row still has to be attributable to somebody who could have written it.
   */
  async upsertCatalogEntry(
    uploadedBy: string,
    input: CatalogEntryInput,
    /**
     * The row the caller already has, when it listed the catalog entries in one query. Passing it
     * is what keeps this method's subrequest cost at **zero for an unchanged entry** — see the
     * note on `contentHash` in the schema.
     */
    existing?: KnowledgeDocument,
    /**
     * Defer the queue message. The sync sends one batched message for the whole run instead of
     * one per entry, because a queue send is a subrequest too.
     */
    options: { enqueue?: boolean } = {},
  ): Promise<{ document: KnowledgeDocument; changed: boolean }> {
    const enqueue = options.enqueue ?? true;
    const row =
      existing ??
      (
        await this.db
          .select()
          .from(knowledgeDocuments)
          .where(
            and(
              eq(knowledgeDocuments.entityType, input.entityType),
              eq(knowledgeDocuments.entityId, input.entityId),
            ),
          )
          .limit(1)
      )[0];

    if (row !== undefined) {
      // Archived by an admin who did not want this entry in the index: leave it alone. Recreating
      // it every night would make archiving a catalog entry impossible, which is worse than a
      // stale one — the admin's decision outranks the sync's opinion.
      if (row.archivedAt !== null) {
        return { document: row, changed: false };
      }

      // The comparison that used to read R2. A NULL hash is an entry written before migration
      // 0024 and compares unequal, so it is rewritten once — the conservative answer.
      if (row.contentHash === input.contentHash && row.title === input.title) {
        return { document: row, changed: false };
      }

      await this.storage.put(this.sidecarPath(row.id), input.body);

      const timestamp = now();
      const changes = {
        title: input.title,
        fileName: input.title,
        contentHash: input.contentHash,
        processingStatus: 'UPLOADED' as const,
        updatedAt: timestamp,
      };

      await this.db
        .update(knowledgeDocuments)
        .set(changes)
        .where(eq(knowledgeDocuments.id, row.id));

      if (enqueue) {
        await this.enqueueProcessing(row.id);
      }

      return { document: { ...row, ...changes }, changed: true };
    }

    const id = uuid();
    const timestamp = now();

    await this.storage.put(this.sidecarPath(id), input.body);

    const document = {
      id,
      uploadedBy,
      title: input.title,
      fileName: input.title,
      sourceType: input.sourceType ?? ('catalog' as const),
      storagePath: null,
      entityType: input.entityType,
      entityId: input.entityId,
      contentHash: input.contentHash,
      processingStatus: 'UPLOADED' as const,
      visibility: 'GLOBAL' as const,
      archivedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.db.insert(knowledgeDocuments).values(document);

    if (enqueue) {
      await this.enqueueProcessing(id);
    }

    return { document, changed: true };
  }

  /**
   * Queue processing for many documents in **one** subrequest.
   *
   * `Queue.sendBatch` takes up to 100 messages per call, so a full catalog sync spends one send
   * rather than one per entry. With no queue bound (the hermetic suite) this falls back to running
   * each document inline, exactly like `enqueueProcessing`.
   */
  async enqueueProcessingBatch(documentIds: string[]): Promise<void> {
    if (documentIds.length === 0) {
      return;
    }

    if (this.aiQueue === undefined) {
      for (const documentId of documentIds) {
        await this.process(documentId);
      }

      return;
    }

    for (let i = 0; i < documentIds.length; i += QUEUE_BATCH_LIMIT) {
      await this.aiQueue.sendBatch(
        documentIds.slice(i, i + QUEUE_BATCH_LIMIT).map((documentId) => ({
          body: {
            type: 'ProcessKnowledgeDocument',
            payload: { documentId } satisfies ProcessKnowledgeDocumentPayload,
          },
        })),
      );
    }
  }

  /**
   * `ProcessKnowledgeDocumentJob` (§43): clean, chunk, persist, and fan out embedding
   * batches. Idempotent by replacement — re-running deletes the document's chunks (and any
   * vectors they had) and rebuilds them from the sidecar text, so a retry after a partial
   * failure can never leave two copies of a chunk.
   */
  async process(documentId: string): Promise<void> {
    const document = await this.find(documentId);

    if (document.archivedAt !== null) {
      return; // Archived while queued — §13.7 says archived content must never (re)enter the index.
    }

    const sidecar = await this.storage.get(this.sidecarPath(documentId));

    if (sidecar === null) {
      await this.setStatus(documentId, 'FAILED');

      throw new Error(`Extracted text sidecar is missing for document ${documentId}.`);
    }

    await this.setStatus(documentId, 'PROCESSING');

    const chunks = chunkText(cleanText(await sidecar.text()));

    if (chunks.length === 0) {
      await this.setStatus(documentId, 'FAILED');

      throw new Error(`Document ${documentId} produced no chunks.`);
    }

    // Replace wholesale: old vectors out of the index first, then rows, in one batch.
    const existing = await this.db
      .select({ vectorId: knowledgeChunks.vectorId })
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.documentId, documentId));

    const oldVectorIds = existing
      .map((row) => row.vectorId)
      .filter((vectorId): vectorId is string => vectorId !== null);

    if (oldVectorIds.length > 0) {
      await this.vectors.deleteByIds(oldVectorIds);
    }

    const timestamp = now();
    // Denormalized from the document onto every chunk (migration 0023): the same three values go
    // into the vector's metadata below, so the keyword and vector halves of retrieval filter on
    // one definition of "about this program" rather than two.
    const rows = chunks.map((chunk) => ({
      id: uuid(),
      documentId,
      chunkNumber: chunk.chunkNumber,
      content: chunk.content,
      vectorId: null,
      tokenCount: chunk.tokenCount,
      sourceType: document.sourceType,
      entityType: document.entityType,
      entityId: document.entityId,
      createdAt: timestamp,
    }));

    const statements: BatchItem<'sqlite'>[] = [
      this.db.delete(knowledgeChunks).where(eq(knowledgeChunks.documentId, documentId)),
    ];

    for (let i = 0; i < rows.length; i += CHUNK_ROWS_PER_INSERT) {
      statements.push(
        this.db.insert(knowledgeChunks).values(rows.slice(i, i + CHUNK_ROWS_PER_INSERT)),
      );
    }

    await this.db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);

    // One embedding job per ≤100 chunks (§33): each job is one AI call + one upsert.
    for (let i = 0; i < rows.length; i += EMBEDDING_BATCH_LIMIT) {
      const payload: GenerateEmbeddingBatchPayload = {
        documentId,
        chunkIds: rows.slice(i, i + EMBEDDING_BATCH_LIMIT).map((row) => row.id),
      };

      if (this.aiQueue !== undefined) {
        await this.aiQueue.send({ type: 'GenerateEmbeddingBatch', payload });
      } else {
        await this.embedBatch(payload.documentId, payload.chunkIds);
      }
    }
  }

  /**
   * `GenerateEmbeddingJob` (§43): embed one batch and write the vector ids back. Idempotent
   * — a chunk that already has a `vector_id` is skipped, so a redelivered message re-embeds
   * nothing (§43: "checks for an existing vector_id before re-embedding").
   */
  async embedBatch(documentId: string, chunkIds: string[]): Promise<void> {
    const pending = await this.db
      .select()
      .from(knowledgeChunks)
      .where(and(eq(knowledgeChunks.documentId, documentId), isNull(knowledgeChunks.vectorId)))
      .orderBy(asc(knowledgeChunks.chunkNumber));

    const wanted = new Set(chunkIds);
    const batch = pending.filter((chunk) => wanted.has(chunk.id));

    if (batch.length > 0) {
      const embeddings = await this.gateway.embed(batch.map((chunk) => chunk.content));

      /**
       * One upsert for the whole batch. Vector id = chunk id — the §30 retrieval mapping.
       *
       * The metadata is what makes filtered retrieval possible (AiNormalisation Phase 2): with
       * only `document_id`, explaining one program meant competing against the whole corpus on
       * raw similarity, because there was nothing to say a chunk was *about* that program.
       *
       * Undefined values are omitted rather than sent as empty strings — Vectorize metadata is
       * string-valued, and `entity_type: ''` would make "has no entity" a value that an equality
       * filter could match, which is precisely the wrong answer to "is this about a career?".
       */
      await this.vectors.upsert(
        batch.map((chunk, index) => ({
          id: chunk.id,
          values: embeddings[index]!,
          metadata: {
            document_id: documentId,
            ...(chunk.sourceType === null ? {} : { source_type: chunk.sourceType }),
            ...(chunk.entityType === null ? {} : { entity_type: chunk.entityType }),
            ...(chunk.entityId === null ? {} : { entity_id: chunk.entityId }),
          },
        })),
      );

      // One UPDATE for the whole batch — the vector id is the chunk id (the §30 mapping), so
      // `vector_id = id` sets every row at once instead of one statement per chunk.
      await this.db
        .update(knowledgeChunks)
        .set({ vectorId: sql`${knowledgeChunks.id}` })
        .where(
          inArray(
            knowledgeChunks.id,
            batch.map((chunk) => chunk.id),
          ),
        );
    }

    // COMPLETED once no chunk is left unembedded — "vectors accepted", not "queryable yet".
    const [remaining] = await this.db
      .select({ pending: count() })
      .from(knowledgeChunks)
      .where(and(eq(knowledgeChunks.documentId, documentId), isNull(knowledgeChunks.vectorId)));

    if ((remaining?.pending ?? 0) === 0) {
      // M5: flip to COMPLETED only if it is not already, and let the affected-row count decide
      // whether **this** invocation is the one that completed the document. Two embedding batches
      // for the same document can both observe `remaining === 0` and race here; the conditional
      // update means exactly one of them changes a row, so the §60 event and its notification fire
      // once, not twice. (`updatedAt` still moves on the winning flip.)
      const flipped = await this.db
        .update(knowledgeDocuments)
        .set({ processingStatus: 'COMPLETED', updatedAt: now() })
        .where(
          and(
            eq(knowledgeDocuments.id, documentId),
            ne(knowledgeDocuments.processingStatus, 'COMPLETED'),
          ),
        )
        .returning({ id: knowledgeDocuments.id });

      if (flipped.length > 0) {
        // §60: "after all chunks embedded". Fires on a reprocess completion too, deliberately —
        // the admin asked for the re-run, and "it is available again" is the answer they wanted.
        const document = await this.find(documentId);

        await dispatch<KnowledgeDocumentProcessedEvent>(
          {
            type: 'KnowledgeDocumentProcessed',
            documentId,
            uploadedBy: document.uploadedBy,
            fileName: document.fileName,
          },
          this.processedListeners,
        );
      }
    }
  }

  /**
   * Archive, never delete (§13.7, Part I principle #4): the vectors leave the index — which
   * is what makes archived content structurally unretrievable (§30) — while the document and
   * chunk rows stay, because `ai_requests.input_context` references chunk ids for provenance.
   */
  async archive(
    admin: User,
    documentId: string,
    ipAddress: string | null,
  ): Promise<KnowledgeDocument> {
    await this.findFor(admin, documentId, 'manage');

    return this.archiveAs(admin.id, documentId, ipAddress);
  }

  /**
   * The same archive, addressed by actor id rather than by a `User` row.
   *
   * The catalog sync needs it: when a career is archived in the catalog, the knowledge entry
   * about that career has to leave the index too, and the sync runs on a cron where there is no
   * request and no loaded user — only the admin id it attributes its writes to.
   */
  async archiveAs(
    actorId: string,
    documentId: string,
    ipAddress: string | null,
  ): Promise<KnowledgeDocument> {
    const document = await this.find(documentId);

    if (document.archivedAt !== null) {
      return document; // Archiving twice is a no-op, not an error.
    }

    const chunks = await this.db
      .select({ vectorId: knowledgeChunks.vectorId })
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.documentId, documentId));

    const vectorIds = chunks
      .map((row) => row.vectorId)
      .filter((vectorId): vectorId is string => vectorId !== null);

    if (vectorIds.length > 0) {
      await this.vectors.deleteByIds(vectorIds);
    }

    const timestamp = now();

    await this.db
      .update(knowledgeDocuments)
      .set({ archivedAt: timestamp, updatedAt: timestamp })
      .where(eq(knowledgeDocuments.id, documentId));

    await this.audit.write({
      action: 'KNOWLEDGE_DOCUMENT_ARCHIVED',
      module: MODULE,
      userId: actorId,
      targetType: 'knowledge_document',
      targetId: documentId,
      newValues: { vectors_removed: vectorIds.length },
      ipAddress,
    });

    return { ...document, archivedAt: timestamp, updatedAt: timestamp };
  }

  /**
   * **Destroy an entry and everything that made it retrievable** (prompt-driven).
   *
   * ## Why this exists next to `archive`, rather than instead of it
   *
   * Archiving is the everyday act: the entry stops answering, and the record of what the AI once
   * said and why survives. That is the right default and it stays the default. But it is not a way
   * to get rid of anything — an entry written with a student's name in it, a bad paste, a document
   * somebody was not entitled to upload — and "we keep everything forever" is not a defensible
   * answer to a request to delete personal data. So removal exists, deliberately as the second
   * button rather than the first.
   *
   * ## What it costs, stated rather than discovered
   *
   * `ai_requests.input_context` records the chunk ids an answer was built from, and those rows are
   * not touched here — deleting them would destroy the audit trail of what the AI told a student,
   * which is a far worse thing to lose than a provenance link. So after a removal those ids point
   * at chunks that no longer exist: the trail still says *an answer was grounded*, and can no
   * longer show *in what*. That is the trade, and it is why the route requires the entry to be
   * archived first — a removal is then always a second, deliberate decision about something already
   * out of service, never a one-click end to a live entry.
   *
   * ## Order of operations
   *
   * Vectors first, then R2, then rows. Every step is idempotent and a failure part-way leaves less
   * rather than more: a stranded vector is invisible (its chunk row is gone, so nothing can cite
   * it) and the operation can simply be repeated. Doing the D1 delete first would risk the reverse
   * — a row gone while its vector still answers queries.
   */
  async remove(admin: User, documentId: string, ipAddress: string | null): Promise<void> {
    const document = await this.findFor(admin, documentId, 'manage');

    if (document.archivedAt === null) {
      throw ApiError.validation({
        document: [
          'Archive this entry before removing it. Archiving takes it out of the AI’s reach straight away; removing it destroys the text for good.',
        ],
      });
    }

    const chunks = await this.db
      .select({ id: knowledgeChunks.id, vectorId: knowledgeChunks.vectorId })
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.documentId, documentId));

    const vectorIds = chunks
      .map((row) => row.vectorId)
      .filter((vectorId): vectorId is string => vectorId !== null);

    // Already removed by `archive`, and repeated here rather than assumed: a chunk embedded by a
    // queue job that landed *after* the archive would otherwise survive its own document.
    if (vectorIds.length > 0) {
      await this.vectors.deleteByIds(vectorIds);
    }

    // The uploaded original and the extracted-text sidecar. `delete` on a missing key is a no-op in
    // R2, which is what makes this safe for entries that never had a file (a Q&A, a note).
    if (document.storagePath !== null) {
      await this.storage.delete(document.storagePath);
    }

    await this.storage.delete(this.sidecarPath(documentId));

    /**
     * The resolutions that named this entry as their answer.
     *
     * Deleted rather than left with a dangling `document_id`, and the consequence is the correct
     * one: every question this entry answered goes straight back onto the unanswered list. The
     * answer is gone, so the gap is real again — and the route says how many, because a backlog
     * that grows overnight with no explanation is how this whole report stopped being trusted the
     * first time.
     */
    await this.db
      .delete(knowledgeQuestionResolutions)
      .where(eq(knowledgeQuestionResolutions.documentId, documentId));

    await this.db.delete(knowledgeChunks).where(eq(knowledgeChunks.documentId, documentId));
    await this.db.delete(knowledgeDocuments).where(eq(knowledgeDocuments.id, documentId));

    await this.audit.write({
      action: 'KNOWLEDGE_DOCUMENT_DELETED',
      module: MODULE,
      userId: admin.id,
      targetType: 'knowledge_document',
      targetId: documentId,
      // The row is gone, so this is the only surviving description of what was destroyed. Title and
      // source, never the text: an audit log is not a place to reconstitute content somebody asked
      // to have deleted.
      oldValues: {
        title: document.title,
        source_type: document.sourceType,
        chunks_deleted: chunks.length,
        vectors_deleted: vectorIds.length,
      },
      ipAddress,
    });
  }

  /**
   * Undo an archive. Archiving removed the vectors (the chunk rows stayed), so bringing an entry
   * back means clearing `archived_at` and re-running processing — the same queue path as
   * `reprocess`, which rebuilds the chunks and puts fresh vectors in the index.
   */
  async unarchive(
    admin: User,
    documentId: string,
    ipAddress: string | null,
  ): Promise<KnowledgeDocument> {
    const document = await this.findFor(admin, documentId, 'manage');

    if (document.archivedAt === null) {
      return document; // Unarchiving a live entry is a no-op, not an error.
    }

    const timestamp = now();

    await this.db
      .update(knowledgeDocuments)
      .set({ archivedAt: null, processingStatus: 'UPLOADED', updatedAt: timestamp })
      .where(eq(knowledgeDocuments.id, documentId));

    await this.enqueueProcessing(documentId);

    await this.audit.write({
      action: 'KNOWLEDGE_DOCUMENT_UNARCHIVED',
      module: MODULE,
      userId: admin.id,
      targetType: 'knowledge_document',
      targetId: documentId,
      ipAddress,
    });

    return { ...document, archivedAt: null, processingStatus: 'UPLOADED', updatedAt: timestamp };
  }

  /**
   * The §42 v1.5 re-run path: Free-plan queues retain messages for 24 hours, so a job that
   * was never consumed is simply gone — an admin needs a button, not just automatic retries.
   */
  async reprocess(
    admin: User,
    documentId: string,
    ipAddress: string | null,
  ): Promise<KnowledgeDocument> {
    const document = await this.findFor(admin, documentId, 'manage');

    if (document.archivedAt !== null) {
      throw ApiError.validation({
        document: [
          'An archived document cannot be reprocessed. It is archived precisely so it cannot re-enter the index.',
        ],
      });
    }

    await this.setStatus(documentId, 'UPLOADED');
    await this.enqueueProcessing(documentId);

    await this.audit.write({
      action: 'KNOWLEDGE_DOCUMENT_REPROCESSED',
      module: MODULE,
      userId: admin.id,
      targetType: 'knowledge_document',
      targetId: documentId,
      ipAddress,
    });

    return { ...document, processingStatus: 'UPLOADED' };
  }

  /**
   * Newest first, filtered by `search` (file name) and `status` (processing state) — audit F4.
   *
   * The `id` tie-breaker on the ordering is load-bearing rather than decorative: `created_at` is
   * only unique here by luck of upload timing, and two documents sharing one timestamp would make
   * the row order unspecified *per query*, so a row could appear on both page one and page two
   * while another appeared on neither. The same reason `AcademicCatalogService.orderFor` exists.
   *
   * ## Two kinds of narrowing, and why they are separate arguments
   *
   * `authorId` is the **enforced** scope, passed by the route from the authenticated user — a
   * counselor sees the entries they wrote and nothing else. `query.author_role` is a **filter** the
   * caller chose, which is how an admin asks "what have the counselors contributed?". Conflating
   * them into one parameter is how a filter eventually becomes the only thing standing between a
   * counselor and everyone else's work.
   *
   * Both go into the same `scope`, which is then used by the count **and** the page query. That
   * sharing is not tidiness: a count and a page built from different predicates produce pagination
   * that reports more rows than it will ever hand over, and the last page comes back empty.
   */
  async list(
    query: ListKnowledgeDocumentsQuery,
    authorId?: string,
  ): Promise<PaginatedData<KnowledgeDocumentWithAuthor>> {
    const { page, per_page: perPage } = query;

    const scope = and(
      query.status === undefined
        ? undefined
        : eq(knowledgeDocuments.processingStatus, query.status),
      query.search === undefined
        ? undefined
        : contains(knowledgeDocuments.fileName, query.search),
      authorId === undefined ? undefined : eq(knowledgeDocuments.uploadedBy, authorId),
      query.author_role === undefined ? undefined : eq(users.role, query.author_role),
      // The live/archived split (prompt-driven). Archived entries used to sit in the same list as
      // live ones, which made "what can the AI actually answer from?" unanswerable by looking.
      query.archived === 'all'
        ? undefined
        : query.archived === 'archived'
          ? isNotNull(knowledgeDocuments.archivedAt)
          : isNull(knowledgeDocuments.archivedAt),
    );

    const [total] = await this.db
      .select({ value: count() })
      .from(knowledgeDocuments)
      // Inner join: `uploaded_by` is NOT NULL and references `users`, so every entry has exactly
      // one author row and this adds no rows and drops none. A left join would be defensive about
      // a case the schema forbids, at the cost of nullable columns to handle downstream.
      .innerJoin(users, eq(users.id, knowledgeDocuments.uploadedBy))
      .where(scope);

    const rows = await this.db
      .select({
        document: knowledgeDocuments,
        chunkCount: count(knowledgeChunks.id),
        authorName: users.name,
        authorRole: users.role,
      })
      .from(knowledgeDocuments)
      .innerJoin(users, eq(users.id, knowledgeDocuments.uploadedBy))
      .leftJoin(knowledgeChunks, eq(knowledgeChunks.documentId, knowledgeDocuments.id))
      .where(scope)
      .groupBy(knowledgeDocuments.id)
      .orderBy(desc(knowledgeDocuments.createdAt), asc(knowledgeDocuments.id))
      .limit(perPage)
      .offset((page - 1) * perPage);

    return paginate(
      rows.map((row) => ({
        ...row.document,
        chunkCount: row.chunkCount,
        authorName: row.authorName,
        authorRole: row.authorRole,
      })),
      total?.value ?? 0,
      page,
      perPage,
    );
  }

  /**
   * One entry by id, with no authorization applied.
   *
   * Kept unguarded because the pipeline itself calls it — `process`, `embedBatch` and `archiveAs`
   * run on a queue where there is no request and no user, and handing them a `User` they do not
   * have would be a fiction. **Every request-driven caller must use `findFor` instead**, which is
   * why that one exists rather than an optional parameter here: an optional guard is a guard
   * somebody forgets to pass.
   */
  async find(documentId: string): Promise<KnowledgeDocument> {
    const [document] = await this.db
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, documentId))
      .limit(1);

    if (document === undefined) {
      throw ApiError.notFound('Knowledge document not found.');
    }

    return document;
  }

  /**
   * One entry by id, as a specific user is allowed to see it (§39).
   *
   * `intent` decides which of the two policy questions is asked. They differ on exactly one row
   * shape — a catalog entry, which an admin may edit and a counselor may not — and both answer 404
   * rather than 403 so that "not yours" and "not real" stay indistinguishable.
   */
  async findFor(
    user: User,
    documentId: string,
    intent: 'view' | 'manage' = 'manage',
  ): Promise<KnowledgeDocument> {
    const document = await this.find(documentId);

    return intent === 'view'
      ? authorizeViewKnowledge(user, document)
      : authorizeManageKnowledge(user, document);
  }

  /** The author of an entry, for the serializer — one read, no join on the write paths. */
  async authorOf(document: KnowledgeDocument): Promise<{ name: string; role: string } | null> {
    const [author] = await this.db
      .select({ name: users.name, role: users.role })
      .from(users)
      .where(eq(users.id, document.uploadedBy))
      .limit(1);

    return author ?? null;
  }

  async markFailed(documentId: string): Promise<void> {
    await this.setStatus(documentId, 'FAILED');
  }

  // --- internals ---------------------------------------------------------------------

  private sidecarPath(documentId: string): string {
    return `knowledge/${documentId}/extracted.txt`;
  }

  private async enqueueProcessing(documentId: string): Promise<void> {
    const payload: ProcessKnowledgeDocumentPayload = { documentId };

    if (this.aiQueue !== undefined) {
      await this.aiQueue.send({ type: 'ProcessKnowledgeDocument', payload });
    } else {
      await this.process(documentId);
    }
  }

  private async setStatus(
    documentId: string,
    processingStatus: KnowledgeDocument['processingStatus'],
  ): Promise<void> {
    await this.db
      .update(knowledgeDocuments)
      .set({ processingStatus, updatedAt: now() })
      .where(eq(knowledgeDocuments.id, documentId));
  }
}

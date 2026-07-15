import { and, asc, count, desc, eq, isNull } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';

import type { Database } from '@/db/client';
import { knowledgeChunks, knowledgeDocuments, type KnowledgeDocument, type User } from '@/db/schema';
import { chunkText, cleanText } from '@/lib/chunker';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { ApiError, paginate, type PaginatedData } from '@/lib/envelope';
import { EMBEDDING_BATCH_LIMIT, type AiGatewayService } from '@/modules/ai/ai-gateway-service';
import type { VectorStore } from '@/modules/ai/vector-store';
import { AuditService } from '@/modules/platform/audit-service';

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
 * D1 refuses >100 bound parameters per statement (D18). A chunk row binds **7** columns
 * (id, document_id, chunk_number, content, vector_id, token_count, created_at), so 12 rows
 * bind 84 — the same headroom rule as `chunkForD1` in the recommendation service: one added
 * column must not silently push a statement over the ceiling. The first cut of this
 * constant said 16 and miscounted the columns at 6; Miniflare's D1 now enforces the cap
 * locally and the ingestion test caught it before any deploy could.
 */
const CHUNK_ROWS_PER_INSERT = 12;

export interface UploadInput {
  fileName: string;
  fileType: 'pdf' | 'docx';
  fileBytes: ArrayBuffer;
  extractedText: string;
}

/** The two §43 job messages this pipeline enqueues; consumed in `src/jobs/ai-jobs.ts`. */
export interface ProcessKnowledgeDocumentPayload {
  documentId: string;
}

export interface GenerateEmbeddingBatchPayload {
  documentId: string;
  chunkIds: string[];
}

export class KnowledgeIngestionService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: Database,
    private readonly storage: R2Bucket,
    private readonly gateway: AiGatewayService,
    private readonly vectors: VectorStore,
    private readonly aiQueue: Queue | undefined,
  ) {
    this.audit = new AuditService(db);
  }

  /**
   * Accept an upload: raw file to R2 (provenance), extracted text to an R2 sidecar (the
   * durable input every later step re-reads), one `UPLOADED` row, one queued job.
   */
  async upload(admin: User, input: UploadInput, ipAddress: string | null): Promise<KnowledgeDocument> {
    const id = uuid();
    const timestamp = now();
    const storagePath = `knowledge/${id}/${input.fileName}`;

    await this.storage.put(storagePath, input.fileBytes);
    await this.storage.put(this.sidecarPath(id), input.extractedText);

    const document = {
      id,
      uploadedBy: admin.id,
      fileName: input.fileName,
      fileType: input.fileType,
      storagePath,
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
      newValues: { file_name: input.fileName, file_type: input.fileType },
      ipAddress,
    });

    return document;
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
    const rows = chunks.map((chunk) => ({
      id: uuid(),
      documentId,
      chunkNumber: chunk.chunkNumber,
      content: chunk.content,
      vectorId: null,
      tokenCount: chunk.tokenCount,
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

      // One upsert for the whole batch. Vector id = chunk id — the §30 retrieval mapping.
      await this.vectors.upsert(
        batch.map((chunk, index) => ({
          id: chunk.id,
          values: embeddings[index]!,
          metadata: { document_id: documentId },
        })),
      );

      const updates: BatchItem<'sqlite'>[] = batch.map((chunk) =>
        this.db
          .update(knowledgeChunks)
          .set({ vectorId: chunk.id })
          .where(eq(knowledgeChunks.id, chunk.id)),
      );

      await this.db.batch(updates as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
    }

    // COMPLETED once no chunk is left unembedded — "vectors accepted", not "queryable yet".
    const [remaining] = await this.db
      .select({ pending: count() })
      .from(knowledgeChunks)
      .where(and(eq(knowledgeChunks.documentId, documentId), isNull(knowledgeChunks.vectorId)));

    if ((remaining?.pending ?? 0) === 0) {
      await this.setStatus(documentId, 'COMPLETED');
    }
  }

  /**
   * Archive, never delete (§13.7, Part I principle #4): the vectors leave the index — which
   * is what makes archived content structurally unretrievable (§30) — while the document and
   * chunk rows stay, because `ai_requests.input_context` references chunk ids for provenance.
   */
  async archive(admin: User, documentId: string, ipAddress: string | null): Promise<KnowledgeDocument> {
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
      userId: admin.id,
      targetType: 'knowledge_document',
      targetId: documentId,
      newValues: { vectors_removed: vectorIds.length },
      ipAddress,
    });

    return { ...document, archivedAt: timestamp, updatedAt: timestamp };
  }

  /**
   * The §42 v1.5 re-run path: Free-plan queues retain messages for 24 hours, so a job that
   * was never consumed is simply gone — an admin needs a button, not just automatic retries.
   */
  async reprocess(admin: User, documentId: string, ipAddress: string | null): Promise<KnowledgeDocument> {
    const document = await this.find(documentId);

    if (document.archivedAt !== null) {
      throw ApiError.validation({
        document: ['An archived document cannot be reprocessed. It is archived precisely so it cannot re-enter the index.'],
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

  async list(page: number, perPage: number): Promise<PaginatedData<KnowledgeDocument & { chunkCount: number }>> {
    const [total] = await this.db.select({ value: count() }).from(knowledgeDocuments);

    const rows = await this.db
      .select({
        document: knowledgeDocuments,
        chunkCount: count(knowledgeChunks.id),
      })
      .from(knowledgeDocuments)
      .leftJoin(knowledgeChunks, eq(knowledgeChunks.documentId, knowledgeDocuments.id))
      .groupBy(knowledgeDocuments.id)
      .orderBy(desc(knowledgeDocuments.createdAt))
      .limit(perPage)
      .offset((page - 1) * perPage);

    return paginate(
      rows.map((row) => ({ ...row.document, chunkCount: row.chunkCount })),
      total?.value ?? 0,
      page,
      perPage,
    );
  }

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

import { Hono } from 'hono';

import { createDatabase } from '@/db/client';
import type { AppEnv } from '@/env';
import { queueCatalogSyncContinuation } from '@/jobs/ai-jobs';
import { successEnvelope, ApiError } from '@/lib/envelope';
import { clientIp, parseBody, parseQuery } from '@/lib/validation';
import { authenticate, requireUser } from '@/middleware/authenticate';
import { ensurePasswordChanged } from '@/middleware/ensure-password-changed';
import { ensureRole } from '@/middleware/ensure-role';
import { AiPolicyService } from '@/modules/ai/ai-policy-service';
import {
  syncCatalogKnowledge,
  type CatalogSyncResult,
} from '@/modules/ai/catalog-knowledge-service';
import { ingestionFrom } from '@/modules/ai/factory';
import { AiInsightsService } from '@/modules/ai/insights-service';
import { MAX_FILE_BYTES } from '@/modules/ai/knowledge-ingestion-service';
import {
  createKnowledgeEntrySchema,
  extractedTextSchema,
  listKnowledgeDocumentsQuerySchema,
  LIST_KNOWLEDGE_QUERY_KEYS,
  updateAiPolicySchema,
  updateKnowledgeEntrySchema,
  UPLOAD_SOURCE_TYPES,
} from '@/modules/ai/schemas';
import { serializeAiPolicy, serializeKnowledgeDocument } from '@/modules/ai/serializers';

/**
 * The AI / Knowledge module's admin surface (FULLPLAN §20): knowledge documents and the AI
 * policy. Mounted under `/admin` — like the catalog, this is global configuration with no
 * ownership dimension, so the route group's `ensureRole('admin')` is the entire rule and
 * there is deliberately no policy file (§39 names three policies; none of them is this).
 */
export const adminAiRoutes = new Hono<AppEnv>();

adminAiRoutes.use('*', authenticate());
adminAiRoutes.use('*', ensureRole('admin'));
adminAiRoutes.use('*', ensurePasswordChanged());

adminAiRoutes.get('/knowledge-documents', async (c) => {
  const query = parseQuery(c, listKnowledgeDocumentsQuerySchema, [...LIST_KNOWLEDGE_QUERY_KEYS]);
  const result = await ingestionFrom(createDatabase(c.env.DB), c.env).list(query);

  return c.json(
    successEnvelope(
      { items: result.items.map(serializeKnowledgeDocument), pagination: result.pagination },
      'Knowledge documents retrieved.',
    ),
  );
});

/**
 * §33 (v1.5): multipart `{ file, extracted_text }`. The **browser** already did the
 * extraction — pdf.js/mammoth have no server-side home on the Free plan (10 ms of CPU
 * everywhere, and a parser dependency would eat most of the 3 MB bundle cap). The raw file
 * is kept in R2 for provenance; the text is validated and capped here (§34) exactly as
 * parser output would have been.
 */
adminAiRoutes.post('/knowledge-documents', async (c) => {
  let form: Record<string, unknown>;

  try {
    form = await c.req.parseBody();
  } catch {
    throw new ApiError(400, 'The request body must be multipart/form-data.');
  }

  const file = form.file;

  if (!(file instanceof File)) {
    throw ApiError.validation({ file: ['A PDF or DOCX file is required.'] });
  }

  if (file.size > MAX_FILE_BYTES) {
    throw ApiError.validation({ file: ['The file exceeds the 10 MB limit.'] });
  }

  /**
   * `.txt` and `.md` join PDF and DOCX (AiNormalisation Phase 1) — and they cost nothing to
   * accept: there is no parser to add on either side, because the browser reads a text file with
   * `File.text()`. Both land as `source_type = 'text'`; the extension described how to *read* the
   * file, never what kind of knowledge it holds.
   */
  const extension = file.name.toLowerCase().split('.').pop();
  const sourceType = UPLOAD_SOURCE_TYPES[extension ?? ''];

  if (sourceType === undefined) {
    throw ApiError.validation({
      file: ['Only PDF, DOCX, TXT and MD files are supported.'],
    });
  }

  const parsed = extractedTextSchema.safeParse({ extracted_text: form.extracted_text });

  if (!parsed.success) {
    throw ApiError.validation({
      extracted_text: parsed.error.issues.map((issue) => issue.message),
    });
  }

  const document = await ingestionFrom(createDatabase(c.env.DB), c.env).upload(
    requireUser(c),
    {
      fileName: file.name,
      sourceType,
      fileBytes: await file.arrayBuffer(),
      extractedText: parsed.data.extracted_text,
    },
    clientIp(c),
  );

  return c.json(
    successEnvelope(serializeKnowledgeDocument(document), 'Document uploaded. Processing has been queued.'),
    201,
  );
});

/**
 * DELETE **archives** (§13.7, §20): `archived_at` is set and the vectors leave Vectorize —
 * never a hard delete, because `ai_requests.input_context` references chunk ids for
 * provenance. 200 with the archived row rather than 204, so the client can render the state
 * it just created without a refetch.
 */
adminAiRoutes.delete('/knowledge-documents/:id', async (c) => {
  const document = await ingestionFrom(createDatabase(c.env.DB), c.env).archive(
    requireUser(c),
    c.req.param('id'),
    clientIp(c),
  );

  return c.json(
    successEnvelope(serializeKnowledgeDocument(document), 'Document archived. Its content is no longer retrievable by the AI.'),
  );
});

/**
 * The §42 (v1.5) re-run path — not in §20's catalog (deviation, recorded in PROGRESS.md):
 * Free-plan queues retain messages for 24 hours, so a processing job that was never
 * consumed is simply gone, and "wait for the retry" is not an answer an admin can act on.
 */
adminAiRoutes.post('/knowledge-documents/:id/reprocess', async (c) => {
  const document = await ingestionFrom(createDatabase(c.env.DB), c.env).reprocess(
    requireUser(c),
    c.req.param('id'),
    clientIp(c),
  );

  return c.json(successEnvelope(serializeKnowledgeDocument(document), 'Reprocessing queued.'));
});

/**
 * **Write a knowledge entry, rather than upload one** (AiNormalisation Phase 1).
 *
 * The measurement that produced this endpoint: on 2026-09-04 the production corpus held zero
 * documents and had never held one. Uploading was the only way in, and it requires somebody to
 * have a PDF — so the AI had nothing to stand on and refused, correctly, on every question.
 *
 * Two shapes, one row:
 *
 *   * `type: "text"` — a title and a body. A paragraph of policy, an admissions note, anything.
 *   * `type: "qa"` — a question and its authoritative answer, stored as one `Q: …\nA: …` passage.
 *     This is the highest-value input in the system. It embeds close to how a student actually
 *     phrases the question, and it is what Gate 1 will return **verbatim, with no model call**,
 *     which is simultaneously the cheapest answer and the only one that cannot hallucinate.
 */
adminAiRoutes.post('/knowledge-entries', async (c) => {
  const input = await parseBody(c, createKnowledgeEntrySchema);

  const document = await ingestionFrom(createDatabase(c.env.DB), c.env).createEntry(
    requireUser(c),
    input.type === 'qa'
      ? {
          sourceType: 'qa',
          title: input.question,
          // The corpus contract: one passage carrying both halves. A question embedded without
          // its answer retrieves the question back, which is not knowledge.
          body: `Q: ${input.question}\nA: ${input.answer}`,
        }
      : { sourceType: 'text', title: input.title, body: input.body },
    clientIp(c),
  );

  return c.json(
    successEnvelope(serializeKnowledgeDocument(document), 'Saved. It will be searchable in a moment.'),
    201,
  );
});

/**
 * The body an entry was written from, for the edit form — so correcting one word does not mean
 * retyping the rest. Available for any entry, including uploads, because reading what the AI
 * actually sees is how an admin diagnoses a bad answer.
 */
adminAiRoutes.get('/knowledge-documents/:id/content', async (c) => {
  const service = ingestionFrom(createDatabase(c.env.DB), c.env);
  const document = await service.find(c.req.param('id'));
  const body = await service.bodyOf(document.id);

  return c.json(
    successEnvelope(
      { ...serializeKnowledgeDocument(document), body },
      'Entry content retrieved.',
    ),
  );
});

/**
 * Edit an authored entry. Saving re-chunks and re-embeds through the existing reprocess path,
 * so a corrected fact **replaces** the wrong one in the index rather than joining it there.
 *
 * Uploads and catalog entries are refused by the service, each for its own reason (see
 * `updateEntry`). PATCH rather than PUT: a title fix should not require resending the body.
 */
adminAiRoutes.patch('/knowledge-entries/:id', async (c) => {
  const input = await parseBody(c, updateKnowledgeEntrySchema);
  const document = await ingestionFrom(createDatabase(c.env.DB), c.env).updateEntry(
    requireUser(c),
    c.req.param('id'),
    input.type === 'qa'
      ? { title: input.question, body: `Q: ${input.question}\nA: ${input.answer}` }
      : { title: input.title, body: input.body },
    clientIp(c),
  );

  return c.json(
    successEnvelope(serializeKnowledgeDocument(document), 'Saved. The AI is re-reading it now.'),
  );
});

/**
 * What the admin is told after a sync.
 *
 * `remaining` is the part worth surfacing rather than hiding: one invocation may only rewrite so
 * many entries before it runs out of the Free plan's 50 subrequests (§45), so on a first seed of a
 * full catalog the honest answer is "this much done, press again" — not a cheerful total that is
 * not yet true.
 */
function catalogSyncMessage(result: CatalogSyncResult): string {
  if (result.skipped !== undefined) {
    return result.skipped;
  }

  if (result.changed === 0 && result.retired === 0) {
    return 'Every career and program is already up to date in the knowledge base.';
  }

  const parts = [
    result.changed === 0 ? null : `${result.changed} entries queued for re-reading`,
    result.retired === 0 ? null : `${result.retired} archived`,
    // Not "run this again" any more: the remainder is queued and finishes on its own.
    result.remaining === 0 ? null : `${result.remaining} more queued and finishing in the background`,
  ].filter((part): part is string => part !== null);

  return `${parts.join(', ')}.`;
}

/**
 * Run the catalog sync on demand.
 *
 * It also runs nightly, but "nightly" is the wrong answer to *"I just fixed that program's
 * description and the AI is still saying the old thing"* — an admin who made a correction should
 * be able to make it true now. Idempotent and cheap when nothing changed: an entry whose text is
 * unchanged is not rewritten, not re-queued, and not re-embedded.
 */
adminAiRoutes.post('/knowledge-catalog-sync', async (c) => {
  const result = await syncCatalogKnowledge(createDatabase(c.env.DB), c.env, requireUser(c).id);

  // The rest of the catalog finishes on the queue rather than on the admin's patience. One batch
  // still runs inline so the response reports real numbers instead of "queued, check back".
  await queueCatalogSyncContinuation(c.env, result, 1);

  return c.json(
    successEnvelope(
      result,
      catalogSyncMessage(result),
    ),
  );
});

/**
 * **What the knowledge base does not cover** (AiNormalisation Phase 4).
 *
 * Three reads, no new pipeline. Every honest refusal this system has ever made already wrote an
 * `ai_requests` row carrying the question and the reason — the work was done in Phase 5a and
 * nobody had ever looked at it. Surfacing it is what turns a refusal from a dead end into the
 * admin's backlog: answer the top five questions, and the next student to ask any of them gets
 * that answer verbatim from Gate 1, with no model call and no possibility of invention.
 *
 * One endpoint rather than three, because it is one screen and three round trips on a school's
 * connection is three chances to see a spinner.
 */
adminAiRoutes.get('/ai-insights', async (c) => {
  const service = new AiInsightsService(createDatabase(c.env.DB));

  const [unanswered, coverage, flagged, health] = await Promise.all([
    service.unansweredQuestions(),
    service.coverage(),
    service.flaggedAnswers(),
    service.corpusHealth(),
  ]);

  return c.json(
    successEnvelope(
      {
        unanswered_questions: unanswered.map((row) => ({
          question: row.question,
          asks: row.asks,
          last_asked_at: row.lastAskedAt,
        })),
        coverage: {
          careers: coverage.careers,
          programs: coverage.programs,
          gaps: coverage.gaps.map((gap) => ({
            kind: gap.kind,
            id: gap.id,
            label: gap.label,
            stalled: gap.stalled,
          })),
        },
        flagged_answers: flagged.map((row) => ({
          message_id: row.messageId,
          answer: row.answer,
          question: row.question,
          ai_request_id: row.aiRequestId,
          chunk_ids: row.chunkIds,
          created_at: row.createdAt,
        })),
        corpus: health,
      },
      'AI insights retrieved.',
    ),
  );
});

// --- AI policy (§13.7): the single GLOBAL row — list and edit, never create or delete. ------

adminAiRoutes.get('/ai-policies', async (c) => {
  const policies = await new AiPolicyService(createDatabase(c.env.DB)).list();

  return c.json(successEnvelope(policies.map(serializeAiPolicy), 'AI policies retrieved.'));
});

adminAiRoutes.patch('/ai-policies/:id', async (c) => {
  const input = await parseBody(c, updateAiPolicySchema);
  const policy = await new AiPolicyService(createDatabase(c.env.DB)).update(
    requireUser(c),
    c.req.param('id'),
    input,
  );

  return c.json(successEnvelope(serializeAiPolicy(policy), 'AI policy updated.'));
});

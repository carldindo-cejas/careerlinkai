import { Hono } from 'hono';

import { createDatabase } from '@/db/client';
import type { AppEnv } from '@/env';
import { successEnvelope, ApiError } from '@/lib/envelope';
import { clientIp, parseBody, parseQuery } from '@/lib/validation';
import { authenticate, requireUser } from '@/middleware/authenticate';
import { ensurePasswordChanged } from '@/middleware/ensure-password-changed';
import { ensureRole } from '@/middleware/ensure-role';
import { AiPolicyService } from '@/modules/ai/ai-policy-service';
import { ingestionFrom } from '@/modules/ai/factory';
import { MAX_FILE_BYTES } from '@/modules/ai/knowledge-ingestion-service';
import {
  extractedTextSchema,
  listKnowledgeDocumentsQuerySchema,
  updateAiPolicySchema,
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
  const query = parseQuery(c, listKnowledgeDocumentsQuerySchema, ['page', 'per_page']);
  const result = await ingestionFrom(createDatabase(c.env.DB), c.env).list(
    query.page,
    query.per_page,
  );

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

  const extension = file.name.toLowerCase().split('.').pop();

  if (extension !== 'pdf' && extension !== 'docx') {
    throw ApiError.validation({ file: ['Only PDF and DOCX files are supported.'] });
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
      fileType: extension,
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

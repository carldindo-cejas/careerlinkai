import { z } from 'zod';

import { PROCESSING_STATUSES } from '@/db/enums';
import { MAX_EXTRACTED_TEXT_CHARS } from '@/modules/ai/knowledge-ingestion-service';

/**
 * Zod schemas for the AI / Knowledge module's write endpoints (FULLPLAN §33, §34, §41).
 *
 * The knowledge upload is multipart (§33) — the `File` half is validated in the route
 * (Zod does not see a stream), while the browser-extracted text comes through here with
 * §34's server-side hard cap. The Worker trusts the admin's *authority* to add knowledge
 * (they could already type anything into the base) but never the *shape* of what arrives.
 */

export const extractedTextSchema = z.object({
  extracted_text: z
    .string()
    .trim()
    .min(1, 'The extracted text is empty. Extraction may have failed in the browser.')
    .max(
      MAX_EXTRACTED_TEXT_CHARS,
      `The extracted text exceeds the ${MAX_EXTRACTED_TEXT_CHARS.toLocaleString()}-character cap.`,
    ),
});

/**
 * Which uploaded extensions map to which `source_type` (AiNormalisation Phase 1).
 *
 * `.txt` and `.md` cost nothing to accept — the browser reads them with `File.text()`, so there
 * is no parser on either side — and they are the format a school's existing handouts are most
 * likely to already be in. Both are `text`: the extension said how to *read* the file, never what
 * kind of knowledge it holds.
 */
export const UPLOAD_SOURCE_TYPES: Record<string, 'pdf' | 'docx' | 'text' | undefined> = {
  pdf: 'pdf',
  docx: 'docx',
  txt: 'text',
  md: 'text',
};

/**
 * A knowledge entry an admin writes by hand.
 *
 * ## The Q&A caps are load-bearing, not tidiness
 *
 * A Q&A pair must land as **one chunk**. It is stored as a single `Q: …\nA: …` passage, and the
 * whole point of the shape is that the passage which retrieves is also the passage Gate 1 can
 * return verbatim. Split across two chunks, half an answer can be retrieved without the other
 * half — the exact failure the §33 overlap exists to prevent, reintroduced at the source. 300 +
 * 1200 characters plus the markers sits under the chunker's ~1,680-character window with room to
 * spare, so the shape is guaranteed by arithmetic rather than by hoping answers stay short.
 *
 * A pasted `text` entry has no such constraint — it is chunked like any document — so its cap is
 * §34's ordinary extracted-text ceiling.
 */
const qaEntrySchema = z.object({
  type: z.literal('qa'),
  question: z
    .string()
    .trim()
    .min(5, 'Write the question as a student would ask it.')
    .max(300, 'Keep the question under 300 characters so it stays one searchable passage.'),
  answer: z
    .string()
    .trim()
    .min(1, 'An answer is required — this text is returned to students word for word.')
    .max(1200, 'Keep the answer under 1200 characters so it stays one searchable passage.'),
});

const textEntrySchema = z.object({
  type: z.literal('text'),
  title: z
    .string()
    .trim()
    .min(3, 'Give this a title, so it can be found again.')
    .max(200, 'Keep the title under 200 characters.'),
  body: z
    .string()
    .trim()
    .min(1, 'There is nothing to save.')
    .max(
      MAX_EXTRACTED_TEXT_CHARS,
      `The text exceeds the ${MAX_EXTRACTED_TEXT_CHARS.toLocaleString()}-character cap.`,
    ),
});

/**
 * A discriminated union rather than one loose object with everything optional: the two shapes
 * have genuinely different fields, and `.strict()` on each means sending a `body` alongside a
 * `question` is a 422 instead of a silently ignored half-saved entry.
 */
export const createKnowledgeEntrySchema = z.discriminatedUnion('type', [
  qaEntrySchema.strict(),
  textEntrySchema.strict(),
]);

/**
 * The edit form posts the whole entry back, so this is the same union — a partial update of one
 * half of a Q&A pair would leave the stored passage internally inconsistent (a new question
 * paired with the old answer), which is worse than asking the form to send both.
 */
export const updateKnowledgeEntrySchema = createKnowledgeEntrySchema;

export type CreateKnowledgeEntryInput = z.infer<typeof createKnowledgeEntrySchema>;

/**
 * §13.7: only the two text fields and the active flag are writable. `.strict()` so a caller
 * trying to write `scope` — the column reserved for §63's finer scopes — is told no rather
 * than silently ignored.
 */
export const updateAiPolicySchema = z
  .object({
    instructions: z.string().trim().max(4000).nullable().optional(),
    restrictions: z.string().trim().max(4000).nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .strict();

/**
 * The knowledge list query (audit F4). `search` matches the **file name** — the only thing on the
 * row a human recognises a document by — and `status` filters on `processing_status`.
 *
 * That filter is the one worth having: a document stuck in `PROCESSING`, or one that came back
 * `FAILED`, contributes **nothing** to retrieval and looks identical to a healthy one in a list
 * sorted by upload date. Before this, finding them meant reading every page.
 */
export const listKnowledgeDocumentsQuerySchema = z.object({
  search: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((value) => (value === undefined || value === '' ? undefined : value)),
  status: z.enum(PROCESSING_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
});

export const LIST_KNOWLEDGE_QUERY_KEYS = ['search', 'status', 'page', 'per_page'] as const;

export type ListKnowledgeDocumentsQuery = z.infer<typeof listKnowledgeDocumentsQuerySchema>;

export type UpdateAiPolicyInput = z.infer<typeof updateAiPolicySchema>;

/**
 * One chat turn (migration 0019).
 *
 * The length cap is a real control, not tidiness: every message becomes a model call charged
 * against a hard daily neuron quota (§45), and an unbounded prompt is the cheapest way to spend
 * the school's whole day of AI on one paste. `.strict()` because the *only* thing a client may
 * send is the question — the recommendation context is loaded server-side from the caller's own
 * token, and a client that could supply its own context could have the model explain any numbers
 * it liked as though they were this student's results.
 */
export const askChatSchema = z
  .object({
    message: z
      .string()
      .trim()
      .min(1, 'Type a question first.')
      .max(1000, 'Keep your question under 1000 characters.'),
  })
  .strict();

export type AskChatInput = z.infer<typeof askChatSchema>;

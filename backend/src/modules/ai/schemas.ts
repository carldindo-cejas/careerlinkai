import { z } from 'zod';

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

export const listKnowledgeDocumentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
});

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

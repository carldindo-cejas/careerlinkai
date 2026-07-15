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

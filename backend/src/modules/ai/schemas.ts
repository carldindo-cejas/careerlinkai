import { z } from 'zod';

import { PROCESSING_STATUSES, USER_ROLES } from '@/db/enums';
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
 * The cap on a question **as the backlog recorded it** — not on a question anyone types.
 *
 * Deliberately far above the 300-character Q&A cap, because the two measure different strings and
 * confusing them is a 422 on exactly the rows that most need dealing with. A backlog row's text
 * comes from `ai_requests.input_context.retrieval_query`, and while a chat question is capped at
 * 1000 by `askChatSchema`, `ExplanationService` builds its retrieval query by **joining catalog
 * text together** — a program name, its college, description fragments — which for a verbose
 * catalog entry runs well past a thousand characters.
 *
 * Those rows no longer reach the unanswered list (it is student chat questions only, since the
 * production test of 2026-09-11), but resolutions and dismissals written before that carry them,
 * and a cap that 422s a reopen or an edit of an existing row is the same bug from the other side.
 * 4000 matches the AI-policy text cap in this module: still a firm bound against an unbounded
 * write, comfortably clear of anything the pipeline produces.
 */
const MAX_BACKLOG_QUESTION_CHARS = 4000;

/**
 * **Which backlog question this entry was written to answer** (migration 0031).
 *
 * Optional, and separate from the entry's own fields for a reason that is easy to miss: the entry
 * carries the question *as the author finally phrased it*, while this carries the question **as the
 * backlog recorded it**. Those are routinely different — the report shows the student's retrieval
 * query, and the first thing anybody does in the Q&A form is tidy it up before saving.
 *
 * If the resolution were keyed off the saved entry's question, editing so much as the punctuation
 * would key it to text no `ai_requests` row ever contained, the backlog item would never clear, and
 * the bug this migration exists to fix would be back — this time with a row in the resolutions
 * table insisting it had been handled.
 *
 * Absent on an entry written from scratch rather than from the report. Such an entry still
 * resolves its own question if it is a Q&A pair — see `resolveBacklogItems` in routes.ts.
 */
const resolvesQuestion = z
  .string()
  .trim()
  .min(1)
  .max(MAX_BACKLOG_QUESTION_CHARS)
  .optional()
  .transform((value) => (value === '' ? undefined : value));

/**
 * **Other backlog questions the author says this entry also answers** (found testing on production).
 *
 * Students ask one thing many ways — "Where is Holy Name University located?", "HNU located",
 * "location of HNU" — and each spelling is its own backlog row, so one answer used to leave three
 * behind. The report suggests similar rows; the author ticks the ones this entry really covers.
 *
 * Opt-in on purpose. Lexical similarity cannot tell "colleges offering Computer Science in Cebu"
 * from "…in Bohol", and a wrong resolution hides a real gap — so nothing is resolved here that a
 * person did not tick. Capped at 20, which is more than any real family of rephrasings.
 */
const alsoResolves = z
  .array(z.string().trim().min(1).max(MAX_BACKLOG_QUESTION_CHARS))
  .max(20, 'Choose at most 20 similar questions.')
  .optional();

/**
 * A discriminated union rather than one loose object with everything optional: the two shapes
 * have genuinely different fields, and `.strict()` on each means sending a `body` alongside a
 * `question` is a 422 instead of a silently ignored half-saved entry.
 */
export const createKnowledgeEntrySchema = z.discriminatedUnion('type', [
  qaEntrySchema.extend({ resolves_question: resolvesQuestion, also_resolves: alsoResolves }).strict(),
  textEntrySchema.extend({ resolves_question: resolvesQuestion, also_resolves: alsoResolves }).strict(),
]);

/**
 * Taking a question off the backlog without answering it — gibberish, a test, something
 * off-domain. Admin-only at the route (see `KnowledgeQuestionResolutionService.dismiss`).
 */
export const dismissQuestionSchema = z
  .object({
    question: z
      .string()
      .trim()
      .min(1, 'A question is required.')
      .max(MAX_BACKLOG_QUESTION_CHARS, 'That is longer than any question this system records.'),
  })
  .strict();

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
  /**
   * Whose entries to show, by role — an admin asking "what have the counselors contributed?".
   *
   * A **filter**, never a permission. The counselor's own scoping is applied by the route from
   * their token and cannot be widened from here: passing `author_role=admin` as a counselor
   * narrows an already-narrowed list to nothing, which is the correct and boring outcome. The two
   * are separate arguments to `list()` precisely so this one can never become the only thing
   * holding the boundary.
   *
   * `student` is in the enum because it is the same `USER_ROLES` list the column is typed with,
   * and there is no such entry today — a filter matching nothing beats a second role vocabulary
   * that has to be kept in step with the first.
   */
  author_role: z.enum(USER_ROLES).optional(),
  /**
   * Which half of the library to list — live entries or archived ones (prompt-driven).
   *
   * **Defaults to the live half**, which is a behaviour change and the right one: archived entries
   * used to be mixed into the same list, so a library with a season of retired entries in it buried
   * the ones the AI can actually answer from among rows that cannot. They are two different
   * questions ("what does the AI know?" and "what did we retire?") and they now get two lists.
   *
   * A tri-state rather than a boolean, because `false` and "don't care" are different requests and
   * a bare `?archived=false` would otherwise be indistinguishable from omitting it. Nothing in the
   * UI asks for `all`; it exists so a future caller can, without this becoming two parameters.
   */
  archived: z.enum(['live', 'archived', 'all']).default('live'),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
});

export const LIST_KNOWLEDGE_QUERY_KEYS = [
  'search',
  'status',
  'author_role',
  'archived',
  'page',
  'per_page',
] as const;

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

/**
 * The AI-gaps report's paging.
 *
 * Two revisions on from where it started. It was a fixed 25 rows with no indication there were more
 * — everything past the 25th question was simply invisible (found testing on production). That was
 * replaced by a growing `limit` behind a "Show more" button, which made the backlog reachable but
 * still meant re-fetching every row already on screen to see the next twenty-five.
 *
 * Now it is an ordinary page/per_page pager, the same shape as every other list in this system
 * (`listCounselorsQuerySchema`, the audit viewer, the catalog) — because the screen it feeds is now
 * a set of tabs with a pager under each, rather than one growing scroll.
 */
export const aiInsightsPageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
});

export const AI_INSIGHTS_QUERY_KEYS = ['page', 'per_page'] as const;

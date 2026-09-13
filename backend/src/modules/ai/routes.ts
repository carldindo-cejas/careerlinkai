import { Hono, type Context } from 'hono';

import { createDatabase } from '@/db/client';
import type { User } from '@/db/schema';
import type { AppEnv } from '@/env';
import { queueCatalogSyncContinuation, requestGuidanceSync } from '@/jobs/ai-jobs';
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
import { AiInsightsService, type InsightsScope } from '@/modules/ai/insights-service';
import { MAX_FILE_BYTES } from '@/modules/ai/knowledge-ingestion-service';
import {
  canDismissQuestions,
  KnowledgeQuestionResolutionService,
} from '@/modules/ai/question-resolution-service';
import {
  AI_INSIGHTS_QUERY_KEYS,
  aiInsightsPageQuerySchema,
  createKnowledgeEntrySchema,
  type CreateKnowledgeEntryInput,
  dismissQuestionSchema,
  extractedTextSchema,
  listKnowledgeDocumentsQuerySchema,
  LIST_KNOWLEDGE_QUERY_KEYS,
  updateAiPolicySchema,
  updateKnowledgeEntrySchema,
  UPLOAD_SOURCE_TYPES,
} from '@/modules/ai/schemas';
import { serializeAiPolicy, serializeKnowledgeDocument } from '@/modules/ai/serializers';

/**
 * The AI / Knowledge module's staff surface (FULLPLAN §20).
 *
 * ## Why there is one router factory and two mounts
 *
 * Counselors contribute to the knowledge base on the same terms admins do — same pipeline, same
 * corpus, same reach to every student — and differ only in **what they can see back**: their own
 * entries, and the questions their own students asked. That is a `WHERE` clause, not a different
 * feature, so duplicating these handlers under `/counselor` would be two copies of one resource
 * kept in step by hand. Every scoping decision instead comes from two functions, `authorScope` and
 * `insightsScope`, applied to the authenticated user.
 *
 * The router is a factory rather than a shared instance because the two mounts carry different
 * `ensureRole` middleware, and Hono attaches middleware to the router it is mounted on.
 *
 * This module still has no policy file for the *coarse* rule — that is `ensureRole`'s whole job —
 * but it now has one for the fine rule (`policies/knowledge.ts`, §39), because since counselors
 * arrived "may this user touch this entry" is a question that requires looking at the record.
 */

/**
 * The **enforced** author scope. Undefined means "no narrowing" and is only ever an admin.
 *
 * Derived from the token, never from a query parameter. `author_role` in the list query is a
 * filter a caller chooses; this is the boundary, and the two are deliberately different arguments
 * to `list()` so that a filter can never quietly become the boundary.
 */
function authorScope(user: User): string | undefined {
  return user.role === 'admin' ? undefined : user.id;
}

/** The same rule for the reports: an admin sees the platform, a counselor sees their students. */
function insightsScope(user: User): InsightsScope {
  return user.role === 'admin' ? null : { counselorId: user.id };
}

/**
 * The knowledge surface both staff roles get, scoped per request.
 *
 * Everything here is safe for a counselor to call because every handler either scopes its read to
 * `authorScope`/`insightsScope` or routes its write through `findFor`, which applies
 * `policies/knowledge.ts` and answers 404 for somebody else's entry.
 */
function createKnowledgeRoutes() {
  const routes = new Hono<AppEnv>();

  routes.get('/knowledge-documents', async (c) => {
    const user = requireUser(c);
    const query = parseQuery(c, listKnowledgeDocumentsQuerySchema, [...LIST_KNOWLEDGE_QUERY_KEYS]);
    const result = await ingestionFrom(createDatabase(c.env.DB), c.env).list(
      query,
      authorScope(user),
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
  routes.post('/knowledge-documents', async (c) => {
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
   *
   * The message names the questions this puts back on the backlog (migration 0031). Nothing
   * cascades — the report works that out for itself from `archived_at` — but an entry that was
   * somebody's answer to three questions is not an entry to archive absent-mindedly, and the
   * alternative to saying so here is the backlog growing tomorrow with no explanation.
   */
  routes.delete('/knowledge-documents/:id', async (c) => {
    const db = createDatabase(c.env.DB);
    const documentId = c.req.param('id');
    const resolutions = await new KnowledgeQuestionResolutionService(db).forDocument(documentId);

    const document = await ingestionFrom(db, c.env).archive(
      requireUser(c),
      documentId,
      clientIp(c),
    );

    const reopened =
      resolutions.length === 0
        ? ''
        : ` ${resolutions.length} ${resolutions.length === 1 ? 'question is' : 'questions are'} back on the unanswered list.`;

    return c.json(
      successEnvelope(
        serializeKnowledgeDocument(document),
        `Document archived. Its content is no longer retrievable by the AI.${reopened}`,
      ),
    );
  });

  /**
   * `DELETE /knowledge-documents/{id}/permanently` — **destroy the entry**, as opposed to the
   * archive the plain DELETE above performs (prompt-driven).
   *
   * Two routes rather than a `?permanent=true` flag on one, because these are not two settings of
   * the same operation: one is reversible in effect and keeps every record, the other is final. A
   * flag would put "keep it" and "destroy it" one typo apart on the same URL, and would make every
   * existing caller of DELETE one query parameter away from a different outcome.
   *
   * The service refuses an entry that is not already archived, so removal is always the second of
   * two deliberate acts. The message names the questions this sends back to the backlog: their
   * answer no longer exists, and a backlog that regrows overnight with no explanation is how this
   * report lost people's trust the first time.
   */
  routes.delete('/knowledge-documents/:id/permanently', async (c) => {
    const db = createDatabase(c.env.DB);
    const documentId = c.req.param('id');
    const resolutions = await new KnowledgeQuestionResolutionService(db).forDocument(documentId);

    await ingestionFrom(db, c.env).remove(requireUser(c), documentId, clientIp(c));

    const reopened =
      resolutions.length === 0
        ? ''
        : ` ${resolutions.length} ${resolutions.length === 1 ? 'question is' : 'questions are'} back on the unanswered list.`;

    return c.json(
      successEnvelope(
        { id: documentId },
        `Entry removed. Its text, passages and stored file are gone for good.${reopened}`,
      ),
    );
  });

  /**
   * The §42 (v1.5) re-run path — not in §20's catalog (deviation, recorded in PROGRESS.md):
   * Free-plan queues retain messages for 24 hours, so a processing job that was never
   * consumed is simply gone, and "wait for the retry" is not an answer anyone can act on.
   */
  routes.post('/knowledge-documents/:id/reprocess', async (c) => {
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
   *
   * `resolves_question` is migration 0031: the entry is written first, then the backlog item is
   * marked answered. That order is not incidental — see `resolveBacklogItems`.
   */
  routes.post('/knowledge-entries', async (c) => {
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

    const resolved = await resolveBacklogItems(c, input, document.id);

    return c.json(
      successEnvelope(
        serializeKnowledgeDocument(document),
        `Saved. It will be searchable in a moment.${resolved}`,
      ),
      201,
    );
  });

  /**
   * The body an entry was written from, for the edit form — so correcting one word does not mean
   * retyping the rest. Available for any entry the caller may **view**, including uploads, because
   * reading what the AI actually sees is how a wrong answer gets diagnosed.
   */
  routes.get('/knowledge-documents/:id/content', async (c) => {
    const service = ingestionFrom(createDatabase(c.env.DB), c.env);
    const document = await service.findFor(requireUser(c), c.req.param('id'), 'view');
    const body = await service.bodyOf(document.id);
    const author = await service.authorOf(document);

    return c.json(
      successEnvelope(
        {
          ...serializeKnowledgeDocument({
            ...document,
            ...(author === null ? {} : { authorName: author.name, authorRole: author.role }),
          }),
          body,
        },
        'Entry content retrieved.',
      ),
    );
  });

  /**
   * Edit an authored entry. Saving re-chunks and re-embeds through the existing reprocess path,
   * so a corrected fact **replaces** the wrong one in the index rather than joining it there.
   *
   * Ownership is enforced in `updateEntry` via `findFor`, so a counselor editing a colleague's
   * entry gets the same 404 as one editing an entry that does not exist. PATCH rather than PUT: a
   * title fix should not require resending the body.
   *
   * `resolves_question` is accepted here as well as on create, because "answer this" is sometimes
   * done by adding to an entry that already exists rather than writing a new one — and a backlog
   * item that clears on one path and not the other is the original bug wearing a different hat.
   */
  routes.patch('/knowledge-entries/:id', async (c) => {
    const input = await parseBody(c, updateKnowledgeEntrySchema);
    const document = await ingestionFrom(createDatabase(c.env.DB), c.env).updateEntry(
      requireUser(c),
      c.req.param('id'),
      input.type === 'qa'
        ? { title: input.question, body: `Q: ${input.question}\nA: ${input.answer}` }
        : { title: input.title, body: input.body },
      clientIp(c),
    );

    const resolved = await resolveBacklogItems(c, input, document.id);

    return c.json(
      successEnvelope(
        serializeKnowledgeDocument(document),
        `Saved. The AI is re-reading it now.${resolved}`,
      ),
    );
  });

  /**
   * **What the knowledge base does not cover** (AiNormalisation Phase 4).
   *
   * Every honest refusal this system has ever made already wrote an `ai_requests` row carrying the
   * question and the reason — the work was done in Phase 5a and nobody had ever looked at it.
   * Surfacing it is what turns a refusal from a dead end into a backlog: answer the top five
   * questions, and the next student to ask any of them gets that answer verbatim from Gate 1, with
   * no model call and no possibility of invention.
   *
   * ## Five endpoints, where there used to be one
   *
   * The previous version of this comment argued the opposite — "one endpoint rather than five,
   * because it is one screen and five round trips on a school's connection is five chances to see a
   * spinner" — and it was right about the screen it was written for. That screen was a single
   * scroll: everything it fetched, it showed.
   *
   * The screen is now four tabs, and the argument inverts with it. One endpoint means every visit
   * runs the catalog-coverage scan and the flagged-answers correlated subquery to render a backlog
   * page nobody asked those questions of — and it means the backlog itself cannot be paginated,
   * because one response cannot carry a page of one list and all of another. Splitting costs a round
   * trip on the tab somebody actually opens and saves the other three entirely.
   *
   * What is *not* split is the header: `corpus` and the tab counts come back from this base endpoint
   * in one read, because they are on screen no matter which tab is open.
   *
   * Scoped per caller throughout. An admin gets the platform; a counselor gets questions from
   * students in their own classes, and a corpus header counting their own contributions rather than
   * a total they cannot act on. The resolved list is scoped differently on purpose — see the
   * service.
   */
  routes.get('/ai-insights', async (c) => {
    const user = requireUser(c);
    const service = new AiInsightsService(createDatabase(c.env.DB));
    const scope = insightsScope(user);
    const isAdmin = user.role === 'admin';

    const [health, unanswered, resolved, flagged, gates] = await Promise.all([
      service.corpusHealth(authorScope(user)),
      service.unansweredCount(scope),
      service.resolvedCount(scope),
      service.flaggedAnswers(scope),
      service.gateDistribution(scope),
    ]);

    return c.json(
      successEnvelope(
        {
          corpus: health,
          /**
           * The tab badges. Counted here rather than read off each tab's `total`, so the number on
           * a tab is right before anybody has opened it — a badge that only appears once you look
           * is not a badge.
           *
           * **This knowingly re-does the backlog merge that `/unanswered` is about to do**, since
           * the count of that list cannot be had without building it (see `unansweredQuestions`).
           * It is a bounded scan of grouped rows, twice, on a staff screen — and it buys back far
           * more than it costs, because the *catalog coverage* scan that used to run on every visit
           * to this report now runs only when somebody opens that tab.
           */
          counts: { unanswered, resolved, flagged: flagged.length },
          // Which gate answered, per day (AI-COVERAGE-PLAN.md Phase 6).
          gates,
          // What this caller is allowed to do, said by the server rather than inferred by the
          // client from a role string. A UI that derives its own permissions is a UI that shows a
          // button the API will refuse.
          can: {
            dismiss_questions: canDismissQuestions(user),
            sync_catalog: isAdmin,
            see_all_knowledge: isAdmin,
          },
        },
        'AI insights retrieved.',
      ),
    );
  });

  /**
   * The backlog, a page at a time.
   *
   * Paginated in the service rather than in SQL — the ordering merges two queries, so the page can
   * only be cut after the merge. See `unansweredQuestions` for the bound that comes with that.
   */
  routes.get('/ai-insights/unanswered', async (c) => {
    const query = parseQuery(c, aiInsightsPageQuerySchema, [...AI_INSIGHTS_QUERY_KEYS]);

    const page = await new AiInsightsService(createDatabase(c.env.DB)).unansweredQuestions(
      insightsScope(requireUser(c)),
      { page: query.page, perPage: query.per_page },
    );

    return c.json(
      successEnvelope(
        {
          items: page.items.map((row) => ({
            key: row.key,
            question: row.question,
            asks: row.asks,
            requests: row.requests,
            last_asked_at: row.lastAskedAt,
            /**
             * Non-null means: this has a live answer and was asked again anyway (migration 0031).
             * The client leads with it, because writing a second entry is not the fix and nothing
             * else on the screen would say so.
             */
            answered_at: row.answeredAt,
          })),
          pagination: page.pagination,
        },
        'Unanswered questions retrieved.',
      ),
    );
  });

  /** What has already been answered or set aside — and the undo for both. */
  routes.get('/ai-insights/resolved', async (c) => {
    const query = parseQuery(c, aiInsightsPageQuerySchema, [...AI_INSIGHTS_QUERY_KEYS]);

    const page = await new AiInsightsService(createDatabase(c.env.DB)).resolvedQuestions(
      insightsScope(requireUser(c)),
      { page: query.page, perPage: query.per_page },
    );

    return c.json(
      successEnvelope(
        {
          items: page.items.map((row) => ({
            id: row.id,
            question: row.question,
            resolution: row.resolution,
            document_id: row.documentId,
            document_title: row.documentTitle,
            live: row.live,
            resolved_by: row.resolvedBy,
            resolved_by_name: row.resolvedByName,
            resolved_by_role: row.resolvedByRole,
            resolved_at: row.resolvedAt,
          })),
          pagination: page.pagination,
        },
        'Resolved questions retrieved.',
      ),
    );
  });

  /** Answers a student marked wrong, with the passages each was built from. Bounded, not paged. */
  routes.get('/ai-insights/flagged', async (c) => {
    const flagged = await new AiInsightsService(createDatabase(c.env.DB)).flaggedAnswers(
      insightsScope(requireUser(c)),
    );

    return c.json(
      successEnvelope(
        flagged.map((row) => ({
          message_id: row.messageId,
          answer: row.answer,
          question: row.question,
          ai_request_id: row.aiRequestId,
          chunk_ids: row.chunkIds,
          created_at: row.createdAt,
        })),
        'Flagged answers retrieved.',
      ),
    );
  });

  /**
   * Which careers and programs have nothing in the corpus about them.
   *
   * Catalog coverage is a platform-wide fact about the sync, and the only fix for a gap in it is the
   * sync button on the admin's screen. A counselor would read a list of things they cannot do
   * anything about, so they are given an empty one rather than a broken promise — the same
   * `EMPTY_COVERAGE` the single endpoint used to hand them.
   */
  routes.get('/ai-insights/coverage', async (c) => {
    const coverage =
      requireUser(c).role === 'admin'
        ? await new AiInsightsService(createDatabase(c.env.DB)).coverage()
        : EMPTY_COVERAGE;

    return c.json(
      successEnvelope(
        {
          careers: coverage.careers,
          programs: coverage.programs,
          gaps: coverage.gaps.map((gap) => ({
            kind: gap.kind,
            id: gap.id,
            label: gap.label,
            stalled: gap.stalled,
          })),
        },
        'Catalog coverage retrieved.',
      ),
    );
  });

  /**
   * Put a resolved question back on the backlog — the undo for both answering and dismissing.
   *
   * Shared rather than admin-only, with ownership enforced in the service: a counselor may reverse
   * their own decision and gets a 404 for anybody else's, the same shape as every other
   * "not yours" in this codebase.
   */
  routes.delete('/knowledge-question-resolutions/:id', async (c) => {
    await new KnowledgeQuestionResolutionService(createDatabase(c.env.DB)).reopen(
      requireUser(c),
      c.req.param('id'),
      clientIp(c),
    );

    return c.json(
      successEnvelope(
        { id: c.req.param('id') },
        'The question is back on the unanswered list.',
      ),
    );
  });

  return routes;
}

/** A counselor's `coverage` block: the shape the client expects, with nothing claimed in it. */
const EMPTY_COVERAGE = {
  careers: { total: 0, covered: 0 },
  programs: { total: 0, covered: 0 },
  gaps: [],
} as const;

/**
 * Mark every backlog question this entry answers, and say so in the response (migration 0031).
 *
 * Three sources, deduplicated:
 *
 *   * `resolves_question` — the backlog row somebody pressed **Answer this** on, in the report's
 *     own wording. An explicit claim.
 *   * `also_resolves` — similar rows the author ticked as covered by the same answer. Explicit
 *     claims too, and opt-in for the reason on the schema.
 *   * **The Q&A pair's own question.** Added after testing the fix on production: every answer
 *     written before migration 0031 — and every Q&A written from scratch since — stayed on the
 *     backlog forever, because nothing claimed it. On 2026-09-11 "Where is Holy Name University
 *     located?" was being answered verbatim by Gate 1 while sitting on the unanswered list. A Q&A
 *     pair *is* a statement that its question is answered, so it now says so itself. If no
 *     backlog row carries that text the resolution matches nothing, which costs one row and hides
 *     nothing.
 *
 * Only the explicit claims are announced: the entry's own question may never have been on the
 * backlog, and "taken off the unanswered list" would then be untrue.
 *
 * **Never throws.** The entry is already saved at this point, and the corpus — the thing that
 * actually answers students — is correct whatever happens here. Failing the request would report a
 * save that did happen as an error, and the natural response to that is to write the entry again,
 * so a transient failure on a bookkeeping row would be laundered into duplicate knowledge. The
 * degraded outcome is a question left on the backlog: visible, harmless, and fixed by answering
 * it again — the right direction to fail in, and the reason the resolution is written second.
 */
async function resolveBacklogItems(
  c: Context<AppEnv>,
  input: CreateKnowledgeEntryInput,
  documentId: string,
): Promise<string> {
  const present = (question: string | undefined): question is string =>
    question !== undefined && question.trim() !== '';
  const claimed = [
    ...new Set([input.resolves_question, ...(input.also_resolves ?? [])].filter(present)),
  ];
  const questions = [
    ...new Set([...claimed, input.type === 'qa' ? input.question : undefined].filter(present)),
  ];

  if (questions.length === 0) {
    return '';
  }

  const service = new KnowledgeQuestionResolutionService(createDatabase(c.env.DB));
  let claimedFailed = 0;

  for (const question of questions) {
    try {
      await service.resolve(requireUser(c), { question, documentId }, clientIp(c));
    } catch (error) {
      if (claimed.includes(question)) {
        claimedFailed += 1;
      }

      console.error(
        JSON.stringify({
          level: 'error',
          correlation_id: c.get('correlationId'),
          message: 'Knowledge entry saved but a backlog item could not be resolved.',
          document_id: documentId,
          cause: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  if (claimed.length === 0) {
    return '';
  }

  if (claimedFailed > 0) {
    return ` The entry was saved, but ${claimedFailed === 1 ? 'a question' : `${claimedFailed} questions`} could not be taken off the unanswered list — answer again from that screen to clear it.`;
  }

  return claimed.length === 1
    ? ' It has been taken off the unanswered list.'
    : ` ${claimed.length} questions have been taken off the unanswered list.`;
}

/**
 * The admin mount: everything above, plus the three things that are not a counselor's to touch —
 * the catalog sync, the AI policy, and dismissing a question for the whole school.
 */
export const adminAiRoutes = new Hono<AppEnv>();

adminAiRoutes.use('*', authenticate());
adminAiRoutes.use('*', ensureRole('admin'));
adminAiRoutes.use('*', ensurePasswordChanged());

adminAiRoutes.route('/', createKnowledgeRoutes());

/**
 * The counselor mount (prompt-driven, 2026-09-11): **a counselor is a global contributor.**
 *
 * What they write lands in the one shared corpus and reaches every student, exactly like an
 * admin's entry — there is no per-counselor retrieval scope and this does not introduce one
 * (`COUNSELOR_PRIVATE` stays deferred to §63 for the reason recorded on the enum). What is scoped
 * is what comes back: their own entries in the library, their own students' questions in the
 * report.
 *
 * `ensureRole('counselor', 'admin')` admits admins too, matching the counselor class routes — an
 * admin following a link into this shell should not hit a wall, and every handler already answers
 * correctly for them because the scoping is derived per user rather than per mount.
 */
export const counselorAiRoutes = new Hono<AppEnv>();

counselorAiRoutes.use('*', authenticate());
counselorAiRoutes.use('*', ensureRole('counselor', 'admin'));
counselorAiRoutes.use('*', ensurePasswordChanged());

counselorAiRoutes.route('/', createKnowledgeRoutes());

/**
 * Take a question off the backlog without answering it — gibberish, a test, an off-domain
 * question nobody will ever write an entry for.
 *
 * **Admin-only, and that is the design rather than an omission.** Unlike an answer, a dismissal
 * has no document behind it, so nothing can ever make it lapse: it is the one action here that
 * holds a question down permanently. It therefore belongs to the role that can see the entire
 * backlog — a counselor sees one student's odd question and cannot know that forty others asked
 * the same thing. Reversible by anyone who could make it, through the resolution DELETE above.
 */
adminAiRoutes.post('/knowledge-questions/dismiss', async (c) => {
  const input = await parseBody(c, dismissQuestionSchema);
  const resolution = await new KnowledgeQuestionResolutionService(
    createDatabase(c.env.DB),
  ).dismiss(requireUser(c), input.question, clientIp(c));

  return c.json(
    successEnvelope(
      { id: resolution.id, question: resolution.question },
      'Dismissed. It will not appear on the unanswered list again.',
    ),
    201,
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
  // The same button refreshes the Guidance corpus, in the background on its own budget.
  await requestGuidanceSync(c.env);

  return c.json(
    successEnvelope(
      result,
      catalogSyncMessage(result),
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

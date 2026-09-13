import { and, count, desc, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';

import type { Database } from '@/db/client';
import {
  aiRequests,
  careers,
  chatConversations,
  chatMessages,
  colleges,
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeQuestionResolutions,
  programs,
  users,
} from '@/db/schema';
import { paginate, type PaginatedData } from '@/lib/envelope';

/**
 * `AiInsightsService` — what the knowledge base does **not** cover (AiNormalisation Phase 4).
 *
 * ## Why this is the most valuable screen in the AI module
 *
 * Every honest refusal this system makes already writes an `ai_requests` row carrying the exact
 * question a student asked and the reason nothing answered it. That has been true since Phase 5a.
 * Nobody has ever looked at it.
 *
 * So there is no pipeline to build here — only a query. What it produces is the thing that makes
 * the whole architecture compound: **a list of the questions students actually asked that the
 * corpus could not answer, ordered by how many students asked them.** Somebody answers the top
 * five, and the next student to ask any of them gets that answer verbatim from Gate 1, with no
 * model call and no possibility of invention.
 *
 * That is the difference between a corpus that is whatever somebody remembered to upload and a
 * corpus that is a record of what students needed.
 *
 * ## What migration 0031 changed, and why it had to
 *
 * The backlog had no memory. `ai_requests` failures and `chat_messages.knowledge_request` rows are
 * both records of past events, and a past event cannot stop having happened — so answering a
 * question removed nothing from this report. The question stayed at the top of the list with its
 * ask count intact, indistinguishable from the ones nobody had touched, and the only way to know
 * which was which was to remember. A backlog nobody can clear is a backlog people stop reading.
 *
 * `knowledge_question_resolutions` is the missing fact — *a person decided this was done* — and
 * every read below joins through it. The join is deliberately **conditional rather than absolute**:
 * a resolution suppresses its question only while the entry behind it is live and only for asks
 * that predate it, so three different kinds of going-wrong heal themselves with no cleanup job:
 *
 *   * the answering entry is archived → the question returns, because it is unanswered again;
 *   * the answering entry failed to process → the question returns, because text that never
 *     embedded is text the AI cannot retrieve, and hiding the gap would be the worst outcome
 *     available (admin believes it is answered, student still gets refused, nothing says so);
 *   * it was asked again after being answered → the question returns carrying **only the new
 *     asks**, which is a better signal than the original gap: the writing is done, so it is the
 *     retrieval that needs looking at.
 *
 * ## Why the reads are shaped the way they are
 *
 * All the reports are single D1 queries with aggregation pushed into SQL. They run on a staff
 * screen, which is the one place in this system where a slow page is merely annoying — but they
 * read tables that grow with every question ever asked, and "select everything and group it in
 * JavaScript" is how a staff screen becomes a timeout in a school's second term.
 */

/** One question, or one family of identically-phrased questions, that nothing could answer. */
export interface UnansweredQuestion {
  /** The normalised identity — what makes two phrasings one row. Never shown to anybody. */
  key: string;
  question: string;
  /** How many times it was asked. The ordering, and the reason to answer this one first. */
  asks: number;
  /**
   * How many students pressed *"Request to add to knowledge"* on the refusal (migration 0030).
   *
   * Almost always 0, and that is the point: it is a student's own voice on top of the pipeline's
   * count, and it sorts above it. A question one student asked to have answered is a better use of
   * an afternoon than one the retrieval merely missed five times.
   */
  requests: number;
  lastAskedAt: string;
  /**
   * Set only when this question **has** a live answer and was asked again anyway (migration 0031).
   *
   * It is the highest-value row on the screen and the rarest. The corpus contains an entry that
   * somebody wrote for exactly this question, and the pipeline still failed to retrieve it — so
   * writing a second entry is not the fix, and the row says so rather than inviting a duplicate.
   */
  answeredAt: string | null;
}

/** A question somebody has already dealt with, for the "done" view and for undo. */
export interface ResolvedQuestion {
  id: string;
  key: string;
  question: string;
  resolution: 'ANSWERED' | 'DISMISSED';
  documentId: string | null;
  /** NULL when the entry was archived or has not finished processing — the resolution is lapsed. */
  documentTitle: string | null;
  /** False when the resolution no longer suppresses anything; the question is back in the backlog. */
  live: boolean;
  resolvedBy: string;
  resolvedByName: string;
  resolvedByRole: string;
  resolvedAt: string;
}

/** A career or program with nothing in the corpus about it. */
export interface CoverageGap {
  kind: 'career' | 'program';
  id: string;
  label: string;
  /** Live, embedded chunks about this row. Zero is the gap; a low number is worth a look. */
  chunks: number;
  /** True when an entry exists but its processing never completed — a different problem. */
  stalled: boolean;
}

export interface CoverageReport {
  careers: { total: number; covered: number };
  programs: { total: number; covered: number };
  gaps: CoverageGap[];
}

/** One answer a student marked wrong, with the provenance needed to find out why. */
export interface FlaggedAnswer {
  messageId: string;
  answer: string;
  question: string | null;
  aiRequestId: string | null;
  /** The chunk ids the answer was generated from — the route to the passage that caused it. */
  chunkIds: string[];
  createdAt: string | null;
}

/**
 * Who is asking, and therefore which students' questions they may see.
 *
 * `null` is an admin: the whole platform. A counselor id narrows every read to students enrolled
 * in that counselor's own classes — the same ownership rule `ClassPolicy` applies everywhere else
 * (§39), pushed into SQL because this screen aggregates rather than fetching a record to check.
 */
export type InsightsScope = { counselorId: string } | null;

/** One page of a report. Defaults match the route schema, so a service call can omit it. */
export interface PageRequest {
  page?: number;
  perPage?: number;
}

/**
 * The most distinct open questions this report will ever consider (prompt-driven, 2026-09-11).
 *
 * **It is a real ceiling, not a page size**, and it exists because `unansweredQuestions` cannot cut
 * its page in SQL: the ordering depends on merging two queries, so the merge has to happen over
 * *some* bounded window and the page is sliced from the sorted result. Past 500 distinct open
 * questions the report shows the top 500 and says so in its total.
 *
 * 500 is chosen as far past what anybody works through — the screen it feeds has a pager, not a
 * scrollbar, and 500 is twenty pages of it. The version before this one capped the entire screen at
 * 25 with a "Show more" button, so the honest bound is twenty times looser than the silent one it
 * replaced.
 */
const UNANSWERED_SCAN_CEILING = 500;

/**
 * The failure reasons that mean *"the knowledge base did not cover this"*, as opposed to *"the
 * model was unavailable"*.
 *
 * The distinction is the entire point of the report. A `MODEL_ERROR` or `QUOTA_EXHAUSTED` row is
 * an operational problem that no amount of writing will fix, and mixing those in would bury the
 * actionable rows under noise on exactly the days when the platform was having trouble.
 */
const COVERAGE_FAILURE_PATTERNS = ['SKIPPED%', '%NO_GROUNDING%'] as const;

/**
 * **The one definition of "these two strings are the same question"** (migration 0031).
 *
 * There is no question entity in this system — a question is text, and it is reached two different
 * ways: the refusal list groups on `ai_requests.input_context.retrieval_query`, while the
 * student-request list groups on the raw `chat_messages.content` of the preceding turn. Those are
 * the same sentence and almost never the same bytes: different capitalisation, a trailing "?", a
 * stray space. Merging them on raw text — which is what this report used to do — meant one question
 * could appear twice, once from each list, each with half the evidence.
 *
 * It is SQL rather than TypeScript on purpose, and that is the load-bearing decision. The key
 * stored on a resolution row and the key computed over `ai_requests` at read time are produced by
 * **this same expression**, so they cannot disagree. A JS normaliser writing the column and a SQL
 * one matching it is the classic pair that drifts one refactor later and then fails silently, by
 * showing a resolved question again forever with nothing to indicate why.
 *
 * `rtrim(X, Y)` strips any of Y's characters from the right, so trailing punctuation goes without
 * touching a question mark in the middle of a sentence. Interior whitespace is deliberately left
 * alone: collapsing it in SQLite takes nested `replace` calls that are hard to read and harder to
 * keep identical, and the cost of not doing it is two rows in a rare case rather than a resolution
 * that silently stops matching.
 */
function questionKey(expression: SQL<string> | SQL<string | null>): SQL<string> {
  return sql<string>`rtrim(lower(trim(${expression})), ' ?.!')`;
}

/** The retrieval query a refusal recorded — the text the pipeline actually failed to match. */
const REFUSAL_QUESTION = sql<
  string | null
>`json_extract(ai_requests.input_context, '$.retrieval_query')`;

/**
 * True when `keyExpression`'s question has a resolution that still covers an ask made at
 * `askedAtExpression`.
 *
 * The three conditions of migration 0031, in one place because both backlog reads need exactly
 * this test and a copy that fell out of step would silently diverge — one list clearing a question
 * the other still shows is worse than neither clearing it.
 *
 * Table names are written out rather than interpolated from the Drizzle objects: inside a raw
 * subquery Drizzle renders a column reference unqualified, and a bare `created_at` would bind to
 * the subquery's own tables instead of the outer row. Same reason `coverage()` spells out
 * `careers.id`.
 */
function coveredByResolution(keyExpression: SQL<string>, askedAtExpression: SQL): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM knowledge_question_resolutions r
    LEFT JOIN knowledge_documents d ON d.id = r.document_id
    WHERE r.question_key = ${keyExpression}
      AND (
        -- Dismissed: no document to lapse with, so it suppresses the question for good. This is
        -- the only disposition that can hold a question down permanently, which is why it is the
        -- only one an admin has to choose deliberately.
        r.resolution = 'DISMISSED'
        OR (
          r.resolution = 'ANSWERED'
          -- A resolution whose entry is archived, FAILED, or missing entirely covers nothing.
          AND d.id IS NOT NULL
          AND d.archived_at IS NULL
          AND d.processing_status <> 'FAILED'
          -- …and only covers asks that came before it. Anything newer is the question being asked
          -- again *despite* the answer, which is a retrieval problem and belongs on the screen.
          AND ${askedAtExpression} <= r.created_at
        )
      )
  )`;
}

/**
 * When this question's live answer was written, or NULL.
 *
 * Only ever non-NULL on a row that survived `coveredByResolution` — which means the question has
 * an answer *and* was asked again since. That combination is what the UI flags.
 */
function liveAnswerAt(keyExpression: SQL<string>): SQL<string | null> {
  return sql<string | null>`(
    SELECT r.created_at
    FROM knowledge_question_resolutions r
    JOIN knowledge_documents d ON d.id = r.document_id
    WHERE r.question_key = ${keyExpression}
      AND r.resolution = 'ANSWERED'
      AND d.archived_at IS NULL
      AND d.processing_status <> 'FAILED'
  )`;
}

/**
 * The students a counselor may see questions from: enrolled, not removed, in one of their own
 * classes that has not been deleted.
 *
 * A question asked by a student who is in nobody's class — or by nobody at all, which is what a
 * NULL `user_id` means — is visible to admins only. That is the honest consequence of scoping by
 * enrolment rather than a bug to paper over: there is no counselor it belongs to.
 */
function studentsOfCounselor(counselorId: string): SQL {
  return sql`(
    SELECT cs.student_id
    FROM class_students cs
    JOIN classes c ON c.id = cs.class_id
    WHERE c.counselor_id = ${counselorId}
      AND c.deleted_at IS NULL
      AND cs.status = 'active'
  )`;
}

export class AiInsightsService {
  constructor(private readonly db: Database) {}

  /**
   * Questions nothing answered — the ones students **asked us to answer** first, then most-asked.
   *
   * Grouped on `questionKey` rather than on raw text, because that is the only thing that makes
   * the two halves below one list instead of two overlapping ones.
   *
   * The second read is migration 0030's addition: the refusals a student pressed *"Request to add
   * to knowledge"* on. Those are the same questions — every refusal logs one of the `ai_requests`
   * rows above — so this is a **merge, not a second list**: it lifts the ones a person asked for to
   * the top of the backlog the pipeline was already keeping. A requested question with no matching
   * request row is still shown, because a missing join is not a reason to drop the one signal in
   * this report that a human volunteered.
   *
   * Both halves apply the same resolution filter, in SQL, *before* the limit — so a page of 25 is
   * 25 open questions rather than 25 rows of which some unknown number have already been dealt
   * with.
   *
   * ## Pagination, and the bound it comes with
   *
   * **The page can only be cut after the merge, never in SQL.** The ordering is a function of both
   * halves — a question asked once that a student *requested* outranks one asked twice that nobody
   * did — so a SQL `OFFSET` on either half alone would skip rows that belong on the page and
   * include rows that do not. The merge therefore runs over a bounded window and the page is sliced
   * from the sorted result.
   *
   * That window is `UNANSWERED_SCAN_CEILING`, and it is a real limit worth stating rather than
   * hiding: past 500 distinct open questions this report shows the top 500, and `total` says 500.
   * The previous version of this method capped the whole screen at 25 with a "Show more" button, so
   * this is twenty pages where there was one — and 500 unanswered questions is a backlog nobody is
   * working through by scrolling anyway.
   */
  async unansweredQuestions(
    scope: InsightsScope = null,
    { page = 1, perPage = 25 }: PageRequest = {},
  ): Promise<PaginatedData<UnansweredQuestion>> {
    const merged = await this.mergedUnanswered(scope);
    const offset = (page - 1) * perPage;

    return paginate(merged.slice(offset, offset + perPage), merged.length, page, perPage);
  }

  /** How many open questions there are — the tab badge, and the pager's `total`. */
  async unansweredCount(scope: InsightsScope = null): Promise<number> {
    return (await this.mergedUnanswered(scope)).length;
  }

  /**
   * The merged, sorted backlog, bounded at `UNANSWERED_SCAN_CEILING`.
   *
   * Shared by the page read and the count so the two can never disagree about how many open
   * questions exist — a badge saying 40 above a pager saying "3 pages of 25" is the kind of
   * contradiction that makes a screen untrustworthy in a way nobody can quite pin down.
   */
  private async mergedUnanswered(scope: InsightsScope): Promise<UnansweredQuestion[]> {
    const limit = UNANSWERED_SCAN_CEILING;
    const key = questionKey(REFUSAL_QUESTION);

    const rows = await this.db
      .select({
        key,
        // `max` rather than a bare column because the group is keyed on the *normalised* text:
        // several spellings collapse into one row, and this picks one of them to show. The most
        // recent would be marginally nicer and costs a window function; any of them is correct.
        question: sql<string>`max(${REFUSAL_QUESTION})`,
        asks: count(),
        lastAskedAt: sql<string>`max(ai_requests.created_at)`,
        answeredAt: sql<string | null>`max(${liveAnswerAt(key)})`,
      })
      .from(aiRequests)
      .where(
        and(
          eq(aiRequests.status, 'FAILED'),
          // Student questions only (found testing on production, 2026-09-11). The explanation
          // pipeline logs its retrieval misses here too, and its "question" is a string it builds
          // itself — "Network Engineer. Designs and operates the networks…" — which was half the
          // live backlog, named institutions the catalog no longer holds, and invited somebody to
          // write a Q&A whose question no student would ever type. Those gaps are about a career or
          // a program, and `coverage()` already reports them by entity, which is where
          // they can actually be fixed.
          eq(aiRequests.requestType, 'CHAT'),
          sql`(${aiRequests.failureReason} LIKE ${COVERAGE_FAILURE_PATTERNS[0]} OR ${aiRequests.failureReason} LIKE ${COVERAGE_FAILURE_PATTERNS[1]})`,
          sql`${REFUSAL_QUESTION} IS NOT NULL AND trim(${REFUSAL_QUESTION}) <> ''`,
          sql`NOT ${coveredByResolution(key, sql`ai_requests.created_at`)}`,
          scope === null
            ? undefined
            : sql`ai_requests.user_id IN ${studentsOfCounselor(scope.counselorId)}`,
        ),
      )
      .groupBy(key)
      .orderBy(desc(count()), desc(sql`max(ai_requests.created_at)`))
      .limit(limit);

    const requested = await this.knowledgeRequests(scope, limit);

    const merged = new Map<string, UnansweredQuestion>();

    for (const row of rows) {
      merged.set(row.key, {
        key: row.key,
        question: row.question,
        asks: Number(row.asks),
        requests: 0,
        lastAskedAt: row.lastAskedAt,
        answeredAt: row.answeredAt,
      });
    }

    for (const row of requested) {
      const existing = merged.get(row.key);

      if (existing === undefined) {
        // No `ai_requests` row grouped to this key — an older refusal, or a question logged before
        // the pipeline recorded a retrieval query. `asks` falls back to the requests, which is the
        // only count there is evidence for.
        merged.set(row.key, {
          key: row.key,
          question: row.question,
          asks: row.requests,
          requests: row.requests,
          lastAskedAt: row.lastAskedAt,
          answeredAt: row.answeredAt,
        });
        continue;
      }

      existing.requests = row.requests;
      existing.answeredAt ??= row.answeredAt;
    }

    return [...merged.values()]
      .sort(
        (a, b) =>
          // An answered question that came back outranks everything: the corpus already holds an
          // answer somebody wrote and the pipeline is not finding it, so writing another entry
          // would be wasted work — and nothing else on this screen would ever say so.
          Number(b.answeredAt !== null) - Number(a.answeredAt !== null) ||
          b.requests - a.requests ||
          b.asks - a.asks ||
          b.lastAskedAt.localeCompare(a.lastAskedAt) ||
          // A total order, so paging is stable. Without a final tie-break, two rows that match on
          // every field above can come back in either relative order between two queries — and the
          // one caught in the seam between page 1 and page 2 then appears on both or neither.
          a.key.localeCompare(b.key),
      )
      .slice(0, limit);
  }

  /**
   * The refusals students pressed *"Request to add to knowledge"* on, grouped by the question that
   * produced them (migration 0030).
   *
   * The question is the **preceding user message** in the same conversation, which is the same
   * correlated subquery `flaggedAnswers` uses and is exact rather than approximate: a turn is
   * question-then-answer, written in that order, in one conversation.
   */
  private async knowledgeRequests(
    scope: InsightsScope,
    limit: number,
  ): Promise<
    { key: string; question: string; requests: number; lastAskedAt: string; answeredAt: string | null }[]
  > {
    const asked = sql<string>`(
      SELECT q.content FROM chat_messages q
      WHERE q.conversation_id = ${chatMessages.conversationId}
        AND q.role = 'user'
        AND q.created_at <= ${chatMessages.createdAt}
      ORDER BY q.created_at DESC, q.id DESC
      LIMIT 1
    )`;

    const key = questionKey(asked);

    const rows = await this.db
      .select({
        key,
        question: sql<string>`max(${asked})`,
        requests: count(),
        lastAskedAt: sql<string>`max(${chatMessages.createdAt})`,
        answeredAt: sql<string | null>`max(${liveAnswerAt(key)})`,
      })
      .from(chatMessages)
      // Joined rather than sub-selected because the counselor scope needs the student id, and a
      // conversation always has one — an inner join adds no rows and drops none.
      .innerJoin(chatConversations, eq(chatConversations.id, chatMessages.conversationId))
      .where(
        and(
          eq(chatMessages.knowledgeRequest, 'REQUESTED'),
          sql`NOT ${coveredByResolution(key, sql`chat_messages.created_at`)}`,
          scope === null
            ? undefined
            : sql`${chatConversations.studentId} IN ${studentsOfCounselor(scope.counselorId)}`,
        ),
      )
      .groupBy(key)
      .orderBy(desc(count()))
      .limit(limit);

    return rows
      .filter((row) => typeof row.question === 'string' && row.question.trim() !== '')
      .map((row) => ({
        key: row.key,
        question: row.question,
        requests: Number(row.requests),
        lastAskedAt: row.lastAskedAt,
        answeredAt: row.answeredAt,
      }));
  }

  /**
   * What has already been dealt with — the other half of a backlog.
   *
   * Two audiences, one query. An admin reads it as who-answered-what across the platform; a
   * counselor reads it as their own contribution, which is why `scope` filters on `resolved_by`
   * here rather than on the asking student. A counselor's answer is global the moment it is
   * written (the corpus has no per-counselor visibility — §63 is still deferred), so scoping this
   * list by student would show them a question they answered and then hide the answer.
   *
   * `live` is the column worth reading: false means the resolution has lapsed — its entry was
   * archived, or never finished processing — and the question is therefore back in the backlog.
   * Surfacing it here is how somebody finds out that an answer they wrote has stopped counting.
   */
  async resolvedQuestions(
    scope: InsightsScope = null,
    { page = 1, perPage = 25 }: PageRequest = {},
  ): Promise<PaginatedData<ResolvedQuestion>> {
    // Exact, unlike the unanswered count: this is one indexed table with no merge over it, so the
    // total is a `COUNT(*)` under the same predicate rather than a bounded scan.
    const where = this.resolvedScope(scope);

    const [rows, [total]] = await Promise.all([
      this.resolvedRows(where, page, perPage),
      this.db.select({ value: count() }).from(knowledgeQuestionResolutions).where(where),
    ]);

    return paginate(rows, total?.value ?? 0, page, perPage);
  }

  /** The badge count for the "Already dealt with" tab. */
  async resolvedCount(scope: InsightsScope = null): Promise<number> {
    const [total] = await this.db
      .select({ value: count() })
      .from(knowledgeQuestionResolutions)
      .where(this.resolvedScope(scope));

    return total?.value ?? 0;
  }

  private resolvedScope(scope: InsightsScope) {
    return scope === null
      ? undefined
      : eq(knowledgeQuestionResolutions.resolvedBy, scope.counselorId);
  }

  private async resolvedRows(
    where: ReturnType<AiInsightsService['resolvedScope']>,
    page: number,
    perPage: number,
  ): Promise<ResolvedQuestion[]> {
    const rows = await this.db
      .select({
        id: knowledgeQuestionResolutions.id,
        key: knowledgeQuestionResolutions.questionKey,
        question: knowledgeQuestionResolutions.question,
        resolution: knowledgeQuestionResolutions.resolution,
        documentId: knowledgeQuestionResolutions.documentId,
        documentTitle: knowledgeDocuments.title,
        archivedAt: knowledgeDocuments.archivedAt,
        processingStatus: knowledgeDocuments.processingStatus,
        resolvedBy: knowledgeQuestionResolutions.resolvedBy,
        resolvedByName: users.name,
        resolvedByRole: users.role,
        resolvedAt: knowledgeQuestionResolutions.createdAt,
      })
      .from(knowledgeQuestionResolutions)
      .leftJoin(
        knowledgeDocuments,
        eq(knowledgeDocuments.id, knowledgeQuestionResolutions.documentId),
      )
      .innerJoin(users, eq(users.id, knowledgeQuestionResolutions.resolvedBy))
      .where(where)
      // `id` as the tie-break, so paging is stable: `created_at` has second resolution and two
      // questions answered in the same second would otherwise be free to swap between page reads,
      // which shows one row twice and hides another entirely.
      .orderBy(desc(knowledgeQuestionResolutions.createdAt), desc(knowledgeQuestionResolutions.id))
      .limit(perPage)
      .offset((page - 1) * perPage);

    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      question: row.question,
      resolution: row.resolution,
      documentId: row.documentId,
      // The title is only meaningful while the entry still counts; showing it for an archived
      // entry would read as "answered by this", which is the opposite of what has happened.
      documentTitle:
        row.archivedAt === null && row.processingStatus !== 'FAILED' ? row.documentTitle : null,
      live:
        row.resolution === 'DISMISSED' ||
        (row.documentId !== null &&
          row.archivedAt === null &&
          row.processingStatus !== 'FAILED'),
      resolvedBy: row.resolvedBy,
      resolvedByName: row.resolvedByName,
      resolvedByRole: row.resolvedByRole,
      resolvedAt: row.resolvedAt,
    }));
  }

  /**
   * Which careers and programs have nothing in the corpus about them.
   *
   * The target is zero gaps, and after a catalog sync it normally is — which is precisely why
   * this screen is worth having: a gap here means the sync did not reach that row, or its entry
   * failed to process, and neither of those announces itself anywhere else. A student asking
   * about that program gets a refusal, and the refusal looks like every other refusal.
   *
   * `stalled` separates the two causes. No entry at all is a sync that has not run; an entry whose
   * chunks never embedded is a job that failed, which is fixed with the reprocess button rather
   * than by writing anything.
   */
  async coverage(limit = 50): Promise<CoverageReport> {
    const careerRows = await this.db
      .select({
        id: careers.id,
        label: careers.title,
        // `careers.id` written out rather than interpolated: Drizzle renders a column reference
        // inside raw SQL unqualified, and a bare `id` is ambiguous against the subquery's own
        // tables. The alias-qualified form is the only one SQLite can resolve.
        chunks: sql<number>`(
          SELECT COUNT(*) FROM knowledge_chunks c
          JOIN knowledge_documents d ON d.id = c.document_id
          WHERE c.entity_type = 'career' AND c.entity_id = careers.id
            AND d.archived_at IS NULL AND c.vector_id IS NOT NULL
        )`,
        entries: sql<number>`(
          SELECT COUNT(*) FROM knowledge_documents d
          WHERE d.entity_type = 'career' AND d.entity_id = careers.id AND d.archived_at IS NULL
        )`,
      })
      .from(careers)
      .where(and(eq(careers.status, 'active'), isNull(careers.deletedAt)));

    const programRows = await this.db
      .select({
        id: programs.id,
        label: sql<string>`${programs.name} || ' at ' || ${colleges.name}`,
        chunks: sql<number>`(
          SELECT COUNT(*) FROM knowledge_chunks c
          JOIN knowledge_documents d ON d.id = c.document_id
          WHERE c.entity_type = 'program' AND c.entity_id = programs.id
            AND d.archived_at IS NULL AND c.vector_id IS NOT NULL
        )`,
        entries: sql<number>`(
          SELECT COUNT(*) FROM knowledge_documents d
          WHERE d.entity_type = 'program' AND d.entity_id = programs.id AND d.archived_at IS NULL
        )`,
      })
      .from(programs)
      .innerJoin(colleges, eq(programs.collegeId, colleges.id))
      .where(and(eq(programs.status, 'active'), isNull(programs.deletedAt)));

    const gapsFrom = (
      kind: 'career' | 'program',
      rows: { id: string; label: string; chunks: number; entries: number }[],
    ): CoverageGap[] =>
      rows
        .filter((row) => Number(row.chunks) === 0)
        .map((row) => ({
          kind,
          id: row.id,
          label: row.label,
          chunks: 0,
          // An entry exists but nothing embedded: a failed job, not a missing sync.
          stalled: Number(row.entries) > 0,
        }));

    const gaps = [...gapsFrom('career', careerRows), ...gapsFrom('program', programRows)];

    return {
      careers: {
        total: careerRows.length,
        covered: careerRows.filter((row) => Number(row.chunks) > 0).length,
      },
      programs: {
        total: programRows.length,
        covered: programRows.filter((row) => Number(row.chunks) > 0).length,
      },
      // Stalled entries first: they are one button away from being fixed, and a screen that buries
      // the fixable behind the merely absent is a screen that gets closed.
      gaps: gaps.sort((a, b) => Number(b.stalled) - Number(a.stalled)).slice(0, limit),
    };
  }

  /**
   * Answers a student marked wrong, newest first, each with the question that produced it and the
   * chunk ids behind it.
   *
   * The chunk ids are the point. A thumbs-down without provenance is a complaint; with it, an
   * admin reads the answer, follows the ids to the passage that produced it, and either corrects
   * that entry or archives it. Both are one click from here, because Phase 1 made every entry
   * editable.
   */
  async flaggedAnswers(scope: InsightsScope = null, limit = 25): Promise<FlaggedAnswer[]> {
    const asked = sql<string | null>`(
      SELECT q.content FROM chat_messages q
      WHERE q.conversation_id = ${chatMessages.conversationId}
        AND q.role = 'user'
        AND q.created_at <= ${chatMessages.createdAt}
      ORDER BY q.created_at DESC, q.id DESC
      LIMIT 1
    )`;

    const rows = await this.db
      .select({
        messageId: chatMessages.id,
        answer: chatMessages.content,
        question: asked,
        aiRequestId: chatMessages.aiRequestId,
        inputContext: aiRequests.inputContext,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .innerJoin(chatConversations, eq(chatConversations.id, chatMessages.conversationId))
      .leftJoin(aiRequests, eq(aiRequests.id, chatMessages.aiRequestId))
      .where(
        and(
          isNotNull(chatMessages.feedback),
          eq(chatMessages.feedback, 'DOWN'),
          scope === null
            ? undefined
            : sql`${chatConversations.studentId} IN ${studentsOfCounselor(scope.counselorId)}`,
        ),
      )
      .orderBy(desc(chatMessages.createdAt))
      .limit(limit);

    return rows.map((row) => ({
      messageId: row.messageId,
      answer: row.answer,
      question: row.question,
      aiRequestId: row.aiRequestId,
      chunkIds: chunkIdsOf(row.inputContext),
      createdAt: row.createdAt,
    }));
  }

  /**
   * How much of the corpus is live, for the header of the screen.
   *
   * `pending` is the number that matters operationally: entries whose text exists but whose
   * vectors do not are entries the AI cannot retrieve, and they look identical to healthy ones in
   * every other list.
   *
   * `authorId` narrows it to one person's own contributions — what a counselor sees, since the
   * platform-wide total is not theirs to act on and a "3 failed" banner about somebody else's
   * uploads is a banner they can do nothing about.
   */
  /**
   * **Which gate answered, per day** (AI-COVERAGE-PLAN.md Phase 6).
   *
   * The measure of whether the assistant is covering what students ask: curated (Gate 1, an
   * admin's words), lookup (Gate 2, from the catalog or the student's results), generated (Gate 3,
   * passed the grounding contract) and refused (every refusal and redirect). Lookups and refusals
   * share the `CANNED` kind and are told apart by whether a source was named — see `ChatService`.
   *
   * `tokens` is the text model's daily token use from `ai_requests`, the input to the Free plan's
   * 10,000-neuron budget. Assistant messages written before answer kinds were recorded (NULL) are
   * counted in `total` only.
   */
  async gateDistribution(
    scope: InsightsScope = null,
    days = 14,
  ): Promise<{
    days: {
      date: string;
      curated: number;
      lookup: number;
      generated: number;
      refused: number;
      total: number;
      tokens: number;
    }[];
  }> {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const studentScope =
      scope === null
        ? undefined
        : sql`${chatConversations.studentId} IN ${studentsOfCounselor(scope.counselorId)}`;

    const answers = await this.db
      .select({
        date: sql<string>`substr(${chatMessages.createdAt}, 1, 10)`,
        curated: sql<number>`sum(case when ${chatMessages.answerKind} = 'CURATED' then 1 else 0 end)`,
        lookup: sql<number>`sum(case when ${chatMessages.answerKind} = 'CANNED' and ${chatMessages.sources} is not null then 1 else 0 end)`,
        generated: sql<number>`sum(case when ${chatMessages.answerKind} = 'KNOWLEDGE' then 1 else 0 end)`,
        refused: sql<number>`sum(case when ${chatMessages.answerKind} = 'CANNED' and ${chatMessages.sources} is null then 1 else 0 end)`,
        total: count(),
      })
      .from(chatMessages)
      .innerJoin(chatConversations, eq(chatConversations.id, chatMessages.conversationId))
      .where(
        and(
          eq(chatMessages.role, 'assistant'),
          sql`${chatMessages.createdAt} >= ${since}`,
          studentScope,
        ),
      )
      .groupBy(sql`substr(${chatMessages.createdAt}, 1, 10)`);

    const tokens = await this.db
      .select({
        date: sql<string>`substr(${aiRequests.createdAt}, 1, 10)`,
        tokens: sql<number>`coalesce(sum(${aiRequests.tokensUsed}), 0)`,
      })
      .from(aiRequests)
      .where(
        and(
          sql`${aiRequests.createdAt} >= ${since}`,
          scope === null
            ? undefined
            : sql`${aiRequests.userId} IN ${studentsOfCounselor(scope.counselorId)}`,
        ),
      )
      .groupBy(sql`substr(${aiRequests.createdAt}, 1, 10)`);

    const byDate = new Map<string, { curated: number; lookup: number; generated: number; refused: number; total: number; tokens: number }>();

    for (const row of answers) {
      byDate.set(row.date, {
        curated: Number(row.curated ?? 0),
        lookup: Number(row.lookup ?? 0),
        generated: Number(row.generated ?? 0),
        refused: Number(row.refused ?? 0),
        total: Number(row.total ?? 0),
        tokens: 0,
      });
    }

    for (const row of tokens) {
      const entry = byDate.get(row.date) ?? { curated: 0, lookup: 0, generated: 0, refused: 0, total: 0, tokens: 0 };

      entry.tokens = Number(row.tokens ?? 0);
      byDate.set(row.date, entry);
    }

    return {
      days: [...byDate.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, entry]) => ({ date, ...entry })),
    };
  }

  async corpusHealth(
    authorId?: string,
  ): Promise<{ entries: number; chunks: number; embedded: number; failed: number }> {
    const scope = and(
      isNull(knowledgeDocuments.archivedAt),
      authorId === undefined ? undefined : eq(knowledgeDocuments.uploadedBy, authorId),
    );

    const [documents] = await this.db
      .select({
        entries: count(),
        failed: sql<number>`sum(case when ${knowledgeDocuments.processingStatus} = 'FAILED' then 1 else 0 end)`,
      })
      .from(knowledgeDocuments)
      .where(scope);

    const [chunks] = await this.db
      .select({
        chunks: count(),
        embedded: sql<number>`sum(case when ${knowledgeChunks.vectorId} is not null then 1 else 0 end)`,
      })
      .from(knowledgeChunks)
      .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId))
      .where(scope);

    return {
      entries: Number(documents?.entries ?? 0),
      failed: Number(documents?.failed ?? 0),
      chunks: Number(chunks?.chunks ?? 0),
      embedded: Number(chunks?.embedded ?? 0),
    };
  }
}

/** The chunk ids an `ai_requests.input_context` recorded, defensively — it is JSON from a column. */
function chunkIdsOf(inputContext: unknown): string[] {
  if (inputContext === null || typeof inputContext !== 'object') {
    return [];
  }

  const ids = (inputContext as { chunk_ids?: unknown }).chunk_ids;

  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

/** Exported for the resolution service, which must write the key this report matches on. */
export { questionKey };

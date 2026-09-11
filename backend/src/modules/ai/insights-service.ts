import { and, count, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import type { Database } from '@/db/client';
import {
  aiRequests,
  careers,
  chatMessages,
  colleges,
  knowledgeChunks,
  knowledgeDocuments,
  programs,
} from '@/db/schema';

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
 * corpus could not answer, ordered by how many students asked them.** An admin answers the top
 * five, and the next student to ask any of them gets that answer verbatim from Gate 1, with no
 * model call and no possibility of invention.
 *
 * That is the difference between a corpus that is whatever somebody remembered to upload and a
 * corpus that is a record of what students needed.
 *
 * ## Why the reads are shaped the way they are
 *
 * All three reports are single D1 queries with aggregation pushed into SQL. They run on an admin
 * screen, which is the one place in this system where a slow page is merely annoying — but they
 * read tables that grow with every question ever asked, and "select everything and group it in
 * JavaScript" is how an admin screen becomes a timeout in a school's second term.
 */

/** One question, or one family of identically-phrased questions, that nothing could answer. */
export interface UnansweredQuestion {
  question: string;
  /** How many times it was asked. The ordering, and the reason to answer this one first. */
  asks: number;
  /**
   * How many students pressed *"Request to add to knowledge"* on the refusal (migration 0030).
   *
   * Almost always 0, and that is the point: it is a student's own voice on top of the pipeline's
   * count, and it sorts above it. A question one student asked to have answered is a better use of
   * an admin's afternoon than one the retrieval merely missed five times.
   */
  requests: number;
  lastAskedAt: string;
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
 * The failure reasons that mean *"the knowledge base did not cover this"*, as opposed to *"the
 * model was unavailable"*.
 *
 * The distinction is the entire point of the report. A `MODEL_ERROR` or `QUOTA_EXHAUSTED` row is
 * an operational problem that no amount of admin writing will fix, and mixing those in would bury
 * the actionable rows under noise on exactly the days when the platform was having trouble.
 */
const COVERAGE_FAILURE_PATTERNS = ['SKIPPED%', '%NO_GROUNDING%'] as const;

export class AiInsightsService {
  constructor(private readonly db: Database) {}

  /**
   * Questions nothing answered — the ones students **asked us to answer** first, then most-asked.
   *
   * Grouped on the **retrieval query** rather than on the raw message, because that is the text
   * the pipeline actually failed to match and because two students phrasing one question two ways
   * are one gap, not two. `json_extract` reaches into `input_context`, which is where every
   * pipeline in this module already records it.
   *
   * The second read is migration 0030's addition: the refusals a student pressed *"Request to add
   * to knowledge"* on. Those are the same questions — every refusal logs one of the `ai_requests`
   * rows above — so this is a **merge, not a second list**: it lifts the ones a person asked for
   * to the top of the backlog the pipeline was already keeping. A requested question with no
   * matching request row is still shown, because a missing join is not a reason to drop the one
   * signal in this report that a human volunteered.
   */
  async unansweredQuestions(limit = 25): Promise<UnansweredQuestion[]> {
    const question = sql<string>`json_extract(${aiRequests.inputContext}, '$.retrieval_query')`;

    const [rows, requested] = await Promise.all([
      this.db
        .select({
          question,
          asks: count(),
          lastAskedAt: sql<string>`max(${aiRequests.createdAt})`,
        })
        .from(aiRequests)
        .where(
          and(
            eq(aiRequests.status, 'FAILED'),
            sql`(${aiRequests.failureReason} LIKE ${COVERAGE_FAILURE_PATTERNS[0]} OR ${aiRequests.failureReason} LIKE ${COVERAGE_FAILURE_PATTERNS[1]})`,
            sql`${question} IS NOT NULL AND trim(${question}) <> ''`,
          ),
        )
        .groupBy(question)
        .orderBy(desc(count()), desc(sql`max(${aiRequests.createdAt})`))
        // Over-read, because the merge below can promote a requested question from outside the
        // top `limit` — a gap asked once and requested once outranks one asked twice and requested
        // never, and slicing before the merge would hide exactly those.
        .limit(limit * 2),
      this.knowledgeRequests(limit),
    ]);

    const merged = new Map<string, UnansweredQuestion>();

    for (const row of rows) {
      merged.set(row.question, {
        question: row.question,
        asks: Number(row.asks),
        requests: 0,
        lastAskedAt: row.lastAskedAt,
      });
    }

    for (const row of requested) {
      const existing = merged.get(row.question);

      if (existing === undefined) {
        // No `ai_requests` row grouped to this text — an older refusal, or a question logged
        // before the pipeline recorded a retrieval query. `asks` falls back to the requests, which
        // is the only count there is evidence for.
        merged.set(row.question, {
          question: row.question,
          asks: row.requests,
          requests: row.requests,
          lastAskedAt: row.lastAskedAt,
        });
        continue;
      }

      existing.requests = row.requests;
    }

    return [...merged.values()]
      .sort(
        (a, b) =>
          b.requests - a.requests ||
          b.asks - a.asks ||
          b.lastAskedAt.localeCompare(a.lastAskedAt),
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
    limit: number,
  ): Promise<{ question: string; requests: number; lastAskedAt: string }[]> {
    const asked = sql<string>`(
      SELECT q.content FROM chat_messages q
      WHERE q.conversation_id = ${chatMessages.conversationId}
        AND q.role = 'user'
        AND q.created_at <= ${chatMessages.createdAt}
      ORDER BY q.created_at DESC, q.id DESC
      LIMIT 1
    )`;

    const rows = await this.db
      .select({
        question: asked,
        requests: count(),
        lastAskedAt: sql<string>`max(${chatMessages.createdAt})`,
      })
      .from(chatMessages)
      .where(eq(chatMessages.knowledgeRequest, 'REQUESTED'))
      .groupBy(asked)
      .orderBy(desc(count()))
      .limit(limit);

    return rows
      .filter((row) => typeof row.question === 'string' && row.question.trim() !== '')
      .map((row) => ({
        question: row.question,
        requests: Number(row.requests),
        lastAskedAt: row.lastAskedAt,
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
  async flaggedAnswers(limit = 25): Promise<FlaggedAnswer[]> {
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
      .leftJoin(aiRequests, eq(aiRequests.id, chatMessages.aiRequestId))
      .where(and(isNotNull(chatMessages.feedback), eq(chatMessages.feedback, 'DOWN')))
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
   */
  async corpusHealth(): Promise<{ entries: number; chunks: number; embedded: number; failed: number }> {
    const [documents] = await this.db
      .select({
        entries: count(),
        failed: sql<number>`sum(case when ${knowledgeDocuments.processingStatus} = 'FAILED' then 1 else 0 end)`,
      })
      .from(knowledgeDocuments)
      .where(isNull(knowledgeDocuments.archivedAt));

    const [chunks] = await this.db
      .select({
        chunks: count(),
        embedded: sql<number>`sum(case when ${knowledgeChunks.vectorId} is not null then 1 else 0 end)`,
      })
      .from(knowledgeChunks)
      .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId))
      .where(isNull(knowledgeDocuments.archivedAt));

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

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Database } from '@/db/client';
import {
  chatConversations,
  chatMessages,
  knowledgeQuestionResolutions,
  type KnowledgeQuestionResolution,
  type User,
} from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { ApiError } from '@/lib/envelope';
import { questionKey } from '@/modules/ai/insights-service';
import { AuditService } from '@/modules/platform/audit-service';
import { NotificationService } from '@/modules/platform/notification-service';

/**
 * `KnowledgeQuestionResolutionService` — the write half of migration 0031.
 *
 * `AiInsightsService` reads the backlog; this writes down the fact that somebody dealt with a row
 * on it. The split is the ordinary one in this module (reads aggregate, writes audit), and it
 * matters more than usual here because the read is the *only* consumer: every rule about when a
 * resolution stops counting lives in `coveredByResolution`, and nothing in this file is allowed to
 * second-guess it. All this does is record a decision and who made it.
 *
 * ## Why the key is never computed here
 *
 * `questionKey` is a SQL expression, imported rather than reimplemented, and it is applied to the
 * bound question on the way into the INSERT. So the value written to `question_key` is produced by
 * the same expression that later matches it against `ai_requests`. There is deliberately no
 * TypeScript normaliser anywhere in this codebase — one would be easier to read and would be the
 * thing that eventually disagrees with the SQL, at which point resolved questions reappear forever
 * and nothing indicates why.
 */

const MODULE = 'AiKnowledge';

/** D1 binds at most 100 parameters per statement (D18); one id each, with headroom. */
const IDS_PER_STATEMENT = 90;

export class KnowledgeQuestionResolutionService {
  private readonly audit: AuditService;

  constructor(private readonly db: Database) {
    this.audit = new AuditService(db);
  }

  /**
   * Record that `question` has been answered by `documentId`.
   *
   * **Called after the entry is written, never before.** If this throws, the answer is already in
   * the corpus and the question is still in the backlog — mildly annoying, and the only acceptable
   * direction to fail in. The reverse order would let a failed entry-write leave a resolution that
   * hides a question nothing answers.
   *
   * Idempotent by upsert, because the backlog is shared and two people answering the same question
   * in the same minute is an ordinary Tuesday rather than an exotic race. The unique index on
   * `question_key` turns the second write into an update, so the row ends up pointing at the more
   * recent entry with one resolver named — instead of two rows that disagree and a read that has
   * to invent a tie-break. The earlier entry stays in the corpus, which is correct: two answers to
   * one question is a duplicate to tidy up, not data to destroy.
   *
   * It also converts a `DISMISSED` row: somebody judged the question junk, somebody else decided
   * it was worth answering, and the answer wins. That direction is deliberate — an answer is
   * evidence, a dismissal is an opinion.
   */
  async resolve(
    user: User,
    input: { question: string; documentId: string },
    ipAddress: string | null,
  ): Promise<KnowledgeQuestionResolution> {
    return this.write(user, 'ANSWERED', input.question, input.documentId, ipAddress);
  }

  /**
   * Record that `question` is not worth answering — gibberish, a test, something off-domain.
   *
   * Admin-only at the route, and that restriction is the point rather than an oversight: unlike an
   * answer, a dismissal has no document behind it and therefore never lapses. It is the one action
   * in this module that can hold a question off the backlog permanently, so it belongs to the role
   * that can see the whole backlog. A counselor seeing one student's odd question has no way to
   * know whether forty other students asked the same thing.
   */
  async dismiss(
    user: User,
    question: string,
    ipAddress: string | null,
  ): Promise<KnowledgeQuestionResolution> {
    return this.write(user, 'DISMISSED', question, null, ipAddress);
  }

  /**
   * Put a question back on the backlog by deleting its resolution — the undo.
   *
   * Deleting rather than flagging, because a resolution is not history: it is the current answer
   * to "has somebody dealt with this?", and the history of who decided what is in `audit_logs`
   * where it belongs. A `reopened_at` column would mean every read carrying a condition that
   * exists only to ignore rows.
   *
   * The question itself is untouched and returns with its original ask count, because the counts
   * were never stored here — they are recomputed from `ai_requests` every time.
   */
  async reopen(user: User, resolutionId: string, ipAddress: string | null): Promise<void> {
    const resolution = await this.find(resolutionId);

    /**
     * An admin may reopen anything; a counselor only their own decisions.
     *
     * 404 rather than 403 for someone else's row, the same rule `ClassPolicy.authorizeClass`
     * applies: "not yours" and "not real" must be indistinguishable from outside, or the error
     * code itself becomes a way to enumerate what colleagues have been doing.
     */
    if (user.role !== 'admin' && resolution.resolvedBy !== user.id) {
      throw ApiError.notFound('Resolved question not found.');
    }

    await this.db
      .delete(knowledgeQuestionResolutions)
      .where(eq(knowledgeQuestionResolutions.id, resolutionId));

    await this.audit.write({
      action: 'KNOWLEDGE_QUESTION_REOPENED',
      module: MODULE,
      userId: user.id,
      targetType: 'knowledge_question',
      targetId: resolution.questionKey,
      oldValues: {
        question: resolution.question,
        resolution: resolution.resolution,
        resolved_by: resolution.resolvedBy,
      },
      ipAddress,
    });
  }

  async find(resolutionId: string): Promise<KnowledgeQuestionResolution> {
    const [resolution] = await this.db
      .select()
      .from(knowledgeQuestionResolutions)
      .where(eq(knowledgeQuestionResolutions.id, resolutionId))
      .limit(1);

    if (resolution === undefined) {
      throw ApiError.notFound('Resolved question not found.');
    }

    return resolution;
  }

  /**
   * Every resolution that names this document, for the callers that need to know an entry is
   * load-bearing before they touch it.
   *
   * Nothing *cascades* on archive — the read already treats an archived entry's resolution as
   * lapsed, so the question returns to the backlog on its own and the row stays as the record of
   * who answered it and when. This exists so the archive route can say so out loud, because
   * "archiving this puts 3 questions back in the backlog" is the kind of consequence somebody
   * should learn before pressing the button rather than from the backlog growing.
   */
  async forDocument(documentId: string): Promise<KnowledgeQuestionResolution[]> {
    return this.db
      .select()
      .from(knowledgeQuestionResolutions)
      .where(eq(knowledgeQuestionResolutions.documentId, documentId));
  }

  // --- internals ---------------------------------------------------------------------

  private async write(
    user: User,
    resolution: 'ANSWERED' | 'DISMISSED',
    question: string,
    documentId: string | null,
    ipAddress: string | null,
  ): Promise<KnowledgeQuestionResolution> {
    const trimmed = question.trim();

    if (trimmed === '') {
      throw ApiError.validation({ question: ['A question is required.'] });
    }

    const timestamp = now();
    // The key is computed by SQL, from the bound parameter, using the expression the report
    // matches with. See the class comment — this is the whole reason there is no JS normaliser.
    const key = questionKey(sql<string>`${trimmed}`);

    const [row] = await this.db
      .insert(knowledgeQuestionResolutions)
      .values({
        id: uuid(),
        questionKey: key,
        question: trimmed,
        resolution,
        documentId,
        resolvedBy: user.id,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: knowledgeQuestionResolutions.questionKey,
        set: {
          question: trimmed,
          resolution,
          documentId,
          resolvedBy: user.id,
          /**
           * `createdAt` moves too, and it has to.
           *
           * It is not a decorative "when was this row made" — the read compares it against every
           * ask's timestamp to decide which asks the resolution covers. Leaving it at the first
           * resolution's time would mean a question dismissed in March, asked again in June and
           * answered in July went on showing every ask since March as outstanding.
           */
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      })
      .returning();

    if (row === undefined) {
      // `returning()` on an upsert that matched but changed nothing. Not reachable with the `set`
      // above (it always writes `updated_at`), and cheaper to read back than to reason about.
      throw ApiError.notFound('The resolution could not be recorded.');
    }

    await this.audit.write({
      action: resolution === 'ANSWERED' ? 'KNOWLEDGE_QUESTION_ANSWERED' : 'KNOWLEDGE_QUESTION_DISMISSED',
      module: MODULE,
      userId: user.id,
      targetType: 'knowledge_question',
      // The key, not the row id: the question is the thing being acted on, and it survives the
      // resolution row being deleted and recreated by a reopen-then-answer.
      targetId: row.questionKey,
      newValues: {
        question: trimmed,
        ...(documentId === null ? {} : { document_id: documentId }),
        resolved_by_role: user.role,
      },
      ipAddress,
    });

    if (resolution === 'ANSWERED') {
      // After the resolution and its audit row, and never able to undo them: the answer is
      // recorded whether or not anybody could be told. A lost notification is a student who has
      // to ask again; a failed save would be an answer that does not count.
      try {
        await this.notifyRequesters(row);
      } catch (error) {
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'Question resolved, but the students who requested it could not be notified.',
            question_key: row.questionKey,
            cause: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }

    return row;
  }

  /**
   * Tell the students who asked for this question to be answered that it has been (migration
   * 0033).
   *
   * Migration 0030 gave a refused student *"Request to add to knowledge"*, and nothing ever came
   * back: they saw "Requested", and the only way to learn it had been answered was to ask again on
   * the off chance. A request acted on silently is, from the side of the person who made it,
   * indistinguishable from one that was ignored.
   *
   * ## Claimed, then told — never the other way round
   *
   * The rows are **claimed** with a conditional UPDATE (`knowledge_answered_at IS NULL`) that
   * returns what it changed, and only those students are notified. Two people answering the same
   * question at once, an edit re-saving an answer, or a backfill re-running each select the same
   * waiting rows — and exactly one of them changes each row, so each student is told once. The
   * same affected-rows pattern `KnowledgeIngestionService.embedBatch` uses to fire its
   * completion event exactly once (M5).
   *
   * The question is matched the way the backlog matches it — the preceding user message, through
   * `questionKey` — so "who asked for this" and "what is on the backlog" cannot disagree.
   */
  private async notifyRequesters(resolution: KnowledgeQuestionResolution): Promise<number> {
    const asked = sql<string | null>`(
      SELECT q.content FROM chat_messages q
      WHERE q.conversation_id = ${chatMessages.conversationId}
        AND q.role = 'user'
        AND q.created_at <= ${chatMessages.createdAt}
      ORDER BY q.created_at DESC, q.id DESC
      LIMIT 1
    )`;

    const waiting = await this.db
      .select({ id: chatMessages.id, studentId: chatConversations.studentId })
      .from(chatMessages)
      .innerJoin(chatConversations, eq(chatConversations.id, chatMessages.conversationId))
      .where(
        and(
          eq(chatMessages.knowledgeRequest, 'REQUESTED'),
          isNull(chatMessages.knowledgeAnsweredAt),
          sql`${questionKey(asked)} = ${resolution.questionKey}`,
        ),
      );

    if (waiting.length === 0) {
      return 0;
    }

    const studentOf = new Map(waiting.map((message) => [message.id, message.studentId]));
    const timestamp = now();
    const claimed: string[] = [];

    for (let i = 0; i < waiting.length; i += IDS_PER_STATEMENT) {
      const changed = await this.db
        .update(chatMessages)
        .set({ knowledgeAnsweredAt: timestamp })
        .where(
          and(
            inArray(
              chatMessages.id,
              waiting.slice(i, i + IDS_PER_STATEMENT).map((message) => message.id),
            ),
            isNull(chatMessages.knowledgeAnsweredAt),
          ),
        )
        .returning({ id: chatMessages.id });

      claimed.push(...changed.map((message) => message.id));
    }

    // One notification per student, however many times they pressed the button on this question.
    const students = [
      ...new Set(
        claimed.map((id) => studentOf.get(id)).filter((id): id is string => id !== undefined),
      ),
    ];

    await new NotificationService(this.db).sendToMany(students, {
      title: 'Your question was answered',
      message: `Your school has answered "${excerpt(resolution.question)}". Ask the assistant again to see the answer.`,
      category: 'RECOMMENDATION',
    });

    return students.length;
  }
}

/** A question short enough to sit in a notification without becoming the notification. */
function excerpt(question: string): string {
  const trimmed = question.trim();

  return trimmed.length <= 120 ? trimmed : `${trimmed.slice(0, 117).trimEnd()}…`;
}

/**
 * Whether this user may take a question off the backlog for everybody.
 *
 * Answering is open to both staff roles — that is the whole point of making counselors
 * contributors. Dismissing is not, for the reason on `dismiss` above.
 */
export function canDismissQuestions(user: User): boolean {
  return user.role === 'admin';
}

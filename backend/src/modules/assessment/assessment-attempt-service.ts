import { and, asc, count, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';

import type { Database } from '@/db/client';
import type { AssignmentScope } from '@/db/enums';
import {
  assessmentAnswers,
  assessmentAssignments,
  assessmentAttempts,
  assessmentDimensions,
  assessmentQuestions,
  assessmentResults,
  assessmentTemplates,
  assessmentVersions,
  classStudents,
  dimensionScores,
  questionOptions,
  users,
  type AssessmentAssignment,
  type AssessmentAttempt,
  type AssessmentDimension,
  type AssessmentQuestion,
  type AssessmentResult,
  type AssessmentTemplate,
  type AssessmentVersion,
  type ClassRoom,
  type QuestionOption,
  type User,
} from '@/db/schema';
import type { Env } from '@/env';
import { dispatchRecommendationGeneration } from '@/events/dispatch-recommendation-generation';
import { dispatch, type AssessmentCompletedEvent } from '@/events/dispatcher';
import { notifyAssessmentCompleted } from '@/events/send-notifications';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { isUniqueViolation } from '@/lib/db-errors';
import { ApiError } from '@/lib/envelope';
import type { ScoredDimension } from '@/lib/scoring';
import { ScoringService } from '@/modules/assessment/scoring-service';
import { ClassEnrollmentService } from '@/modules/classes/class-enrollment-service';
import { ClassService } from '@/modules/classes/class-service';
import { AuditService } from '@/modules/platform/audit-service';
import { NotificationService } from '@/modules/platform/notification-service';
import {
  authorizeAnswerAttempt,
  authorizeViewAttempt,
  canManageAssignment,
  canResetAttempt,
  canStartAttempt,
} from '@/policies/assessment';

/**
 * The attempt lifecycle (FULLPLAN §21, §24, `docs/api/phase-3-assessment-engine.md`).
 *
 * `DRAFT → PUBLISHED → ASSIGNED → IN_PROGRESS → SUBMITTED → SCORED`, plus the one state that is
 * easy to mistake for an error and is not: **`EXPIRED`**. An attempt expires when its assignment
 * closes underneath it, or when a counselor resets it for a retake. Expired attempts are never
 * scored and never feed recommendations — which is precisely what makes "the student's latest
 * result" resolve unambiguously to a `SCORED` attempt everywhere else in the system.
 */

const MODULE = 'Assessment';

/**
 * **D1 binds at most 100 parameters per statement**, so a multi-row INSERT's ceiling is a row count
 * *divided by the width of the table* — the same constraint `AssessmentBuilderService` documents at
 * length. Assigning one instrument to sixty classes is one statement's worth of rows only if the
 * arithmetic is done; hard-coding a row count would work until someone added a column.
 */
const D1_MAX_BOUND_PARAMS = 100;

function chunkRows<T>(rows: T[], columnsPerRow: number): T[][] {
  const size = Math.max(1, Math.floor(D1_MAX_BOUND_PARAMS / columnsPerRow));
  const chunks: T[][] = [];

  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }

  return chunks;
}

export interface AttemptWithContent {
  attempt: AssessmentAttempt;
  version: AssessmentVersion;
  template: AssessmentTemplate;
  questions: (AssessmentQuestion & { options: QuestionOption[] })[];
  answers: { questionId: string; selectedOptionId: string | null; answerText: string | null }[];
}

export interface ResultView {
  attempt: AssessmentAttempt;
  template: AssessmentTemplate;
  result: AssessmentResult | undefined;
  dimensions: ScoredDimension[];
}

export interface StudentResultRow {
  id: string;
  name: string;
  username: string | null;
}

/**
 * A page of results, hydrated in a **fixed number of D1 queries regardless of how many rows the
 * page holds** (C1). `dimensionsByTemplate` carries every template's dimension rows once, so the
 * route can serialize each view without the per-row dimension refetch that used to fan out.
 */
export interface ResultsPage<TView extends ResultView = ResultView> {
  views: TView[];
  dimensionsByTemplate: Map<string, AssessmentDimension[]>;
  total: number;
  page: number;
  perPage: number;
}

export interface AssignmentView {
  assignment: AssessmentAssignment;
  version: AssessmentVersion;
  template: AssessmentTemplate;
  questionCount: number;
  /**
   * Student view — my own attempt, never anyone else's. **`null` means "I have not started";
   * `undefined` means "this is not a student's view at all"** — and the serializer needs to tell
   * those apart, because the first must emit `my_attempt: null` and the second must omit the key.
   */
  myAttempt?: AssessmentAttempt | null;
  /** Counselor view — how many students have finished. */
  submittedCount?: number;
}

export class AssessmentAttemptService {
  private readonly audit: AuditService;
  private readonly scoring: ScoringService;
  private readonly classes: ClassService;
  private readonly enrollment: ClassEnrollmentService;

  constructor(
    private readonly db: Database,
    private readonly env: Env,
  ) {
    this.audit = new AuditService(db);
    this.scoring = new ScoringService(db);
    this.classes = new ClassService(db, env);
    this.enrollment = new ClassEnrollmentService(db, this.classes);
  }

  // --- Student: the player ------------------------------------------------------------------

  /** Active assignments in my active enrollments, each carrying **my** attempt if I have one. */
  async listAssignmentsForStudent(student: User): Promise<AssignmentView[]> {
    const classIds = await this.enrollment.activeClassIdsFor(student.id);

    if (classIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .select({
        assignment: assessmentAssignments,
        version: assessmentVersions,
        template: assessmentTemplates,
      })
      .from(assessmentAssignments)
      .innerJoin(
        assessmentVersions,
        eq(assessmentAssignments.assessmentVersionId, assessmentVersions.id),
      )
      .innerJoin(
        assessmentTemplates,
        eq(assessmentVersions.assessmentTemplateId, assessmentTemplates.id),
      )
      .where(
        and(
          inArray(assessmentAssignments.classId, classIds),
          eq(assessmentAssignments.status, 'ACTIVE'),
        ),
      )
      .orderBy(desc(assessmentAssignments.createdAt));

    return this.decorateAssignments(rows, student);
  }

  /**
   * **Idempotent** (`docs/api`): a student who double-taps Start, or refreshes the player, lands
   * back in the attempt they already have rather than being told they cannot start one. The
   * partial unique index would reject the second insert anyway — this is what turns that
   * constraint error into the behaviour the student expects.
   */
  async start(student: User, assignmentId: string): Promise<AttemptWithContent> {
    const assignment = await this.findAssignment(assignmentId);

    if (assignment === undefined) {
      throw ApiError.notFound('Assignment not found.');
    }

    // **Live enrollment, not the token** — see `canStartAttempt`.
    const enrollment = await this.enrollment.activeEnrollment(student.id, assignment.classId);

    if (!canStartAttempt(student, enrollment)) {
      throw ApiError.notFound('Assignment not found.');
    }

    if (assignment.status !== 'ACTIVE') {
      throw ApiError.validation(
        { assignment: ['This assessment is closed.'] },
        'This assessment is no longer open.',
      );
    }

    const existing = await this.liveAttempt(assignmentId, student.id);

    if (existing !== undefined) {
      if (existing.status !== 'IN_PROGRESS') {
        throw ApiError.validation(
          { attempt: ['You have already submitted this assessment.'] },
          'You have already completed this assessment.',
        );
      }

      return this.loadAttemptContent(existing);
    }

    const attempt: AssessmentAttempt = {
      id: uuid(),
      assignmentId,
      assessmentVersionId: assignment.assessmentVersionId,
      studentId: student.id,
      status: 'IN_PROGRESS',
      startedAt: now(),
      submittedAt: null,
      createdAt: now(),
      updatedAt: now(),
    };

    try {
      await this.db.insert(assessmentAttempts).values(attempt);
    } catch (error) {
      // The `liveAttempt` check above is a race: two truly-concurrent Start taps both find no
      // live attempt and both insert, and the loser hits the partial unique index
      // (assignment_id, student_id WHERE status <> 'EXPIRED'). Start is contractually idempotent,
      // so the loser must land in the attempt that won, not on a 500. Re-read it and return it.
      if (isUniqueViolation(error)) {
        const winner = await this.liveAttempt(assignmentId, student.id);

        if (winner !== undefined) {
          return this.loadAttemptContent(winner);
        }
      }

      throw error;
    }

    return this.loadAttemptContent(attempt);
  }

  /** The player payload. See `serializeQuestion` for what it deliberately omits. */
  async viewAttempt(user: User, attemptId: string): Promise<AttemptWithContent> {
    const attempt = await this.findAttempt(attemptId);
    const attemptClass = await this.classForAttempt(attempt);

    authorizeViewAttempt(user, attempt, attemptClass);

    return this.loadAttemptContent(attempt);
  }

  /**
   * Save (or change) one answer — an **upsert**: changing your mind on question 7 updates the
   * answer rather than stacking a second one that would then be summed twice.
   *
   * **The score is snapshotted server-side from the chosen option** (§13.5) and is never
   * client-supplied. A client that could POST its own score would be scoring its own assessment.
   */
  async saveAnswer(
    student: User,
    attemptId: string,
    questionId: string,
    selectedOptionId: string,
  ): Promise<void> {
    const attempt = await this.findAttempt(attemptId);
    const attemptClass = await this.classForAttempt(attempt);

    authorizeViewAttempt(student, attempt, attemptClass);
    authorizeAnswerAttempt(student, attempt);

    if (attempt.status !== 'IN_PROGRESS') {
      throw ApiError.validation(
        { attempt: [`This attempt is ${attempt.status} and can no longer be answered.`] },
        'Answers are final once an attempt has been submitted.',
      );
    }

    // The option must belong to the question, and the question to *this attempt's version*.
    // Without the second half, a student could answer a question from another instrument
    // entirely — and it would be scored, because the answer row only records the question id.
    const [option] = await this.db
      .select({ option: questionOptions, question: assessmentQuestions })
      .from(questionOptions)
      .innerJoin(assessmentQuestions, eq(questionOptions.questionId, assessmentQuestions.id))
      .where(
        and(
          eq(questionOptions.id, selectedOptionId),
          eq(questionOptions.questionId, questionId),
          eq(assessmentQuestions.assessmentVersionId, attempt.assessmentVersionId),
        ),
      )
      .limit(1);

    if (option === undefined) {
      throw ApiError.validation(
        { selected_option_id: ['That option does not belong to this question.'] },
        'Invalid answer.',
      );
    }

    // **Atomic upsert** on the `(attempt_id, question_id)` unique index (H4). The old
    // select-then-insert-or-update raced itself: two near-simultaneous saves of the same
    // question (a double-tap, a retried request) both saw "no existing row" and both inserted,
    // and the loser surfaced as a raw 500 instead of the idempotent save the contract promises.
    // One `onConflictDoUpdate` closes that window and drops the extra SELECT.
    await this.db
      .insert(assessmentAnswers)
      .values({
        id: uuid(),
        attemptId,
        questionId,
        selectedOptionId,
        answerText: null,
        score: option.option.score,
        answeredAt: now(),
      })
      .onConflictDoUpdate({
        target: [assessmentAnswers.attemptId, assessmentAnswers.questionId],
        set: {
          selectedOptionId,
          score: option.option.score,
          answeredAt: now(),
        },
      });
  }

  /**
   * Finalize, **score inline** (§24), and return the result — no polling, no queue. The student
   * is sitting on the screen.
   *
   * **Submission is blocked while any REQUIRED question is unanswered**, with a count. This block
   * is what makes §24's prorating rule safe rather than catastrophic: prorating is right for an
   * *optional* question, and without the block a student could answer one Investigative item with
   * a 5, skip the other 59, and walk out with a perfect and entirely meaningless `I`.
   */
  async submit(student: User, attemptId: string): Promise<ResultView> {
    // This is the heaviest request in the system — inline scoring plus inline recommendation
    // generation (D17) — and a free Worker invocation gets 50 subrequests total (§45), so the
    // path is written to a measured budget (test/platform/subrequest-budget.test.ts): the
    // attempt arrives joined to its assignment, the version arrives joined to its template,
    // and both are threaded down into scoring and the result view rather than refetched.
    const { attempt, assignment } = await this.attemptWithAssignment(attemptId);
    const attemptClass = await this.classes.findById(assignment.classId);

    authorizeViewAttempt(student, attempt, attemptClass);
    authorizeAnswerAttempt(student, attempt);

    if (attempt.status !== 'IN_PROGRESS') {
      throw ApiError.validation(
        { attempt: [`This attempt is ${attempt.status}.`] },
        'This attempt has already been submitted.',
      );
    }

    const unanswered = await this.unansweredRequiredCount(attempt);

    if (unanswered > 0) {
      throw ApiError.validation(
        { answers: [`${unanswered} required question(s) are still unanswered.`] },
        'Please answer every required question before submitting.',
      );
    }

    const submittedAt = now();

    const { version, template } = await this.versionWithTemplate(attempt.assessmentVersionId);

    // **Atomic submit (C2).** There is no separate `SUBMITTED` flip before scoring. The status
    // transition is folded into scoring's single `db.batch()` — IN_PROGRESS → SCORED, stamping
    // `submitted_at` in the same write. A D1 blip or an unexpected throw inside `score()`
    // therefore leaves the attempt IN_PROGRESS and re-submittable, rather than stranding it in a
    // SUBMITTED state with no result row that nothing in the system ever re-scores.
    const { generatedAt } = await this.scoring.score(attempt, version, { submittedAt });

    const view = await this.resultFor(attemptId, {
      // Mirrors the row `score()` just wrote — status, submittedAt and updatedAt included — so the
      // view does not pay a D1 read to learn what this request itself did two lines up.
      attempt: { ...attempt, status: 'SCORED', submittedAt, updatedAt: generatedAt },
      template,
    });

    await this.audit.write({
      userId: student.id,
      action: 'ASSESSMENT_SUBMITTED',
      module: MODULE,
      targetType: 'assessment_attempt',
      targetId: attemptId,
      newValues: { result_code: view.result?.resultCode ?? null },
    });

    /**
     * §24: fires **once per scored attempt, for every category** — including an ungraded CUSTOM
     * one. Whether recommendation generation actually runs is the *listener's* decision (it checks
     * that both a RIASEC and an SCCT result exist — §11, v1.2), and this service never makes it.
     *
     * Phase 4 plugged `dispatchRecommendationGeneration` into the seam Step 4 left empty; Phase 6
     * added the §44 notification listener beside it. A listener that throws cannot fail this
     * request (see `dispatch`): the scoring is committed and the student is waiting on the screen.
     */
    const event: AssessmentCompletedEvent = {
      type: 'AssessmentCompleted',
      attemptId,
      studentId: student.id,
      assessmentVersionId: attempt.assessmentVersionId,
      category: view.template.category,
      assessmentTitle: view.template.title,
    };

    // Phase 6 plugged the §44 notification listener into the seam this comment promised it to.
    await dispatch(event, [
      notifyAssessmentCompleted(this.db),
      dispatchRecommendationGeneration(this.db, this.env),
    ]);

    return view;
  }

  /**
   * `SCORED` attempts only — an expired one never appears in a student's results (§21).
   *
   * **C1:** the whole page is hydrated in a fixed number of D1 queries (count + page + three set
   * queries in `hydrateResultViews`), not ~5 per row. Paginated (§19) so the response is bounded
   * even before that — a student realistically has a handful of results, but the contract matches
   * the class listing and the platform's other heavy lists.
   */
  async listResultsForStudent(student: User, page = 1, perPage = 25): Promise<ResultsPage> {
    const where = and(
      eq(assessmentAttempts.studentId, student.id),
      eq(assessmentAttempts.status, 'SCORED'),
    );

    const [totalRow] = await this.db
      .select({ total: count() })
      .from(assessmentAttempts)
      .where(where);

    const rows = await this.db
      .select({ attempt: assessmentAttempts, template: assessmentTemplates })
      .from(assessmentAttempts)
      .innerJoin(
        assessmentVersions,
        eq(assessmentAttempts.assessmentVersionId, assessmentVersions.id),
      )
      .innerJoin(
        assessmentTemplates,
        eq(assessmentVersions.assessmentTemplateId, assessmentTemplates.id),
      )
      .where(where)
      .orderBy(desc(assessmentAttempts.submittedAt))
      .limit(perPage)
      .offset((page - 1) * perPage);

    const { views, dimensionsByTemplate } = await this.hydrateResultViews(rows);

    return { views, dimensionsByTemplate, total: totalRow?.total ?? 0, page, perPage };
  }

  async viewResult(user: User, attemptId: string): Promise<ResultView> {
    const attempt = await this.findAttempt(attemptId);
    const attemptClass = await this.classForAttempt(attempt);

    authorizeViewAttempt(user, attempt, attemptClass);

    return this.resultFor(attemptId);
  }

  // --- Counselor ------------------------------------------------------------------------------

  async listAssignmentsForClass(user: User, classId: string): Promise<AssignmentView[]> {
    const classRoom = await this.classes.find(user, classId); // 404s when not theirs.

    const rows = await this.db
      .select({
        assignment: assessmentAssignments,
        version: assessmentVersions,
        template: assessmentTemplates,
      })
      .from(assessmentAssignments)
      .innerJoin(
        assessmentVersions,
        eq(assessmentAssignments.assessmentVersionId, assessmentVersions.id),
      )
      .innerJoin(
        assessmentTemplates,
        eq(assessmentVersions.assessmentTemplateId, assessmentTemplates.id),
      )
      .where(eq(assessmentAssignments.classId, classRoom.id))
      .orderBy(desc(assessmentAssignments.createdAt));

    return this.decorateAssignments(rows);
  }

  /**
   * **You assign a version, never a template** (§13.4) — and it must be `PUBLISHED`.
   *
   * A draft assignment is a **422, not a 403**: the counselor is entirely permitted to do this,
   * the version simply is not ready. A draft is still being edited, and students answering
   * questions that move underneath them is the exact failure that version immutability exists to
   * prevent.
   */
  async createAssignment(
    user: User,
    classId: string,
    versionId: string,
    deadline: string | null,
    ipAddress: string | null,
  ): Promise<AssignmentView> {
    const classRoom = await this.classes.find(user, classId);

    if (!canManageAssignment(user, classRoom)) {
      throw ApiError.notFound('Class not found.');
    }

    const [version] = await this.db
      .select()
      .from(assessmentVersions)
      .where(eq(assessmentVersions.id, versionId))
      .limit(1);

    if (version === undefined) {
      throw ApiError.validation(
        { assessment_version_id: ['That assessment version does not exist.'] },
        'Unknown assessment version.',
      );
    }

    if (version.status !== 'PUBLISHED') {
      throw ApiError.validation(
        { assessment_version_id: [`This version is ${version.status}, not PUBLISHED.`] },
        'Only a published assessment version can be assigned.',
      );
    }

    const assignment: AssessmentAssignment = {
      id: uuid(),
      assessmentVersionId: versionId,
      classId: classRoom.id,
      assignedBy: user.id,
      deadline,
      status: 'ACTIVE',
      /** One class, picked deliberately — the counselor's ordinary act (migration 0014). */
      scope: 'CLASS',
      createdAt: now(),
    };

    await this.db.insert(assessmentAssignments).values(assignment);

    await this.audit.write({
      userId: user.id,
      action: 'ASSESSMENT_ASSIGNED',
      module: MODULE,
      targetType: 'assessment_assignment',
      targetId: assignment.id,
      newValues: { class_id: classRoom.id, assessment_version_id: versionId },
      ipAddress,
    });

    const template = await this.templateFor(version.assessmentTemplateId);

    /**
     * §44: "New assessment assigned: {title}, due {deadline}." — to every *active* enrollment.
     * The one §44 notification that is a direct call rather than a listener, because §60
     * catalogs exactly four events and assignment creation is not one of them. Absorbed on
     * failure for the same reason `dispatch()` absorbs a listener: the assignment is already
     * committed, and a notification hiccup must not turn it into a 500.
     */
    try {
      const roster = await this.db
        .select({ studentId: classStudents.studentId })
        .from(classStudents)
        .where(
          and(eq(classStudents.classId, classRoom.id), eq(classStudents.status, 'active')),
        );

      await new NotificationService(this.db).sendToMany(
        roster.map((row) => row.studentId),
        {
          title: 'New assessment assigned',
          message:
            deadline === null
              ? `New assessment assigned: ${template.title}.`
              : `New assessment assigned: ${template.title}, due ${deadline.slice(0, 10)}.`,
          category: 'CLASS',
        },
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'Assignment notification fan-out failed.',
          assignment_id: assignment.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    const [view] = await this.decorateAssignments([{ assignment, version, template }]);

    if (view === undefined) {
      throw ApiError.notFound('Assignment not found.');
    }

    return view;
  }

  /**
   * **Assign one published version to every active class, or to a chosen few, in one act.**
   *
   * This is the administrator's counterpart to `createAssignment` — that one is the counselor
   * assigning to a class they own, and it stays exactly as it was. What is new here is *breadth*,
   * not a new kind of assignment: a GLOBAL assignment is still one ordinary row per class, so
   * enrollment, `canStartAttempt`, `authorizeViewAttempt`, the results join and the §44 notification
   * all keep resolving through a real class. Only `scope` records that one act wrote them all.
   *
   * Everything scales with the number of classes rather than with each class in turn:
   *
   *   * the target classes are read in **one** query (`listActive` / `findManyByIds`),
   *   * every class that already holds an ACTIVE assignment for this version is skipped in **one**
   *     query — re-running a global assignment is a top-up, not a pile of duplicates,
   *   * the rows are inserted in one chunked `batch()`,
   *   * the whole act is **one** audit row, because it is one act, and
   *   * the §44 notification is one roster query and one `sendToMany`.
   *
   * A class the caller may not manage is skipped rather than fatal (`canManageAssignment`), which
   * is what makes the same method safe for a counselor picking classes and an admin assigning to
   * all of them.
   */
  async assignToClasses(
    user: User,
    input: {
      versionId: string;
      scope: AssignmentScope;
      /** Ignored (and must be empty) when `scope` is GLOBAL — the target is "every active class". */
      classIds: string[];
      deadline: string | null;
    },
    ipAddress: string | null,
  ): Promise<{ assigned: number; skipped: number; version: AssessmentVersion }> {
    const { version, template } = await this.versionWithTemplate(input.versionId);

    if (version.status !== 'PUBLISHED') {
      throw ApiError.validation(
        { assessment_version_id: [`This version is ${version.status}, not PUBLISHED.`] },
        'Only a published assessment version can be assigned.',
      );
    }

    if (template.status === 'ARCHIVED') {
      throw ApiError.validation(
        { assessment_version_id: ['This assessment is archived. Restore it before assigning it.'] },
        'An archived assessment cannot be assigned.',
      );
    }

    const candidates =
      input.scope === 'GLOBAL'
        ? await this.classes.listActive()
        : await this.classes.findManyByIds(input.classIds);

    // Ownership, in memory, over rows already loaded — an admin passes every class, a counselor
    // only their own. A class the caller cannot manage is simply not a target.
    const manageable = candidates.filter((classRoom) => canManageAssignment(user, classRoom));

    if (manageable.length === 0) {
      throw ApiError.validation(
        {
          class_ids: [
            input.scope === 'GLOBAL'
              ? 'There are no active classes to assign this to yet.'
              : 'None of the selected classes are available to you.',
          ],
        },
        'Nothing to assign.',
      );
    }

    // Duplicate prevention, in one query: a class that already has this version open does not get
    // a second assignment, so the button is safe to press twice and a global re-run tops up the
    // classes created since the last one.
    const already = new Set(
      (
        await this.db
          .select({ classId: assessmentAssignments.classId })
          .from(assessmentAssignments)
          .where(
            and(
              eq(assessmentAssignments.assessmentVersionId, version.id),
              eq(assessmentAssignments.status, 'ACTIVE'),
              inArray(
                assessmentAssignments.classId,
                manageable.map((classRoom) => classRoom.id),
              ),
            ),
          )
      ).map((row) => row.classId),
    );

    const targets = manageable.filter((classRoom) => !already.has(classRoom.id));

    if (targets.length === 0) {
      return { assigned: 0, skipped: manageable.length, version };
    }

    const timestamp = now();
    const rows: AssessmentAssignment[] = targets.map((classRoom) => ({
      id: uuid(),
      assessmentVersionId: version.id,
      classId: classRoom.id,
      assignedBy: user.id,
      deadline: input.deadline,
      status: 'ACTIVE',
      scope: input.scope,
      createdAt: timestamp,
    }));

    // Chunked for the same reason `addQuestions` chunks: D1 binds one parameter per column per row,
    // so the ceiling is a parameter budget, not a row count. `assessment_assignments` is 7 columns.
    const statements: BatchItem<'sqlite'>[] = chunkRows(rows, 7).map((batch) =>
      this.db.insert(assessmentAssignments).values(batch),
    );

    await this.db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);

    await this.audit.write({
      userId: user.id,
      action: 'ASSESSMENT_ASSIGNED',
      module: MODULE,
      targetType: 'assessment_version',
      targetId: version.id,
      newValues: {
        scope: input.scope,
        assessment_template_id: template.id,
        assigned_classes: rows.length,
        skipped_classes: manageable.length - rows.length,
        deadline: input.deadline,
      },
      ipAddress,
    });

    // §44, absorbed on failure for the same reason `createAssignment` absorbs it: the assignments
    // are already committed, and a notification hiccup must not turn that into a 500.
    try {
      const roster = await this.db
        .select({ studentId: classStudents.studentId })
        .from(classStudents)
        .where(
          and(
            inArray(
              classStudents.classId,
              rows.map((row) => row.classId),
            ),
            eq(classStudents.status, 'active'),
          ),
        );

      // A student in two of the targeted classes is one person, and should be told once.
      const recipients = [...new Set(roster.map((row) => row.studentId))];

      await new NotificationService(this.db).sendToMany(recipients, {
        title: 'New assessment assigned',
        message:
          input.deadline === null
            ? `New assessment assigned: ${template.title}.`
            : `New assessment assigned: ${template.title}, due ${input.deadline.slice(0, 10)}.`,
        category: 'CLASS',
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'Broadcast assignment notification fan-out failed.',
          assessment_version_id: version.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    return { assigned: rows.length, skipped: manageable.length - rows.length, version };
  }

  /**
   * **Closing an assignment is not a status flip.**
   *
   * §21: an attempt still `IN_PROGRESS` when its assignment closes becomes `EXPIRED` — so closing
   * *ends the unfinished work underneath it*, in the same `db.batch()`. Attempts already
   * `SUBMITTED` or `SCORED` are untouched: closing ends unfinished work, it does not revoke
   * finished work. Doing the two writes separately would leave a window in which the assignment
   * is closed but its in-flight attempts are still answerable.
   */
  async closeAssignment(
    user: User,
    assignmentId: string,
    ipAddress: string | null,
  ): Promise<AssignmentView> {
    const assignment = await this.findAssignment(assignmentId);

    if (assignment === undefined) {
      throw ApiError.notFound('Assignment not found.');
    }

    const classRoom = await this.classes.find(user, assignment.classId);

    if (!canManageAssignment(user, classRoom)) {
      throw ApiError.notFound('Assignment not found.');
    }

    const expiring = await this.db
      .select({ total: count() })
      .from(assessmentAttempts)
      .where(
        and(
          eq(assessmentAttempts.assignmentId, assignmentId),
          eq(assessmentAttempts.status, 'IN_PROGRESS'),
        ),
      );

    const statements: [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]] = [
      this.db
        .update(assessmentAssignments)
        .set({ status: 'CLOSED' })
        .where(eq(assessmentAssignments.id, assignmentId)),
      this.db
        .update(assessmentAttempts)
        .set({ status: 'EXPIRED', updatedAt: now() })
        .where(
          and(
            eq(assessmentAttempts.assignmentId, assignmentId),
            eq(assessmentAttempts.status, 'IN_PROGRESS'),
          ),
        ),
    ];

    await this.db.batch(statements);

    await this.audit.write({
      userId: user.id,
      action: 'ASSESSMENT_ASSIGNMENT_CLOSED',
      module: MODULE,
      targetType: 'assessment_assignment',
      targetId: assignmentId,
      newValues: { expired_attempts: expiring[0]?.total ?? 0 },
      ipAddress,
    });

    const [view] = await this.decorateAssignments([
      {
        assignment: { ...assignment, status: 'CLOSED' },
        version: await this.versionFor(assignment.assessmentVersionId),
        template: await this.templateForVersion(assignment.assessmentVersionId),
      },
    ]);

    if (view === undefined) {
      throw ApiError.notFound('Assignment not found.');
    }

    return view;
  }

  /**
   * Every scored attempt across a class (§37 — the counselor's results table), each row
   * carrying **who** it belongs to. Phase 6 added the student join: a results overview a
   * counselor cannot put a name to is not an overview, and the §21 reset button needs to
   * say whose work it is about to void.
   */
  async listResultsForClass(
    user: User,
    classId: string,
    page = 1,
    perPage = 25,
  ): Promise<ResultsPage<ResultView & { student: StudentResultRow }>> {
    const classRoom = await this.classes.find(user, classId);

    const where = and(
      eq(assessmentAssignments.classId, classRoom.id),
      eq(assessmentAttempts.status, 'SCORED'),
    );

    // A class of 40 finishing RIASEC+SCCT is up to 80 scored attempts. The old code ran ~5 D1
    // queries *per row* here (C1) — ~400 subrequests against a 50 cap, a guaranteed 500 the
    // moment a real class finished. Now: one count, one page query, and three set queries in
    // `hydrateResultViews` — a fixed cost regardless of N.
    const [totalRow] = await this.db
      .select({ total: count() })
      .from(assessmentAttempts)
      .innerJoin(
        assessmentAssignments,
        eq(assessmentAttempts.assignmentId, assessmentAssignments.id),
      )
      .where(where);

    const attempts = await this.db
      .select({
        attempt: assessmentAttempts,
        template: assessmentTemplates,
        studentName: users.name,
        username: classStudents.username,
      })
      .from(assessmentAttempts)
      .innerJoin(
        assessmentAssignments,
        eq(assessmentAttempts.assignmentId, assessmentAssignments.id),
      )
      .innerJoin(
        assessmentVersions,
        eq(assessmentAttempts.assessmentVersionId, assessmentVersions.id),
      )
      .innerJoin(
        assessmentTemplates,
        eq(assessmentVersions.assessmentTemplateId, assessmentTemplates.id),
      )
      .innerJoin(users, eq(assessmentAttempts.studentId, users.id))
      .leftJoin(
        classStudents,
        and(
          eq(classStudents.classId, classRoom.id),
          eq(classStudents.studentId, assessmentAttempts.studentId),
        ),
      )
      .where(where)
      .orderBy(desc(assessmentAttempts.submittedAt))
      .limit(perPage)
      .offset((page - 1) * perPage);

    const { views, dimensionsByTemplate } = await this.hydrateResultViews(
      attempts.map((row) => ({ attempt: row.attempt, template: row.template })),
    );

    // `hydrateResultViews` preserves input order, so view[i] belongs to attempts[i]; key the
    // student rows by attempt id anyway so the join to names can never drift silently.
    const studentByAttempt = new Map<string, StudentResultRow>(
      attempts.map((row) => [
        row.attempt.id,
        { id: row.attempt.studentId, name: row.studentName, username: row.username },
      ]),
    );

    return {
      views: views.map((view) => ({
        ...view,
        student: studentByAttempt.get(view.attempt.id) ?? {
          id: view.attempt.studentId,
          name: '',
          username: null,
        },
      })),
      dimensionsByTemplate,
      total: totalRow?.total ?? 0,
      page,
      perPage,
    };
  }

  /**
   * The retake (§21) — **the counselor's, never the student's.**
   *
   * If a student could reset their own attempt, a "retake" would be an undo button on a result
   * they disliked, and the instrument would end up measuring persistence rather than interest.
   *
   * The old attempt is marked `EXPIRED` and **kept**, with its answers, as history — it is never
   * deleted (§12: no soft deletes here, and no hard ones either). The partial unique index is
   * what then lets a fresh attempt exist alongside it.
   */
  async resetAttempt(user: User, attemptId: string, ipAddress: string | null): Promise<void> {
    const attempt = await this.findAttempt(attemptId);
    const attemptClass = await this.classForAttempt(attempt);

    if (attemptClass === undefined || !canResetAttempt(user, attemptClass)) {
      throw ApiError.notFound('Attempt not found.');
    }

    if (attempt.status === 'EXPIRED') {
      throw ApiError.validation(
        { attempt: ['This attempt is already expired.'] },
        'This attempt has already been reset.',
      );
    }

    await this.db
      .update(assessmentAttempts)
      .set({ status: 'EXPIRED', updatedAt: now() })
      .where(eq(assessmentAttempts.id, attemptId));

    await this.audit.write({
      userId: user.id,
      action: 'ASSESSMENT_ATTEMPT_RESET',
      module: MODULE,
      targetType: 'assessment_attempt',
      targetId: attemptId,
      oldValues: { status: attempt.status },
      newValues: { status: 'EXPIRED', student_id: attempt.studentId },
      ipAddress,
    });
  }

  // --- internals ------------------------------------------------------------------------------

  /** The one attempt that still counts — expired ones are history, not the current attempt. */
  private async liveAttempt(
    assignmentId: string,
    studentId: string,
  ): Promise<AssessmentAttempt | undefined> {
    const [attempt] = await this.db
      .select()
      .from(assessmentAttempts)
      .where(
        and(
          eq(assessmentAttempts.assignmentId, assignmentId),
          eq(assessmentAttempts.studentId, studentId),
          ne(assessmentAttempts.status, 'EXPIRED'),
        ),
      )
      .limit(1);

    return attempt;
  }

  private async findAttempt(attemptId: string): Promise<AssessmentAttempt> {
    const [attempt] = await this.db
      .select()
      .from(assessmentAttempts)
      .where(eq(assessmentAttempts.id, attemptId))
      .limit(1);

    if (attempt === undefined) {
      throw ApiError.notFound('Attempt not found.');
    }

    return attempt;
  }

  /**
   * An attempt joined to its assignment in one read — for the submit path, whose D1 budget
   * is measured (§45). `assignment_id` is NOT NULL, so the inner join loses nothing.
   */
  private async attemptWithAssignment(
    attemptId: string,
  ): Promise<{ attempt: AssessmentAttempt; assignment: AssessmentAssignment }> {
    const [row] = await this.db
      .select({ attempt: assessmentAttempts, assignment: assessmentAssignments })
      .from(assessmentAttempts)
      .innerJoin(
        assessmentAssignments,
        eq(assessmentAttempts.assignmentId, assessmentAssignments.id),
      )
      .where(eq(assessmentAttempts.id, attemptId))
      .limit(1);

    if (row === undefined) {
      throw ApiError.notFound('Attempt not found.');
    }

    return row;
  }

  private async findAssignment(
    assignmentId: string,
  ): Promise<AssessmentAssignment | undefined> {
    const [assignment] = await this.db
      .select()
      .from(assessmentAssignments)
      .where(eq(assessmentAssignments.id, assignmentId))
      .limit(1);

    return assignment;
  }

  /** §11: through the Class module's service, never its tables. */
  private async classForAttempt(attempt: AssessmentAttempt): Promise<ClassRoom | undefined> {
    const assignment = await this.findAssignment(attempt.assignmentId);

    if (assignment === undefined) {
      return undefined;
    }

    return this.classes.findById(assignment.classId);
  }

  private async versionFor(versionId: string): Promise<AssessmentVersion> {
    const [version] = await this.db
      .select()
      .from(assessmentVersions)
      .where(eq(assessmentVersions.id, versionId))
      .limit(1);

    if (version === undefined) {
      throw ApiError.notFound('Assessment version not found.');
    }

    return version;
  }

  private async templateFor(templateId: string): Promise<AssessmentTemplate> {
    const [template] = await this.db
      .select()
      .from(assessmentTemplates)
      .where(eq(assessmentTemplates.id, templateId))
      .limit(1);

    if (template === undefined) {
      throw ApiError.notFound('Assessment template not found.');
    }

    return template;
  }

  /** A version and its template in one joined read — they are asked for together everywhere. */
  private async versionWithTemplate(
    versionId: string,
  ): Promise<{ version: AssessmentVersion; template: AssessmentTemplate }> {
    const [row] = await this.db
      .select({ version: assessmentVersions, template: assessmentTemplates })
      .from(assessmentVersions)
      .innerJoin(
        assessmentTemplates,
        eq(assessmentVersions.assessmentTemplateId, assessmentTemplates.id),
      )
      .where(eq(assessmentVersions.id, versionId))
      .limit(1);

    if (row === undefined) {
      throw ApiError.notFound('Assessment version not found.');
    }

    return row;
  }

  private async templateForVersion(versionId: string): Promise<AssessmentTemplate> {
    const { template } = await this.versionWithTemplate(versionId);

    return template;
  }

  /**
   * How many REQUIRED questions on this version still have no answer.
   *
   * One LEFT-JOIN query, not required-then-answered: this runs on every submit, whose D1
   * budget is measured (§45, Phase 4.5).
   */
  private async unansweredRequiredCount(attempt: AssessmentAttempt): Promise<number> {
    const [row] = await this.db
      .select({ unanswered: count() })
      .from(assessmentQuestions)
      .leftJoin(
        assessmentAnswers,
        and(
          eq(assessmentAnswers.questionId, assessmentQuestions.id),
          eq(assessmentAnswers.attemptId, attempt.id),
        ),
      )
      .where(
        and(
          eq(assessmentQuestions.assessmentVersionId, attempt.assessmentVersionId),
          eq(assessmentQuestions.required, true),
          isNull(assessmentAnswers.id),
        ),
      );

    return row?.unanswered ?? 0;
  }

  private async loadAttemptContent(attempt: AssessmentAttempt): Promise<AttemptWithContent> {
    const version = await this.versionFor(attempt.assessmentVersionId);
    const template = await this.templateFor(version.assessmentTemplateId);

    const questions = await this.db
      .select()
      .from(assessmentQuestions)
      .where(eq(assessmentQuestions.assessmentVersionId, version.id))
      .orderBy(asc(assessmentQuestions.orderNumber));

    const questionIds = questions.map((question) => question.id);

    const options =
      questionIds.length === 0
        ? []
        : await this.db
            .select()
            .from(questionOptions)
            .where(inArray(questionOptions.questionId, questionIds))
            .orderBy(asc(questionOptions.orderNumber));

    const answers = await this.db
      .select({
        questionId: assessmentAnswers.questionId,
        selectedOptionId: assessmentAnswers.selectedOptionId,
        answerText: assessmentAnswers.answerText,
      })
      .from(assessmentAnswers)
      .where(eq(assessmentAnswers.attemptId, attempt.id));

    return {
      attempt,
      version,
      template,
      questions: questions.map((question) => ({
        ...question,
        options: options.filter((option) => option.questionId === question.id),
      })),
      answers,
    };
  }

  /**
   * Hydrate a set of attempts (each already joined to its template) into full `ResultView`s in a
   * **fixed number of D1 queries regardless of N** — the C1 fix.
   *
   * `resultFor` costs ~4 queries for one attempt; calling it per row (as the old listings did)
   * is the ~5N fan-out that blew the 50-subrequest ceiling on any real class. This replaces that
   * with three set queries: results by attempt (`inArray`), scored dimensions by attempt
   * (`inArray`, joined for the code), and every listed template's dimension rows (`inArray`) for
   * the serializer's id → name/description lookup. The result and dimension shapes are byte-identical
   * to what `resultFor` + `scoredDimensionsFor` produced, so serialized output does not drift.
   */
  private async hydrateResultViews(
    rows: { attempt: AssessmentAttempt; template: AssessmentTemplate }[],
  ): Promise<{
    views: ResultView[];
    dimensionsByTemplate: Map<string, AssessmentDimension[]>;
  }> {
    if (rows.length === 0) {
      return { views: [], dimensionsByTemplate: new Map() };
    }

    const attemptIds = rows.map((row) => row.attempt.id);
    const templateIds = [...new Set(rows.map((row) => row.template.id))];

    const [resultRows, scoredRows, dimensionRows] = await Promise.all([
      this.db
        .select()
        .from(assessmentResults)
        .where(inArray(assessmentResults.attemptId, attemptIds)),
      this.db
        .select({
          attemptId: dimensionScores.attemptId,
          dimensionId: dimensionScores.dimensionId,
          code: assessmentDimensions.code,
          rawScore: dimensionScores.rawScore,
          normalizedScore: dimensionScores.normalizedScore,
          interpretation: dimensionScores.interpretation,
        })
        .from(dimensionScores)
        .innerJoin(
          assessmentDimensions,
          eq(dimensionScores.dimensionId, assessmentDimensions.id),
        )
        .where(inArray(dimensionScores.attemptId, attemptIds))
        .orderBy(asc(assessmentDimensions.orderNumber)),
      this.db
        .select()
        .from(assessmentDimensions)
        .where(inArray(assessmentDimensions.assessmentTemplateId, templateIds))
        .orderBy(asc(assessmentDimensions.orderNumber)),
    ]);

    const resultByAttempt = new Map(resultRows.map((row) => [row.attemptId, row]));

    const scoredByAttempt = new Map<string, ScoredDimension[]>();
    for (const row of scoredRows) {
      const list = scoredByAttempt.get(row.attemptId) ?? [];
      list.push({
        dimensionId: row.dimensionId,
        code: row.code,
        rawScore: row.rawScore,
        normalizedScore: row.normalizedScore,
        interpretation: row.interpretation,
      });
      scoredByAttempt.set(row.attemptId, list);
    }

    const dimensionsByTemplate = new Map<string, AssessmentDimension[]>();
    for (const dimension of dimensionRows) {
      const list = dimensionsByTemplate.get(dimension.assessmentTemplateId) ?? [];
      list.push(dimension);
      dimensionsByTemplate.set(dimension.assessmentTemplateId, list);
    }

    const views = rows.map((row) => ({
      attempt: row.attempt,
      template: row.template,
      result: resultByAttempt.get(row.attempt.id),
      dimensions: scoredByAttempt.get(row.attempt.id) ?? [],
    }));

    return { views, dimensionsByTemplate };
  }

  /**
   * `known` lets a caller that already holds the attempt and template (submit does — it just
   * wrote them) skip re-reading rows this same request produced. Every other caller omits it.
   */
  private async resultFor(
    attemptId: string,
    known?: { attempt: AssessmentAttempt; template: AssessmentTemplate },
  ): Promise<ResultView> {
    const attempt = known?.attempt ?? (await this.findAttempt(attemptId));
    const template =
      known?.template ?? (await this.templateForVersion(attempt.assessmentVersionId));

    const [result] = await this.db
      .select()
      .from(assessmentResults)
      .where(eq(assessmentResults.attemptId, attemptId))
      .limit(1);

    const dimensions = await this.scoring.scoredDimensionsFor(attemptId);

    return { attempt, template, result, dimensions };
  }

  /**
   * Attach the per-assignment counts. The student view gets **their own attempt and nobody
   * else's**; the counselor view gets a completion count and no individual attempt.
   */
  private async decorateAssignments(
    rows: {
      assignment: AssessmentAssignment;
      version: AssessmentVersion;
      template: AssessmentTemplate;
    }[],
    student?: User,
  ): Promise<AssignmentView[]> {
    if (rows.length === 0) {
      return [];
    }

    // **H5:** two grouped queries for the whole list, not two per row. This runs on every
    // student assignments screen and every counselor class-assignments screen; the old per-row
    // fan-out was the same "N queries per unpaginated list" pattern as C1, one blast radius down.
    const versionIds = [...new Set(rows.map((row) => row.version.id))];
    const assignmentIds = rows.map((row) => row.assignment.id);

    const questionCounts = await this.db
      .select({ versionId: assessmentQuestions.assessmentVersionId, total: count() })
      .from(assessmentQuestions)
      .where(inArray(assessmentQuestions.assessmentVersionId, versionIds))
      .groupBy(assessmentQuestions.assessmentVersionId);

    const questionCountByVersion = new Map(
      questionCounts.map((row) => [row.versionId, row.total]),
    );

    if (student !== undefined) {
      // The student's own live attempt on each listed assignment, in one read. The partial unique
      // index guarantees at most one non-EXPIRED attempt per (assignment, student), so keying by
      // assignment id is unambiguous.
      const mine = await this.db
        .select()
        .from(assessmentAttempts)
        .where(
          and(
            inArray(assessmentAttempts.assignmentId, assignmentIds),
            eq(assessmentAttempts.studentId, student.id),
            ne(assessmentAttempts.status, 'EXPIRED'),
          ),
        );

      const mineByAssignment = new Map(mine.map((attempt) => [attempt.assignmentId, attempt]));

      return rows.map((row) => ({
        assignment: row.assignment,
        version: row.version,
        template: row.template,
        questionCount: questionCountByVersion.get(row.version.id) ?? 0,
        myAttempt: mineByAssignment.get(row.assignment.id) ?? null,
      }));
    }

    const submittedCounts = await this.db
      .select({ assignmentId: assessmentAttempts.assignmentId, total: count() })
      .from(assessmentAttempts)
      .where(
        and(
          inArray(assessmentAttempts.assignmentId, assignmentIds),
          inArray(assessmentAttempts.status, ['SUBMITTED', 'SCORED']),
        ),
      )
      .groupBy(assessmentAttempts.assignmentId);

    const submittedByAssignment = new Map(
      submittedCounts.map((row) => [row.assignmentId, row.total]),
    );

    return rows.map((row) => ({
      assignment: row.assignment,
      version: row.version,
      template: row.template,
      questionCount: questionCountByVersion.get(row.version.id) ?? 0,
      submittedCount: submittedByAssignment.get(row.assignment.id) ?? 0,
    }));
  }
}

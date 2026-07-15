import { and, asc, count, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';

import type { Database } from '@/db/client';
import {
  assessmentAnswers,
  assessmentAssignments,
  assessmentAttempts,
  assessmentQuestions,
  assessmentResults,
  assessmentTemplates,
  assessmentVersions,
  questionOptions,
  type AssessmentAssignment,
  type AssessmentAttempt,
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
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { ApiError } from '@/lib/envelope';
import type { ScoredDimension } from '@/lib/scoring';
import { ScoringService } from '@/modules/assessment/scoring-service';
import { ClassEnrollmentService } from '@/modules/classes/class-enrollment-service';
import { ClassService } from '@/modules/classes/class-service';
import { AuditService } from '@/modules/platform/audit-service';
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

    await this.db.insert(assessmentAttempts).values(attempt);

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

    const [existing] = await this.db
      .select()
      .from(assessmentAnswers)
      .where(
        and(eq(assessmentAnswers.attemptId, attemptId), eq(assessmentAnswers.questionId, questionId)),
      )
      .limit(1);

    if (existing !== undefined) {
      await this.db
        .update(assessmentAnswers)
        .set({
          selectedOptionId,
          score: option.option.score,
          answeredAt: now(),
        })
        .where(eq(assessmentAnswers.id, existing.id));

      return;
    }

    await this.db.insert(assessmentAnswers).values({
      id: uuid(),
      attemptId,
      questionId,
      selectedOptionId,
      answerText: null,
      score: option.option.score,
      answeredAt: now(),
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

    await this.db
      .update(assessmentAttempts)
      .set({ status: 'SUBMITTED', submittedAt, updatedAt: submittedAt })
      .where(eq(assessmentAttempts.id, attemptId));

    const { version, template } = await this.versionWithTemplate(attempt.assessmentVersionId);
    const scoredAttempt = { ...attempt, status: 'SUBMITTED' as const, submittedAt };

    // Inline (§24). Moves the attempt to SCORED and writes dimension_scores + assessment_results.
    const { generatedAt } = await this.scoring.score(scoredAttempt, version);

    const view = await this.resultFor(attemptId, {
      // Mirrors the row `score()` just wrote — status and updatedAt included — so the view
      // does not pay a D1 read to learn what this request itself did two lines up.
      attempt: { ...scoredAttempt, status: 'SCORED', updatedAt: generatedAt },
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
     * Phase 4 plugged `dispatchRecommendationGeneration` into the seam Step 4 left empty. The
     * notification listener is still Phase 6. A listener that throws cannot fail this request (see
     * `dispatch`): the scoring is committed and the student is waiting on the screen for it.
     */
    const event: AssessmentCompletedEvent = {
      type: 'AssessmentCompleted',
      attemptId,
      studentId: student.id,
      assessmentVersionId: attempt.assessmentVersionId,
      category: view.template.category,
    };

    await dispatch(event, [dispatchRecommendationGeneration(this.db, this.env)]);

    return view;
  }

  /** `SCORED` attempts only — an expired one never appears in a student's results (§21). */
  async listResultsForStudent(student: User): Promise<ResultView[]> {
    const attempts = await this.db
      .select()
      .from(assessmentAttempts)
      .where(
        and(eq(assessmentAttempts.studentId, student.id), eq(assessmentAttempts.status, 'SCORED')),
      )
      .orderBy(desc(assessmentAttempts.submittedAt));

    return Promise.all(attempts.map((attempt) => this.resultFor(attempt.id)));
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

    const [view] = await this.decorateAssignments([
      { assignment, version, template: await this.templateFor(version.assessmentTemplateId) },
    ]);

    if (view === undefined) {
      throw ApiError.notFound('Assignment not found.');
    }

    return view;
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

  /** Every scored attempt across a class (§37 — the counselor's results table). */
  async listResultsForClass(user: User, classId: string): Promise<ResultView[]> {
    const classRoom = await this.classes.find(user, classId);

    const attempts = await this.db
      .select({ attempt: assessmentAttempts })
      .from(assessmentAttempts)
      .innerJoin(
        assessmentAssignments,
        eq(assessmentAttempts.assignmentId, assessmentAssignments.id),
      )
      .where(
        and(
          eq(assessmentAssignments.classId, classRoom.id),
          eq(assessmentAttempts.status, 'SCORED'),
        ),
      )
      .orderBy(desc(assessmentAttempts.submittedAt));

    return Promise.all(attempts.map((row) => this.resultFor(row.attempt.id)));
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

  private async findAssignment(assignmentId: string): Promise<AssessmentAssignment | undefined> {
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
   * `known` lets a caller that already holds the attempt and template (submit does — it just
   * wrote them) skip re-reading rows this same request produced. Every other caller omits it.
   */
  private async resultFor(
    attemptId: string,
    known?: { attempt: AssessmentAttempt; template: AssessmentTemplate },
  ): Promise<ResultView> {
    const attempt = known?.attempt ?? (await this.findAttempt(attemptId));
    const template = known?.template ?? (await this.templateForVersion(attempt.assessmentVersionId));

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
    rows: { assignment: AssessmentAssignment; version: AssessmentVersion; template: AssessmentTemplate }[],
    student?: User,
  ): Promise<AssignmentView[]> {
    return Promise.all(
      rows.map(async (row) => {
        const [questions] = await this.db
          .select({ total: count() })
          .from(assessmentQuestions)
          .where(eq(assessmentQuestions.assessmentVersionId, row.version.id));

        const base: AssignmentView = {
          assignment: row.assignment,
          version: row.version,
          template: row.template,
          questionCount: questions?.total ?? 0,
        };

        if (student !== undefined) {
          const mine = await this.liveAttempt(row.assignment.id, student.id);

          return { ...base, myAttempt: mine ?? null };
        }

        const [submitted] = await this.db
          .select({ total: count() })
          .from(assessmentAttempts)
          .where(
            and(
              eq(assessmentAttempts.assignmentId, row.assignment.id),
              inArray(assessmentAttempts.status, ['SUBMITTED', 'SCORED']),
            ),
          );

        return { ...base, submittedCount: submitted?.total ?? 0 };
      }),
    );
  }
}

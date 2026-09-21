import { and, count, eq } from 'drizzle-orm';

import type { Database } from '@/db/client';
import {
  assessmentQuestions,
  assessmentTemplates,
  assessmentVersions,
  classStudents,
  classes,
} from '@/db/schema';
import type {
  AssessmentCompletedEvent,
  AssessmentDraftGeneratedEvent,
  KnowledgeDocumentProcessedEvent,
  Listener,
  RecommendationGeneratedEvent,
  StudentRenamedEvent,
} from '@/events/dispatcher';
import { NotificationService } from '@/modules/platform/notification-service';

/**
 * The Platform module's §60 subscriptions — the §44 notification table, made code (Phase 6).
 *
 * Each listener ends in a direct `NotificationService.send()` and nothing else: no delivery
 * state machine, no retry, no fan-out beyond what §44 names. Every one of these runs inside
 * `dispatch()`, so a failed insert is logged and absorbed — a notification must never fail
 * the scoring, generation, or ingestion it is *about*.
 *
 * (The fifth §44 notification — "assignment created for a class" — is not event-driven:
 * §60 catalogs exactly four events and assignment creation is not one of them, so the
 * fan-out is a direct service call at the end of `createAssignment` instead.)
 */

/** §44: "Your {assessment title} results are ready." */
export function notifyAssessmentCompleted(db: Database): Listener<AssessmentCompletedEvent> {
  return async (event) => {
    await new NotificationService(db).send({
      userId: event.studentId,
      title: 'Results ready',
      message: `Your ${event.assessmentTitle} results are ready.`,
      category: 'ASSESSMENT',
    });
  };
}

/** §44: "Your career recommendations are ready to view." */
export function notifyRecommendationGenerated(db: Database): Listener<RecommendationGeneratedEvent> {
  return async (event) => {
    await new NotificationService(db).send({
      userId: event.studentId,
      title: 'Recommendations ready',
      message: 'Your career recommendations are ready to view.',
      category: 'RECOMMENDATION',
    });
  };
}

/** §44: (to the uploading admin) "{file_name} is now available to the AI assistant." */
export function notifyKnowledgeDocumentProcessed(
  db: Database,
): Listener<KnowledgeDocumentProcessedEvent> {
  return async (event) => {
    await new NotificationService(db).send({
      userId: event.uploadedBy,
      title: 'Document processed',
      message: `${event.fileName} is now available to the AI assistant.`,
      category: 'ACCOUNT',
    });
  };
}

/**
 * §44: (to the requesting admin/counselor) "Your AI-generated draft for '{template title}'
 * is ready — {N} questions need review before you can publish."
 *
 * The event fires after every generation attempt, success or not (the job absorbs failures —
 * §30 v1.5), so the listener resolves the outcome itself: the questions carrying this
 * `ai_request_id` are the draft. Zero questions means the generation FAILED or §34 rejected
 * the output — states the status poll already reports honestly — and §44 specifies no
 * notification for them, so none is sent: "your draft is ready" must never be a lie.
 */
export function notifyAssessmentDraftGenerated(
  db: Database,
): Listener<AssessmentDraftGeneratedEvent> {
  return async (event) => {
    const [drafted] = await db
      .select({ value: count() })
      .from(assessmentQuestions)
      .where(eq(assessmentQuestions.sourceAiRequestId, event.aiRequestId));

    const questionCount = drafted?.value ?? 0;

    if (questionCount === 0) {
      return;
    }

    const [version] = await db
      .select({ title: assessmentTemplates.title })
      .from(assessmentVersions)
      .innerJoin(
        assessmentTemplates,
        eq(assessmentVersions.assessmentTemplateId, assessmentTemplates.id),
      )
      .where(eq(assessmentVersions.id, event.versionId))
      .limit(1);

    await new NotificationService(db).send({
      userId: event.creatorId,
      title: 'AI draft ready for review',
      message: `Your AI-generated draft for '${version?.title ?? 'your assessment'}' is ready — ${questionCount} question${questionCount === 1 ? '' : 's'} need review before you can publish.`,
      category: 'ASSESSMENT',
    });
  };
}

/**
 * (to every counselor whose active class holds them) "{old} is now {new}." — prompt-driven,
 * 2026-09-20.
 *
 * Three things the message has to carry, and the reason for each:
 *
 *   * **The old name first.** A counselor who reads only the new one cannot find the row that
 *     changed; the old name is the handle they have been using for this person all term.
 *   * **The username, and that it did not change.** This is the sentence that stops a support
 *     request. A rename changes what the student is called on the roster and on their exported
 *     report; it deliberately does not touch `class_students.username`, which is the credential
 *     the whole class signs in with and is unique per class.
 *   * **The class.** A counselor runs several, and "which roster do I look at" is the first thing
 *     they will want to know.
 *
 * `CLASS` rather than `ACCOUNT`, on §13.8's own logic for the assignment notification: this
 * reaches a counselor *because of* a class they own, not because of anything about their account.
 *
 * Silent when nobody qualifies — a student in no active class has no counselor whose roster just
 * changed, and inventing a recipient would be worse than saying nothing.
 */
export function notifyStudentRenamed(db: Database): Listener<StudentRenamedEvent> {
  return async (event) => {
    /*
      Queried here rather than through a module service, which is how every other listener in this
      file resolves what it needs — see the draft one above, which reads `assessment_questions`
      and `assessment_versions` directly.

      The reason is the direction of the dependency. This module is imported *by* the Assessment
      module (`assessment-attempt-service.ts` and `modules/assessment/routes.ts` both pull
      listeners out of it), so importing an Assessment service back into it points an edge the
      wrong way through a boundary §11 draws deliberately. A listener's dependency is the
      database; the module it reacts to is the thing that calls *it*.

      The rows are the student's active enrollments in active classes. Active on both sides: a
      counselor whose class is archived is not working from that roster, and a student removed
      from a class is not on it — neither has a roster that just changed.
    */
    const rows = await db
      .select({
        counselorId: classes.counselorId,
        className: classes.name,
        username: classStudents.username,
      })
      .from(classStudents)
      .innerJoin(classes, eq(classStudents.classId, classes.id))
      .where(
        and(
          eq(classStudents.studentId, event.studentId),
          eq(classStudents.status, 'active'),
          eq(classes.status, 'active'),
        ),
      );

    /*
      One notification per counselor, not per class. A counselor who teaches the same student in
      two of their classes learnt the fact once; saying it twice is noise, and the bell is the one
      surface where noise costs the next real message its attention.
    */
    const audience = new Map<string, (typeof rows)[number]>();

    for (const row of rows) {
      if (!audience.has(row.counselorId)) audience.set(row.counselorId, row);
    }

    if (audience.size === 0) {
      return;
    }

    const notifications = new NotificationService(db);

    /*
      One `send` per counselor rather than `sendToMany`, because the message is not the same for
      each of them: it names the class the rename shows up on and the username in that class, and
      both differ per counselor. A student is on one or two rosters, not forty.
    */
    for (const entry of audience.values()) {
      await notifications.send({
        userId: entry.counselorId,
        title: 'A student changed their name',
        message:
          `${event.from} is now ${event.to} in ${entry.className}. ` +
          `Their username (${entry.username}) has not changed, and their roster and results ` +
          'already show the new name.',
        category: 'CLASS',
      });
    }
  };
}

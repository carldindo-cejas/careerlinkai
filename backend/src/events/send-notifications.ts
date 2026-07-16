import { count, eq } from 'drizzle-orm';

import type { Database } from '@/db/client';
import { assessmentQuestions, assessmentTemplates, assessmentVersions } from '@/db/schema';
import type {
  AssessmentCompletedEvent,
  AssessmentDraftGeneratedEvent,
  KnowledgeDocumentProcessedEvent,
  Listener,
  RecommendationGeneratedEvent,
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

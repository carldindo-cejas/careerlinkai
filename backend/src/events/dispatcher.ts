/**
 * The in-process domain-event dispatcher (FULLPLAN §11) — a small typed pub/sub, not an external
 * broker, and deliberately so: v1 has exactly **four** events, and a message broker to carry four
 * events between modules that share a process would be infrastructure bought to solve a problem
 * nobody has (§3, principle 6).
 *
 * Two communication patterns exist in this system and only two. A **direct service call** is the
 * default and is used whenever the caller needs the answer. An **event** is used only for the
 * handful of cross-cutting reactions that must not block the triggering request — a listener that
 * needs real async work enqueues a Cloudflare Queues message rather than doing it here (§42).
 *
 * Listeners are registered per-request (the Worker has no long-lived process to register them in
 * at boot), which is why `dispatch` takes them rather than reading a module-level registry: a
 * global mutable registry in a Worker is shared across requests in ways that are very hard to
 * reason about and trivially leaks state between them.
 */

export interface AssessmentCompletedEvent {
  type: 'AssessmentCompleted';
  attemptId: string;
  studentId: string;
  assessmentVersionId: string;
  /** `RIASEC` | `SCCT` | `CUSTOM` — the listener needs it to decide what, if anything, to do. */
  category: string;
  /**
   * The template title, for §44's "Your {assessment title} results are ready." The submit
   * path already holds it, and the notification listener runs inside that request's
   * subrequest budget (§45) — carrying the title costs nothing; re-fetching it would cost
   * a query on every submit.
   */
  assessmentTitle: string;
}

/** §60: fired once a student's recommendation set has been generated and persisted. */
export interface RecommendationGeneratedEvent {
  type: 'RecommendationGenerated';
  studentId: string;
  careers: number;
  programs: number;
}

/**
 * §31 (Phase 5b): fired by `GenerateAssessmentDraftJob` once a draft lands (or fails to).
 * The listener — "notify the creator: your draft is ready for review" — is Phase 6's
 * notification system; the event fires now, with no listeners, at the seam it plugs into.
 */
export interface AssessmentDraftGeneratedEvent {
  type: 'AssessmentDraftGenerated';
  aiRequestId: string;
  versionId: string;
  creatorId: string;
}

/**
 * §60's third event (Phase 6): fired by the ingestion pipeline when the last embedding batch
 * lands and the document flips to COMPLETED. `fileName` rides along for §44's message —
 * "{file_name} is now available to the AI assistant." — so the listener writes one row and
 * reads nothing.
 */
export interface KnowledgeDocumentProcessedEvent {
  type: 'KnowledgeDocumentProcessed';
  documentId: string;
  uploadedBy: string;
  fileName: string;
}

/**
 * The fifth event (v1.5, migration 0014) — fired by `ClassService.create`.
 *
 * §60 catalogs four events, and this is deliberately a fifth rather than a direct call. A global
 * assessment assignment must reach classes created after it was made, so *something* has to react to
 * class creation; the only two ways to arrange that are the Class module calling into the Assessment
 * module, or an event. The first would put an assessment concern inside class creation and close an
 * import cycle (`AssessmentAttemptService` already imports `ClassService`). The second is what the
 * dispatcher is for, and it keeps the failure mode right: a class must still be created if applying
 * the assignments fails, and `dispatch` guarantees exactly that.
 *
 * Recorded as deviation D27 in PROGRESS.md.
 */
export interface ClassCreatedEvent {
  type: 'ClassCreated';
  classId: string;
  /** The counselor who created it — the audit actor for whatever the listener writes. */
  counselorId: string;
}

export type DomainEvent =
  | AssessmentCompletedEvent
  | RecommendationGeneratedEvent
  | AssessmentDraftGeneratedEvent
  | KnowledgeDocumentProcessedEvent
  | ClassCreatedEvent;

export type Listener<E extends DomainEvent> = (event: E) => Promise<void>;

/**
 * Fire an event at its listeners.
 *
 * **A failing listener must not fail the triggering request.** `AssessmentCompleted` fires at the
 * end of scoring, and the student is sitting on the submit screen waiting for their result: if a
 * downstream notification or a queue enqueue throws, the right outcome is a scored attempt and a
 * logged error, not a 500 on an assessment the student *did* complete. The scoring already
 * happened and is committed; the event is a reaction to it, not a part of it.
 */
export async function dispatch<E extends DomainEvent>(
  event: E,
  listeners: Listener<E>[],
): Promise<void> {
  for (const listener of listeners) {
    try {
      await listener(event);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'A domain-event listener failed.',
          event: event.type,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

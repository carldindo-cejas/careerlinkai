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

export type DomainEvent =
  | AssessmentCompletedEvent
  | RecommendationGeneratedEvent
  | AssessmentDraftGeneratedEvent;

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

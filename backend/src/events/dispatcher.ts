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
 * The fifth event (v1.5, migration 0014) — **"a class became able to receive assignments"**.
 *
 * §60 catalogs four events, and this is deliberately a fifth rather than a direct call. A global
 * assessment assignment must reach classes that were not eligible when it was made, so *something*
 * has to react; the only two ways to arrange that are the Class module calling into the Assessment
 * module, or an event. The first would put an assessment concern inside class creation and close an
 * import cycle (`AssessmentAttemptService` already imports `ClassService`). The second is what the
 * dispatcher is for, and it keeps the failure mode right: a class must still be created — or
 * activated — if applying the assignments fails, and `dispatch` guarantees exactly that.
 *
 * **`reason` rather than two events** (v1.6). There are two moments a class becomes eligible: it is
 * created (always `active`), or a `draft`/`archived` one is switched to `active`. Both need the same
 * top-up, and the second was a real hole — a class drafted before an administrator assigned globally
 * and activated afterwards would never have received the assignment, so its students would have been
 * missing an assessment that the admin list truthfully reported as reaching "every class". These are
 * one fact with two causes, not two facts, so they are one event; the reason travels for the audit
 * row, which should not claim a class was created when it was reactivated.
 *
 * Recorded as deviation D27 in PROGRESS.md.
 */
export interface ClassActivatedEvent {
  type: 'ClassActivated';
  classId: string;
  /** The staff member whose act made the class eligible — the audit actor for the listener's row. */
  counselorId: string;
  reason: 'CREATED' | 'REACTIVATED';
}

/**
 * The sixth event (migration 0017) — **"the grade level or strand a class assigns has changed"**.
 *
 * An event for the same reason `ClassActivated` is one, and the reasoning transfers exactly: a
 * student's grade level and strand now derive from their class, so *something* has to copy the new
 * value onto `student_profiles` — and `student_profiles` is written by
 * `StudentProfileService`, which lives in the Assessment module. The Class module calling it
 * directly would put a profile concern inside class editing and reach across a §11 module boundary
 * to do it.
 *
 * The failure mode is the deciding argument, as it was there: **a counselor must still get the
 * class edit they asked for if the profile sync fails.** `dispatch` guarantees that, and the
 * recovery is a re-save — the sync is idempotent, since it writes the class's current value rather
 * than a delta.
 *
 * Fires on class edit and on enrollment. `studentIds` scopes it: absent means "every active student
 * in this class" (the edit path), present means exactly these (the enrollment path), so a roster
 * confirmation does not rewrite sixty profiles to set two.
 */
export interface ClassRosterFieldsChangedEvent {
  type: 'ClassRosterFieldsChanged';
  classId: string;
  studentIds?: string[];
}

export type DomainEvent =
  | AssessmentCompletedEvent
  | RecommendationGeneratedEvent
  | AssessmentDraftGeneratedEvent
  | KnowledgeDocumentProcessedEvent
  | ClassActivatedEvent
  | ClassRosterFieldsChangedEvent;

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

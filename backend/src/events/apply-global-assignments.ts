import type { Database } from '@/db/client';
import type { ClassActivatedEvent, Listener } from '@/events/dispatcher';
import { applyGlobalAssignmentsToClass } from '@/modules/assessment/global-assignments';

/**
 * The Assessment module's subscription to `ClassActivated` (v1.5, migration 0014; extended v1.6).
 *
 * A global assignment writes one ordinary row per class, which is what keeps enrollment,
 * authorization and the §44 fan-out resolving through a real class — and what leaves a class that
 * was not eligible at the time without a row. This listener closes that gap at both moments it
 * opens: a class created after the assignment, and a `draft`/`archived` class switched to `active`
 * after it.
 *
 * It runs inside `dispatch()`, so a failure here is logged and absorbed: **a class must still be
 * created or activated if applying the global assignments fails.** The counselor asked for a class,
 * not for an assessment rollout, and the recovery is already in the product — an administrator
 * re-running "Assign globally" tops up whatever is missing.
 */
export function applyGlobalAssignments(db: Database): Listener<ClassActivatedEvent> {
  return async (event) => {
    const applied = await applyGlobalAssignmentsToClass(db, event.classId, event.counselorId, {
      /**
       * **A reactivated class notifies its students; a newly created one has nobody to notify.**
       * That asymmetry is the whole reason the reason travels on the event: a class being switched
       * back on may already hold a roster, and silently handing those students three assessments
       * they were never told about is how a deadline gets missed.
       */
      notify: event.reason === 'REACTIVATED',
      reason: event.reason,
    });

    if (applied > 0) {
      console.log(
        JSON.stringify({
          level: 'info',
          message: 'Applied global assessment assignments to a class.',
          class_id: event.classId,
          reason: event.reason,
          assessment_versions: applied,
        }),
      );
    }
  };
}

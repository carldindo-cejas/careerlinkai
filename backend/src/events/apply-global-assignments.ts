import type { Database } from '@/db/client';
import type { ClassCreatedEvent, Listener } from '@/events/dispatcher';
import { applyGlobalAssignmentsToNewClass } from '@/modules/assessment/global-assignments';

/**
 * The Assessment module's subscription to `ClassCreated` (v1.5, migration 0014).
 *
 * A global assignment writes one ordinary row per class, which is what keeps enrollment,
 * authorization and the §44 fan-out resolving through a real class — and what leaves a class created
 * afterwards without a row. This listener closes that gap at the only moment it opens.
 *
 * It runs inside `dispatch()`, so a failure here is logged and absorbed: **a class must still be
 * created if applying the global assignments fails.** The counselor asked for a class, not for an
 * assessment rollout, and the recovery is already in the product — an administrator re-running
 * "Assign globally" tops up whatever is missing.
 */
export function applyGlobalAssignments(db: Database): Listener<ClassCreatedEvent> {
  return async (event) => {
    const applied = await applyGlobalAssignmentsToNewClass(db, event.classId, event.counselorId);

    if (applied > 0) {
      console.log(
        JSON.stringify({
          level: 'info',
          message: 'Applied global assessment assignments to a new class.',
          class_id: event.classId,
          assessment_versions: applied,
        }),
      );
    }
  };
}

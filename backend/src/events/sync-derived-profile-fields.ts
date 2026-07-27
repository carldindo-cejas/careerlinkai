import type { Database } from '@/db/client';
import type { ClassRosterFieldsChangedEvent, Listener } from '@/events/dispatcher';
import { StudentProfileService } from '@/modules/assessment/student-profile-service';

/**
 * The Assessment module's subscription to `ClassRosterFieldsChanged` (migration 0017).
 *
 * Grade level and SHS strand are properties of the class a counselor enrolled a student in, and
 * this is what carries them onto the student's own profile — at enrollment, and again whenever the
 * class's values change.
 *
 * It runs inside `dispatch()`, so a failure here is logged and absorbed. That is the right
 * trade rather than a convenient one: **a counselor must still get the class edit or the roster
 * confirmation they asked for.** The sync writes the class's current value rather than a delta, so
 * it is idempotent — the recovery for a failed run is any later re-save, and nothing has to
 * remember that it failed.
 */
export function syncDerivedProfileFields(db: Database): Listener<ClassRosterFieldsChangedEvent> {
  return async (event) => {
    const synced = await new StudentProfileService(db).syncFromClass(
      event.classId,
      event.studentIds,
    );

    if (synced > 0) {
      console.log(
        JSON.stringify({
          level: 'info',
          message: "Synced a class's grade level and strand onto its students' profiles.",
          class_id: event.classId,
          students: synced,
        }),
      );
    }
  };
}

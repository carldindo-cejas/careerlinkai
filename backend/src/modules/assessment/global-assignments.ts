import { and, desc, eq, inArray } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';

import type { Database } from '@/db/client';
import {
  assessmentAssignments,
  assessmentTemplates,
  assessmentVersions,
  type AssessmentAssignment,
} from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { AuditService } from '@/modules/platform/audit-service';

/**
 * Keeping "Global" true for classes that did not exist when the assignment was made.
 *
 * A global assignment is one ordinary row per class (migration 0014), which makes every rule
 * downstream keep working — and leaves one gap: a class created afterwards has no row. This closes
 * it at the moment the gap would open.
 *
 * **A standalone function rather than a method on `AssessmentAttemptService`, and that is
 * structural.** The trigger is class creation, so `ClassService` has to reach this code; but
 * `AssessmentAttemptService` imports `ClassService`, and a method there would close an import cycle.
 * This function depends on the assessment module's own tables and takes the class **id** as a
 * parameter, so the dependency runs one way: Class → this → schema.
 *
 * §11 is satisfied the same way: the Class module does not query assessment tables, it fires an
 * event, and this is what the listener calls.
 */

/** The columns of `assessment_assignments`, for the D1 parameter budget — see `chunk`. */
const ASSIGNMENT_COLUMNS = 7;
const D1_MAX_BOUND_PARAMS = 100;

function chunk<T>(rows: T[], columnsPerRow: number): T[][] {
  const size = Math.max(1, Math.floor(D1_MAX_BOUND_PARAMS / columnsPerRow));
  const chunks: T[][] = [];

  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }

  return chunks;
}

/**
 * Give one newly-created class every assessment that is currently assigned globally.
 *
 * **Creation-time only, and it deliberately sends no notifications.** A class is created before it
 * has a roster — students join afterwards, through the join code — so there is nobody to notify, and
 * every one of them will see the assignment on their dashboard the moment they join. Calling this
 * against a class that already has students would silently skip telling them, so do not: the
 * administrator's own "assign globally" is the path that notifies, and it is the one to use for a
 * class already in flight.
 *
 * Everything is a fixed number of queries: one read of the current global assignments, one read of
 * what this class already holds, one chunked insert, one audit row.
 */
export async function applyGlobalAssignmentsToNewClass(
  db: Database,
  classId: string,
  /** The class's counselor — the audit row's actor, since creating the class is what caused this. */
  actorId: string,
): Promise<number> {
  /**
   * Every version that is globally assigned right now, newest act first.
   *
   * The three status filters are the same ones the administrator's own assign path enforces, and
   * they matter more here because nobody is watching: an archived assessment, an unpublished
   * version, or a closed assignment must not be resurrected onto a new class just because a row
   * survives somewhere. `deleted_at IS NULL` keeps a soft-deleted instrument out for the same reason.
   */
  const globals = await db
    .select({
      versionId: assessmentAssignments.assessmentVersionId,
      assignedBy: assessmentAssignments.assignedBy,
      deadline: assessmentAssignments.deadline,
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
        eq(assessmentAssignments.scope, 'GLOBAL'),
        eq(assessmentAssignments.status, 'ACTIVE'),
        eq(assessmentVersions.status, 'PUBLISHED'),
        eq(assessmentTemplates.status, 'ACTIVE'),
      ),
    )
    .orderBy(desc(assessmentAssignments.createdAt));

  /**
   * One row per version, keeping the **most recent** global act.
   *
   * A version assigned globally twice — say with a new deadline the second time — should reach a
   * new class with the deadline that is currently in force, not with whichever row the database
   * happened to return first. DESC order means the first row seen for a version is the newest.
   */
  const byVersion = new Map<string, { assignedBy: string; deadline: string | null }>();

  for (const row of globals) {
    if (!byVersion.has(row.versionId)) {
      byVersion.set(row.versionId, { assignedBy: row.assignedBy, deadline: row.deadline });
    }
  }

  if (byVersion.size === 0) {
    return 0;
  }

  // Defensive, and cheap: a brand-new class holds nothing, but this keeps the function safe to call
  // twice without writing the duplicate the (version, class) pair would otherwise accumulate.
  const existing = new Set(
    (
      await db
        .select({ versionId: assessmentAssignments.assessmentVersionId })
        .from(assessmentAssignments)
        .where(
          and(
            eq(assessmentAssignments.classId, classId),
            eq(assessmentAssignments.status, 'ACTIVE'),
            inArray(assessmentAssignments.assessmentVersionId, [...byVersion.keys()]),
          ),
        )
    ).map((row) => row.versionId),
  );

  const timestamp = now();
  const rows: AssessmentAssignment[] = [...byVersion.entries()]
    .filter(([versionId]) => !existing.has(versionId))
    .map(([versionId, source]) => ({
      id: uuid(),
      assessmentVersionId: versionId,
      classId,
      /**
       * The **original global assigner**, not the counselor creating the class. This row exists
       * because an administrator assigned the instrument to everyone; attributing it to whoever
       * happened to create a class next would make the audit trail say something untrue about who
       * decided this class would sit this assessment.
       */
      assignedBy: source.assignedBy,
      deadline: source.deadline,
      status: 'ACTIVE',
      scope: 'GLOBAL',
      createdAt: timestamp,
    }));

  if (rows.length === 0) {
    return 0;
  }

  const statements: BatchItem<'sqlite'>[] = chunk(rows, ASSIGNMENT_COLUMNS).map((batch) =>
    db.insert(assessmentAssignments).values(batch),
  );

  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);

  await new AuditService(db).write({
    userId: actorId,
    action: 'ASSESSMENT_ASSIGNED',
    module: 'Assessment',
    targetType: 'class',
    targetId: classId,
    newValues: {
      scope: 'GLOBAL',
      /** The flag that distinguishes this from a deliberate act, when someone reads the log later. */
      auto_applied_on_class_creation: true,
      assessment_versions: rows.length,
    },
  });

  return rows.length;
}

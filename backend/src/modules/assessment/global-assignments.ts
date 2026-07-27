import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';

import type { Database } from '@/db/client';
import {
  assessmentAssignments,
  assessmentTemplates,
  assessmentVersions,
  classStudents,
  type AssessmentAssignment,
} from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { chunkForInsert } from '@/lib/d1-batching';
import { now } from '@/lib/datetime';
import { AuditService } from '@/modules/platform/audit-service';
import { NotificationService } from '@/modules/platform/notification-service';

/**
 * Keeping "Global" true for classes that were not eligible when the assignment was made.
 *
 * A global assignment is one ordinary row per class (migration 0014), which makes every rule
 * downstream keep working — and leaves one gap: a class that was not `active` at the time has no
 * row. There are exactly two ways into that gap, and this closes both — a class created after the
 * assignment, and a `draft`/`archived` class switched to `active` after it.
 *
 * **A standalone function rather than a method on `AssessmentAttemptService`, and that is
 * structural.** The trigger is a class lifecycle change, so `ClassService` has to reach this code;
 * but `AssessmentAttemptService` imports `ClassService`, and a method there would close an import
 * cycle. This function depends on the assessment module's own tables and takes the class **id** as a
 * parameter, so the dependency runs one way: Class → this → schema.
 *
 * §11 is satisfied the same way: the Class module does not query assessment tables, it fires an
 * event, and this is what the listener calls.
 */

// The D1 parameter budget lives in `lib/d1-batching.ts`, derived from the table. This file used to
// carry its own hand-counted `7`, which went stale the moment migration 0014 added `scope`.

export interface ApplyGlobalAssignmentsOptions {
  /**
   * Whether the class's roster is told about what just landed (§44).
   *
   * **False at creation, true on reactivation**, and the difference is not cosmetic. A class is
   * created before it has a roster — students join afterwards through the join code — so there is
   * nobody to notify and every one of them sees the assignment the moment they join. A class being
   * switched back on may already hold forty students, and handing them assessments in silence is
   * how a deadline is missed by people who were never told it existed.
   */
  notify?: boolean;
  /** Recorded on the audit row so it does not claim a class was created when it was reactivated. */
  reason?: 'CREATED' | 'REACTIVATED';
}

/**
 * Give one class every assessment that is currently assigned globally.
 *
 * **Idempotent**, which is what makes it safe to call at both lifecycle moments and safe to call
 * twice: a class that already holds an ACTIVE assignment for a version is skipped, so this tops up
 * rather than duplicating.
 *
 * Everything is a fixed number of queries: one read of the current global assignments, one read of
 * what this class already holds, one chunked insert, one audit row, and — only when notifying — one
 * roster read and one fan-out.
 */
export async function applyGlobalAssignmentsToClass(
  db: Database,
  classId: string,
  /** The staff member whose act caused this — the audit row's actor. */
  actorId: string,
  options: ApplyGlobalAssignmentsOptions = {},
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
      title: assessmentTemplates.title,
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
        // v1.6: a soft-deleted instrument must not be resurrected onto a class either. The status
        // filter above does not cover it — `deleteTemplate` archives as well, but a row deleted by
        // any other route would still read as ACTIVE.
        isNull(assessmentTemplates.deletedAt),
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
  const byVersion = new Map<
    string,
    { assignedBy: string; deadline: string | null; title: string }
  >();

  for (const row of globals) {
    if (!byVersion.has(row.versionId)) {
      byVersion.set(row.versionId, {
        assignedBy: row.assignedBy,
        deadline: row.deadline,
        title: row.title,
      });
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

  const statements: BatchItem<'sqlite'>[] = chunkForInsert(rows, assessmentAssignments).map(
    (batch) => db.insert(assessmentAssignments).values(batch),
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
      /** …and *which* lifecycle moment did it, so the log does not say "created" about a switch-on. */
      trigger: options.reason ?? 'CREATED',
      assessment_versions: rows.length,
    },
  });

  /**
   * §44, for the reactivation case only — and absorbed on failure for the same reason every other
   * fan-out in this module is: the assignments are already committed, and a notification hiccup
   * must not turn a successful activation into a 500. `dispatch()` would absorb a throw here
   * anyway; catching it locally is what keeps the count this function returns honest.
   */
  if (options.notify === true) {
    try {
      const roster = await db
        .select({ studentId: classStudents.studentId })
        .from(classStudents)
        .where(and(eq(classStudents.classId, classId), eq(classStudents.status, 'active')));

      if (roster.length > 0) {
        const titles = [...byVersion.entries()]
          .filter(([versionId]) => !existing.has(versionId))
          .map(([, source]) => source.title);

        await new NotificationService(db).sendToMany(
          roster.map((row) => row.studentId),
          {
            title: 'New assessment assigned',
            message:
              titles.length === 1
                ? `New assessment assigned: ${titles[0]}.`
                : `${titles.length} new assessments assigned: ${titles.join(', ')}.`,
            category: 'CLASS',
          },
        );
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'Global-assignment top-up notification fan-out failed.',
          class_id: classId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  return rows.length;
}

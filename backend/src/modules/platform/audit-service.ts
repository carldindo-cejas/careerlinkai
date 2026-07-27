import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  like,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import type { Database } from '@/db/client';
import { auditLogs, users, type AuditLog } from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { paginate, type PaginatedData } from '@/lib/envelope';

/**
 * The export ceiling. See `AuditService.export` — a hard cap turns "works until the log is big
 * enough to fail" into a stated, narrow-your-range outcome the UI can explain.
 */
export const AUDIT_EXPORT_LIMIT = 5_000;

/**
 * AuditService (FULLPLAN §13.8, §38).
 *
 * The append-only trail of critical actions. For the passwordless student model this table
 * is the *primary* security-monitoring surface, not an archival nicety — impersonation
 * attempts surface here or nowhere.
 *
 * `write()` is the only mutating method that will ever exist on this service: no update, no
 * delete, no "correct a bad entry". A wrong entry is history too.
 */

/** The action vocabulary. Kept as a union so a typo is a type error, not a silent new action. */
export type AuditAction =
  | 'STAFF_LOGIN_SUCCESS'
  | 'STAFF_LOGIN_FAILED'
  | 'STAFF_LOGOUT'
  | 'STAFF_PASSWORD_CHANGED'
  | 'STAFF_PASSWORD_RESET_REQUESTED'
  | 'STAFF_PASSWORD_RESET_COMPLETED'
  | 'STUDENT_CLASS_ACCESS_SUCCESS'
  | 'STUDENT_CLASS_ACCESS_FAILED'
  | 'STUDENT_CLASS_ACCESS_THROTTLED'
  | 'CLASS_CREATED'
  | 'CLASS_UPDATED'
  | 'CLASS_DELETED'
  | 'CLASS_CODE_REGENERATED'
  | 'ROSTER_STUDENTS_ENROLLED'
  | 'ROSTER_STUDENT_REMOVED'
  | 'COLLEGE_CREATED'
  | 'COLLEGE_UPDATED'
  | 'COLLEGE_DELETED'
  | 'PROGRAM_CREATED'
  | 'PROGRAM_UPDATED'
  | 'PROGRAM_DELETED'
  // The canonical program catalog (migration 0018). `MERGED` is audited as its own action rather
  // than as an UPDATE because it silently re-points every offering that named the absorbed entry —
  // the row records how many moved, which is the only trace of a change nothing else logs.
  | 'CANONICAL_PROGRAM_CREATED'
  | 'CANONICAL_PROGRAM_UPDATED'
  | 'CANONICAL_PROGRAM_MERGED'
  | 'CAREER_CREATED'
  | 'CAREER_UPDATED'
  | 'CAREER_DELETED'
  // The mapping is scored, not decorative: linking or archiving a career shifts the §27
  // RIASEC average of every program it touches. These two are recorded for the same reason
  // a grade change is — someone will one day ask why a program's ranking moved.
  | 'PROGRAM_CAREER_LINKED'
  | 'PROGRAM_CAREER_UNLINKED'
  // Address hierarchy (v1.5, migration 0011). Bulk imports are recorded as a single row carrying
  // the count and the names, not one row per inserted place — a paste of forty barangays is one
  // administrative act, and forty audit rows would bury the log rather than document it. A delete
  // records how many descendants the cascade took with it, for the same "why did these disappear"
  // reason the catalog's cascade delete is audited.
  | 'REGIONS_BULK_IMPORTED'
  | 'PROVINCES_BULK_IMPORTED'
  | 'TOWNS_BULK_IMPORTED'
  | 'BARANGAYS_BULK_IMPORTED'
  // A place can be renamed (or its PSGC code corrected) after import — a single-field edit, never a
  // re-parenting, so the row records the old and new name for the same "why did this change" reason
  // every other catalog edit is audited.
  | 'REGION_UPDATED'
  | 'PROVINCE_UPDATED'
  | 'TOWN_UPDATED'
  | 'BARANGAY_UPDATED'
  | 'REGION_DELETED'
  | 'PROVINCE_DELETED'
  | 'TOWN_DELETED'
  | 'BARANGAY_DELETED'
  // Assessment (§13.4, §21, §25). `ASSESSMENT_PUBLISHED` is the one §13.8 names by example, and
  // it is the one that matters most: publishing is the irreversible act — the version freezes,
  // and every attempt taken against it forever after is scored by what was confirmed that day.
  // The audit row records how many mappings had been confirmed, so "who let this through the
  // gate" has an answer.
  | 'ASSESSMENT_TEMPLATE_CREATED'
  // Migration 0014. An edit changes how an assessment is *described* — its title, its type, its
  // scoring methods — never how an attempt was scored, which is why it is permitted after publish
  // where nothing else is. The row records the old and new type for exactly that reason: the field
  // is now a filter and a validation input, so "when did this become a Personality test" is a
  // question the log should be able to answer.
  | 'ASSESSMENT_TEMPLATE_UPDATED'
  // Archiving retires an instrument from the assignable list. Recorded because it is the act that
  // makes an assessment stop being offered, while deliberately leaving assignments already in
  // flight alone — so "why can I no longer assign this" has an answer with a name and a date.
  | 'ASSESSMENT_TEMPLATE_ARCHIVED'
  | 'ASSESSMENT_TEMPLATE_RESTORED'
  // The soft delete (v1.6). Distinct from archiving because it is the act that removes an
  // instrument from every screen rather than merely from the assignable list — and because it is
  // refused outright once a student has answered it, which makes the rows that *do* exist here the
  // record of an assessment that was removed before anybody sat it.
  | 'ASSESSMENT_TEMPLATE_DELETED'
  // The §25 act itself (Phase 5b): a human confirming what a question measures. Recorded
  // per mapping because the gate's promise is that *someone looked at each one* — this row
  // is who, and when.
  | 'QUESTION_DIMENSION_CONFIRMED'
  | 'ASSESSMENT_PUBLISHED'
  | 'ASSESSMENT_ASSIGNED'
  | 'ASSESSMENT_ASSIGNMENT_CLOSED'
  | 'ASSESSMENT_SUBMITTED'
  // The retake. Recorded because it *voids a result a student already produced* — the one action
  // in this module that destroys standing evidence, and the one someone will later ask about.
  | 'ASSESSMENT_ATTEMPT_RESET'
  // Recommendation (§27). Recorded because a student is shown a ranked list with a number next to
  // every row, and "why did BSCS drop from 2nd to 5th?" is a question someone will eventually ask
  // about a specific student on a specific day. §26 promises the ranking is reproducible; this row
  // records the inputs' fingerprint (how many of each type, the top scores) so the claim can be
  // checked rather than merely asserted.
  | 'RECOMMENDATIONS_GENERATED'
  // AI / Knowledge (§13.7, Phase 5a). Uploads and archives change what the AI is *able* to
  // say to students (the retrieval corpus); a policy edit changes what it is *allowed* to
  // say. Both are exactly the class of action §13.8 exists for.
  | 'KNOWLEDGE_DOCUMENT_UPLOADED'
  | 'KNOWLEDGE_DOCUMENT_ARCHIVED'
  | 'KNOWLEDGE_DOCUMENT_REPROCESSED'
  | 'AI_POLICY_UPDATED'
  // Counselor management (§20, Phase 6). Recorded because these are the account-lifecycle
  // acts on the role that can read every student's results: who was given that access, who
  // suspended it, and who removed it are questions with exactly one honest source of answers.
  | 'COUNSELOR_CREATED'
  | 'COUNSELOR_UPDATED'
  | 'COUNSELOR_DELETED';

/**
 * Why a join attempt failed. Never sent to the client — the API answers every failure
 * identically (§38) — and written to `audit_logs.new_values.reason` instead. The API tells
 * the caller nothing; the audit trail tells the operator everything.
 */
export type JoinFailureReason =
  | 'INVALID_CODE'
  | 'CODE_EXPIRED'
  | 'CLASS_NOT_ACTIVE'
  | 'UNKNOWN_USERNAME'
  | 'ENROLLMENT_REMOVED'
  | 'ACCOUNT_INACTIVE';

export interface AuditEntry {
  action: AuditAction;
  module: string;
  /** NULL for system actions, and for failed logins/joins where no user was resolved. */
  userId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

/**
 * The action **groups** the viewer filters by (prompt-driven, v1.6).
 *
 * An operator does not think in the 50-value vocabulary above; they think "show me everything that
 * was deleted". So the filter offers groups — and the mapping from action to group is an explicit
 * `Record<AuditAction, …>` rather than a suffix pattern, which is the whole point of doing it this
 * way. A `LIKE '%_DELETED'` heuristic would silently misfile `ROSTER_STUDENT_REMOVED` and
 * `PROGRAM_CAREER_UNLINKED` (both deletions), and would keep on silently misfiling every action
 * added afterwards. An exhaustive record cannot: a new `AuditAction` without an entry here is a
 * **type error**, so the group list can never quietly fall behind the vocabulary it describes.
 *
 * It also makes the filter an `IN (…)` over an indexed column rather than a leading-wildcard LIKE,
 * which on a table with no retention policy is the difference between a seek and a scan.
 */
export const AUDIT_ACTION_TYPES = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'ARCHIVE',
  'RESTORE',
  'PUBLISH',
  'ASSIGN',
  'SUBMIT',
  'LOGIN',
  'LOGOUT',
  'OTHER',
] as const;
export type AuditActionType = (typeof AUDIT_ACTION_TYPES)[number];

const ACTION_TYPES: Record<AuditAction, AuditActionType> = {
  // Authentication. A *failed* login is still a login attempt: an operator filtering for LOGIN is
  // looking for sign-in activity, and the failures are the rows they most want to see.
  STAFF_LOGIN_SUCCESS: 'LOGIN',
  STAFF_LOGIN_FAILED: 'LOGIN',
  STAFF_LOGOUT: 'LOGOUT',
  STUDENT_CLASS_ACCESS_SUCCESS: 'LOGIN',
  STUDENT_CLASS_ACCESS_FAILED: 'LOGIN',
  STUDENT_CLASS_ACCESS_THROTTLED: 'LOGIN',
  // Credential lifecycle — changes to an account, not sign-ins.
  STAFF_PASSWORD_CHANGED: 'UPDATE',
  STAFF_PASSWORD_RESET_REQUESTED: 'UPDATE',
  STAFF_PASSWORD_RESET_COMPLETED: 'UPDATE',
  // Classes and roster.
  CLASS_CREATED: 'CREATE',
  CLASS_UPDATED: 'UPDATE',
  CLASS_DELETED: 'DELETE',
  /** A rotation revokes the old code — an update to the class, not a new class. */
  CLASS_CODE_REGENERATED: 'UPDATE',
  ROSTER_STUDENTS_ENROLLED: 'CREATE',
  ROSTER_STUDENT_REMOVED: 'DELETE',
  // Catalog.
  COLLEGE_CREATED: 'CREATE',
  COLLEGE_UPDATED: 'UPDATE',
  COLLEGE_DELETED: 'DELETE',
  PROGRAM_CREATED: 'CREATE',
  PROGRAM_UPDATED: 'UPDATE',
  PROGRAM_DELETED: 'DELETE',
  CANONICAL_PROGRAM_CREATED: 'CREATE',
  CANONICAL_PROGRAM_UPDATED: 'UPDATE',
  CANONICAL_PROGRAM_MERGED: 'UPDATE',
  CAREER_CREATED: 'CREATE',
  CAREER_UPDATED: 'UPDATE',
  CAREER_DELETED: 'DELETE',
  PROGRAM_CAREER_LINKED: 'CREATE',
  PROGRAM_CAREER_UNLINKED: 'DELETE',
  // Address hierarchy.
  REGIONS_BULK_IMPORTED: 'CREATE',
  PROVINCES_BULK_IMPORTED: 'CREATE',
  TOWNS_BULK_IMPORTED: 'CREATE',
  BARANGAYS_BULK_IMPORTED: 'CREATE',
  REGION_UPDATED: 'UPDATE',
  PROVINCE_UPDATED: 'UPDATE',
  TOWN_UPDATED: 'UPDATE',
  BARANGAY_UPDATED: 'UPDATE',
  REGION_DELETED: 'DELETE',
  PROVINCE_DELETED: 'DELETE',
  TOWN_DELETED: 'DELETE',
  BARANGAY_DELETED: 'DELETE',
  // Assessment.
  ASSESSMENT_TEMPLATE_CREATED: 'CREATE',
  ASSESSMENT_TEMPLATE_UPDATED: 'UPDATE',
  ASSESSMENT_TEMPLATE_ARCHIVED: 'ARCHIVE',
  ASSESSMENT_TEMPLATE_RESTORED: 'RESTORE',
  ASSESSMENT_TEMPLATE_DELETED: 'DELETE',
  QUESTION_DIMENSION_CONFIRMED: 'UPDATE',
  ASSESSMENT_PUBLISHED: 'PUBLISH',
  ASSESSMENT_ASSIGNED: 'ASSIGN',
  /** Closing an assignment retires it without deleting it — the same shape as archiving. */
  ASSESSMENT_ASSIGNMENT_CLOSED: 'ARCHIVE',
  ASSESSMENT_SUBMITTED: 'SUBMIT',
  /** A reset restores a student's ability to sit the assessment again. */
  ASSESSMENT_ATTEMPT_RESET: 'RESTORE',
  // Recommendation + AI.
  RECOMMENDATIONS_GENERATED: 'CREATE',
  KNOWLEDGE_DOCUMENT_UPLOADED: 'CREATE',
  KNOWLEDGE_DOCUMENT_ARCHIVED: 'ARCHIVE',
  KNOWLEDGE_DOCUMENT_REPROCESSED: 'UPDATE',
  AI_POLICY_UPDATED: 'UPDATE',
  // Counselor management.
  COUNSELOR_CREATED: 'CREATE',
  COUNSELOR_UPDATED: 'UPDATE',
  COUNSELOR_DELETED: 'DELETE',
};

/** Every action in one group — what the filter turns into, resolved once per module load. */
const ACTIONS_BY_TYPE = new Map<AuditActionType, AuditAction[]>();

for (const [action, type] of Object.entries(ACTION_TYPES) as [AuditAction, AuditActionType][]) {
  ACTIONS_BY_TYPE.set(type, [...(ACTIONS_BY_TYPE.get(type) ?? []), action]);
}

export function actionsForType(type: AuditActionType): AuditAction[] {
  return ACTIONS_BY_TYPE.get(type) ?? [];
}

/** The group one action belongs to — for the row's badge, without a second round trip. */
export function actionTypeOf(action: string): AuditActionType {
  return ACTION_TYPES[action as AuditAction] ?? 'OTHER';
}

/**
 * Who acted. Four values, and `system` is a real one rather than an absence: `user_id IS NULL`
 * covers system actions *and* the failed joins where §38 deliberately never resolved a user, and an
 * operator filtering for those has no other way to ask.
 */
export const AUDIT_ACTORS = ['admin', 'counselor', 'student', 'system'] as const;
export type AuditActorFilter = (typeof AUDIT_ACTORS)[number];

export const AUDIT_SORTS = ['created_at', 'action', 'module'] as const;
export type AuditSort = (typeof AUDIT_SORTS)[number];

export interface AuditLogFilters {
  page: number;
  perPage: number;
  action?: string;
  /** A group (`DELETE`), expanded to its actions before it reaches SQL. */
  actionType?: AuditActionType;
  module?: string;
  userId?: string;
  /** The actor's role, or `system` for the rows with no resolved user. */
  actor?: AuditActorFilter;
  targetId?: string;
  /** Free text over the action, module, target id and the actor's name. */
  search?: string;
  /** ISO date bounds — string comparison is correct for ISO-8601 UTC timestamps (§12). */
  from?: string;
  to?: string;
  sort?: AuditSort;
  direction?: 'asc' | 'desc';
}

export interface AuditLogView {
  log: AuditLog;
  /** Resolved for display; NULL for system actions and unresolved join attempts. */
  userName: string | null;
  /** The actor's role, for the viewer's Actor column. NULL for the same rows `userName` is. */
  userRole: string | null;
}

export class AuditService {
  constructor(private readonly db: Database) {}

  /**
   * The §20 `GET /admin/audit-logs` read (Phase 6) — the viewer where the swallowed-exception
   * pattern (D18's lesson) and the §38 join-failure reasons finally become visible to an
   * operator. Read-only: `write()` below remains the only mutating method this service will
   * ever have.
   */
  async list(filters: AuditLogFilters): Promise<PaginatedData<AuditLogView>> {
    const where = this.conditions(filters);
    const ordering = this.ordering(filters);

    /**
     * **Both queries carry the same LEFT JOIN, and that is not waste.** The count has to see
     * exactly the rows the page does, and two of the filters (`actor`, and `search` when it matches
     * a person's name) are conditions on the joined `users` row. A count that skipped the join
     * would report a total for a different query — pagination that says "page 1 of 9" over a set
     * with three pages in it. LEFT, not INNER, so a row with no resolved user (a system action, a
     * failed join) stays in both.
     */
    const [rows, [total]] = await Promise.all([
      this.db
        .select({ log: auditLogs, userName: users.name, userRole: users.role })
        .from(auditLogs)
        .leftJoin(users, eq(auditLogs.userId, users.id))
        .where(where)
        .orderBy(...ordering)
        .limit(filters.perPage)
        .offset((filters.page - 1) * filters.perPage),
      this.db
        .select({ value: count() })
        .from(auditLogs)
        .leftJoin(users, eq(auditLogs.userId, users.id))
        .where(where),
    ]);

    return paginate(
      rows.map((row) => ({ log: row.log, userName: row.userName, userRole: row.userRole })),
      total?.value ?? 0,
      filters.page,
      filters.perPage,
    );
  }

  /**
   * The same filtered set, unpaginated and **hard-capped**, for the CSV export.
   *
   * The cap is the interesting part. This table has no retention policy (§13.8 — it grows without
   * bound), so an unbounded export is a request that eventually exhausts the Worker's memory and
   * fails at whatever size the log happens to have reached that week — the worst possible failure
   * mode, because it works in testing and stops working in production. A fixed ceiling turns that
   * into a *predictable* outcome the UI can state up front: the export says it was truncated, and
   * the operator narrows the date range, which is what they wanted to do anyway.
   */
  async export(
    filters: Omit<AuditLogFilters, 'page' | 'perPage'>,
    limit = AUDIT_EXPORT_LIMIT,
  ): Promise<{ rows: AuditLogView[]; truncated: boolean }> {
    const where = this.conditions(filters);

    // One row over the cap, so "there was more" is a fact rather than an inference from a full page.
    const rows = await this.db
      .select({ log: auditLogs, userName: users.name, userRole: users.role })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .where(where)
      .orderBy(...this.ordering(filters))
      .limit(limit + 1);

    return {
      rows: rows
        .slice(0, limit)
        .map((row) => ({ log: row.log, userName: row.userName, userRole: row.userRole })),
      truncated: rows.length > limit,
    };
  }

  /**
   * The vocabulary actually present in this deployment's log — what the two dropdowns offer.
   *
   * Distinct values from the table rather than the full `AuditAction` union, because a filter
   * listing forty actions that have never once occurred here is a filter an operator has to read
   * past. Both columns are indexed (0002, 0010), so each is a scan of an index rather than the
   * table, and the results are cached hard on the client — the set changes only when a new kind of
   * thing happens for the first time.
   */
  async filterOptions(): Promise<{ modules: string[]; actions: string[] }> {
    const [modules, actions] = await Promise.all([
      this.db
        .selectDistinct({ value: auditLogs.module })
        .from(auditLogs)
        .orderBy(asc(auditLogs.module)),
      this.db
        .selectDistinct({ value: auditLogs.action })
        .from(auditLogs)
        .orderBy(asc(auditLogs.action)),
    ]);

    return {
      modules: modules.map((row) => row.value),
      actions: actions.map((row) => row.value),
    };
  }

  /** Every filter, in one place, so the page query, the count and the export cannot diverge. */
  private conditions(filters: Omit<AuditLogFilters, 'page' | 'perPage'>): SQL | undefined {
    const conditions: SQL[] = [];

    if (filters.action !== undefined && filters.action !== '') {
      // Prefix match, so "STUDENT_CLASS_ACCESS" finds all three join outcomes at once.
      conditions.push(like(auditLogs.action, `${filters.action}%`));
    }

    /**
     * The group filter, expanded to its member actions. `IN (…)` over the indexed `action` column
     * rather than a pattern, which is what the exhaustive `ACTION_TYPES` record buys: the query
     * plan is a set of index seeks, and the set cannot drift from the vocabulary.
     */
    if (filters.actionType !== undefined) {
      const actions = actionsForType(filters.actionType);

      // `OTHER` has no members today (every action is classified). An empty `IN ()` is a syntax
      // error in SQLite, so the honest translation of "no action is in this group" is a false
      // predicate — an empty result — rather than a filter silently doing nothing.
      conditions.push(
        actions.length === 0 ? sql`1 = 0` : inArray(auditLogs.action, actions),
      );
    }

    if (filters.module !== undefined && filters.module !== '') {
      conditions.push(eq(auditLogs.module, filters.module));
    }

    if (filters.userId !== undefined) {
      conditions.push(eq(auditLogs.userId, filters.userId));
    }

    if (filters.actor !== undefined) {
      conditions.push(
        filters.actor === 'system' ? isNull(auditLogs.userId) : eq(users.role, filters.actor),
      );
    }

    if (filters.targetId !== undefined) {
      conditions.push(eq(auditLogs.targetId, filters.targetId));
    }

    const search = filters.search?.trim();

    if (search !== undefined && search !== '') {
      /**
       * Four columns, because those are the four things someone types into this box: an action they
       * half-remember, a module, a person, or an id they are chasing across the log. The actor's
       * *name* is deliberately in the set and is the reason the count query carries the join.
       */
      const term = `%${search}%`;
      const matches = or(
        like(auditLogs.action, term),
        like(auditLogs.module, term),
        like(auditLogs.targetId, term),
        like(users.name, term),
      );

      if (matches !== undefined) {
        conditions.push(matches);
      }
    }

    if (filters.from !== undefined) {
      conditions.push(gte(auditLogs.createdAt, filters.from));
    }

    if (filters.to !== undefined) {
      conditions.push(lte(auditLogs.createdAt, filters.to));
    }

    return conditions.length > 0 ? and(...conditions) : undefined;
  }

  /**
   * Sorting, always tie-broken by `created_at, id`.
   *
   * Without the tie-break, two rows written in the same millisecond — which happens constantly, a
   * bulk enrollment writes one audit row per act inside one request — can order differently between
   * page 1 and page 2, and a row then appears twice or not at all while an operator pages through.
   */
  private ordering(filters: Pick<AuditLogFilters, 'sort' | 'direction'>): SQL[] {
    const direction = filters.direction === 'asc' ? asc : desc;
    const newestFirst = [desc(auditLogs.createdAt), desc(auditLogs.id)];

    switch (filters.sort) {
      case 'action':
        return [direction(auditLogs.action), ...newestFirst];
      case 'module':
        return [direction(auditLogs.module), ...newestFirst];
      case 'created_at':
      default:
        return [direction(auditLogs.createdAt), direction(auditLogs.id)];
    }
  }

  async write(entry: AuditEntry): Promise<void> {
    await this.db.insert(auditLogs).values({
      id: uuid(),
      userId: entry.userId ?? null,
      action: entry.action,
      module: entry.module,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      oldValues: entry.oldValues ?? null,
      newValues: entry.newValues ?? null,
      ipAddress: entry.ipAddress ?? null,
      createdAt: now(),
    });
  }
}

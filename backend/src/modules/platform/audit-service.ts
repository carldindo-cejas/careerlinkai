import { and, count, desc, eq, gte, lte, like } from 'drizzle-orm';

import type { Database } from '@/db/client';
import { auditLogs, users, type AuditLog } from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { paginate, type PaginatedData } from '@/lib/envelope';

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
  | 'CAREER_CREATED'
  | 'CAREER_UPDATED'
  | 'CAREER_DELETED'
  // The mapping is scored, not decorative: linking or archiving a career shifts the §27
  // RIASEC average of every program it touches. These two are recorded for the same reason
  // a grade change is — someone will one day ask why a program's ranking moved.
  | 'PROGRAM_CAREER_LINKED'
  | 'PROGRAM_CAREER_UNLINKED'
  // Assessment (§13.4, §21, §25). `ASSESSMENT_PUBLISHED` is the one §13.8 names by example, and
  // it is the one that matters most: publishing is the irreversible act — the version freezes,
  // and every attempt taken against it forever after is scored by what was confirmed that day.
  // The audit row records how many mappings had been confirmed, so "who let this through the
  // gate" has an answer.
  | 'ASSESSMENT_TEMPLATE_CREATED'
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

export interface AuditLogFilters {
  page: number;
  perPage: number;
  action?: string;
  module?: string;
  userId?: string;
  targetId?: string;
  /** ISO date bounds — string comparison is correct for ISO-8601 UTC timestamps (§12). */
  from?: string;
  to?: string;
}

export interface AuditLogView {
  log: AuditLog;
  /** Resolved for display; NULL for system actions and unresolved join attempts. */
  userName: string | null;
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
    const conditions = [];

    if (filters.action !== undefined && filters.action !== '') {
      // Prefix match, so "STUDENT_CLASS_ACCESS" finds all three join outcomes at once.
      conditions.push(like(auditLogs.action, `${filters.action}%`));
    }

    if (filters.module !== undefined && filters.module !== '') {
      conditions.push(eq(auditLogs.module, filters.module));
    }

    if (filters.userId !== undefined) {
      conditions.push(eq(auditLogs.userId, filters.userId));
    }

    if (filters.targetId !== undefined) {
      conditions.push(eq(auditLogs.targetId, filters.targetId));
    }

    if (filters.from !== undefined) {
      conditions.push(gte(auditLogs.createdAt, filters.from));
    }

    if (filters.to !== undefined) {
      conditions.push(lte(auditLogs.createdAt, filters.to));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, [total]] = await Promise.all([
      this.db
        .select({ log: auditLogs, userName: users.name })
        .from(auditLogs)
        .leftJoin(users, eq(auditLogs.userId, users.id))
        .where(where)
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
        .limit(filters.perPage)
        .offset((filters.page - 1) * filters.perPage),
      this.db.select({ value: count() }).from(auditLogs).where(where),
    ]);

    return paginate(
      rows.map((row) => ({ log: row.log, userName: row.userName })),
      total?.value ?? 0,
      filters.page,
      filters.perPage,
    );
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

import type { Database } from '@/db/client';
import { auditLogs } from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';

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
  | 'AI_POLICY_UPDATED';

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

export class AuditService {
  constructor(private readonly db: Database) {}

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

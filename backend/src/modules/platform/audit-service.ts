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
  | 'STUDENT_CLASS_ACCESS_FAILED';

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

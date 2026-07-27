import type { AuditLog, Notification } from '@/db/schema';
import { actionTypeOf, type AuditActionType } from '@/modules/platform/audit-service';

/**
 * Response shaping for the Platform module (FULLPLAN §17) — allow-lists, never a
 * `delete row.x` on the way out.
 */

export interface SerializedNotification {
  id: string;
  title: string;
  message: string;
  category: string;
  read_at: string | null;
  created_at: string | null;
}

/**
 * `user_id` is deliberately absent: every notification endpoint means *mine*, so echoing
 * the recipient back would only ever restate the token — or leak, if a bug ever returned
 * someone else's row.
 */
export function serializeNotification(notification: Notification): SerializedNotification {
  return {
    id: notification.id,
    title: notification.title,
    message: notification.message,
    category: notification.category,
    read_at: notification.readAt,
    created_at: notification.createdAt,
  };
}

export interface SerializedAuditLog {
  id: string;
  user_id: string | null;
  user_name: string | null;
  /** The actor's role, for the Actor column. NULL for system actions and unresolved joins. */
  user_role: string | null;
  action: string;
  /**
   * The group the action belongs to (v1.6) — resolved server-side from the exhaustive
   * `ACTION_TYPES` record so the row's badge and the Action Type filter can never disagree. A
   * client deriving it from the action string would be a second, drifting copy of that map.
   */
  action_type: AuditActionType;
  module: string;
  target_type: string | null;
  target_id: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string | null;
}

/**
 * The admin viewer's row (§13.8). This is the one serializer in the system that ships
 * `old_values`/`new_values` verbatim — the audit trail's whole purpose is that the operator
 * sees what the API refused to tell the caller (§38's join-failure reasons live here).
 */
export function serializeAuditLog(
  log: AuditLog,
  userName: string | null = null,
  userRole: string | null = null,
): SerializedAuditLog {
  return {
    id: log.id,
    user_id: log.userId,
    user_name: userName,
    user_role: userRole,
    action: log.action,
    action_type: actionTypeOf(log.action),
    module: log.module,
    target_type: log.targetType,
    target_id: log.targetId,
    old_values: log.oldValues,
    new_values: log.newValues,
    ip_address: log.ipAddress,
    created_at: log.createdAt,
  };
}

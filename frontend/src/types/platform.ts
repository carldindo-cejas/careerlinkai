import type { Paginated } from '@/types/class';
import type { CareerRecommendation, ProgramRecommendation } from '@/types/recommendation';
import type { User } from '@/types/user';

/**
 * Platform module types (FULLPLAN §13.8, §20 — Phase 6): notifications, the audit trail,
 * the role dashboards, and counselor management. Mirrors of the backend serializers —
 * keep in lockstep.
 */

export type NotificationCategory = 'ASSESSMENT' | 'RECOMMENDATION' | 'CLASS' | 'ACCOUNT';

export interface AppNotification {
  id: string;
  title: string;
  message: string;
  category: NotificationCategory;
  /** NULL = unread (§13.8). */
  read_at: string | null;
  created_at: string | null;
}

export interface NotificationList extends Paginated<AppNotification> {
  unread_count: number;
}

/**
 * The action **groups** the viewer filters by (v1.6).
 *
 * Resolved on the server from an exhaustive `Record<AuditAction, …>`, and shipped on every row as
 * `action_type`. This list is only the filter dropdown's vocabulary — the classification itself is
 * deliberately not duplicated here, because a second copy of that map is a second copy that drifts.
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

/** `system` is a real value: the rows §38 deliberately never resolves a user for. */
export const AUDIT_ACTORS = ['admin', 'counselor', 'student', 'system'] as const;
export type AuditActor = (typeof AUDIT_ACTORS)[number];

export type AuditSort = 'created_at' | 'action' | 'module';

export interface AuditLogEntry {
  id: string;
  user_id: string | null;
  /** Resolved for display; null for system actions and unresolved join attempts. */
  user_name: string | null;
  user_role: string | null;
  action: string;
  action_type: AuditActionType;
  module: string;
  target_type: string | null;
  target_id: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string | null;
}

export interface AuditLogFilters {
  page?: number | undefined;
  per_page?: number | undefined;
  action?: string | undefined;
  action_type?: AuditActionType | undefined;
  module?: string | undefined;
  user_id?: string | undefined;
  actor?: AuditActor | undefined;
  target_id?: string | undefined;
  search?: string | undefined;
  /** `YYYY-MM-DD` is accepted and snapped to the right edge of the day server-side. */
  from?: string | undefined;
  to?: string | undefined;
  sort?: AuditSort | undefined;
  direction?: 'asc' | 'desc' | undefined;
}

/** The vocabulary this deployment has actually recorded — what the two dropdowns offer. */
export interface AuditFilterOptions {
  modules: string[];
  actions: string[];
  action_types: AuditActionType[];
  actors: AuditActor[];
}

// --- Dashboards (§54, pulled live) -------------------------------------------------------

export interface AdminDashboard {
  totals: {
    students: number;
    counselors: number;
    classes: number;
    colleges: number;
    programs: number;
    careers: number;
    knowledge_documents: number;
  };
  assessments: {
    published_versions: number;
    attempts_in_progress: number;
    attempts_scored: number;
    /** Percent, one decimal; null while nothing has been started. */
    completion_rate: number | null;
  };
  student_access_7d: {
    success: number;
    failed: number;
    throttled: number;
  };
  ai_7d: {
    requests: number;
    failed: number;
    tokens_used: number;
    avg_latency_ms: number | null;
  };
  recent_activity: AuditLogEntry[];
}

export interface CounselorDashboardClassRow {
  id: string;
  name: string;
  students_count: number;
  active_assignments: number;
  scored_attempts: number;
}

export interface CounselorDashboard {
  totals: {
    classes: number;
    students: number;
    active_assignments: number;
  };
  attempts: {
    in_progress: number;
    scored: number;
  };
  students_with_recommendations: number;
  classes: CounselorDashboardClassRow[];
}

export interface StudentDashboard {
  assignments: {
    active: number;
    completed: number;
    pending: number;
  };
  results_count: number;
  recommendations_ready: boolean;
  unread_notifications: number;
  profile_complete: boolean;
}

// --- Counselor management (§20, admin) ----------------------------------------------------

export interface ManagedCounselor extends User {
  classes_count: number;
  students_count: number;
}

/** The creation response — the only place a plaintext credential ever appears, once. */
export interface CreatedCounselor extends ManagedCounselor {
  temporary_password: string;
}

export interface CreateCounselorPayload {
  email: string;
  first_name: string;
  last_name: string;
  phone?: string | null;
  employee_number?: string | null;
  specialization?: string | null;
}

export interface UpdateCounselorPayload {
  name?: string;
  status?: 'active' | 'inactive' | 'suspended';
  first_name?: string;
  last_name?: string;
  phone?: string | null;
  employee_number?: string | null;
  specialization?: string | null;
  bio?: string | null;
}

// --- Counselor detail: the assigned-students view (prompt-driven, admin) ------------------

/**
 * One row of the counselor detail page. The top career/program are `top_careers[0]` /
 * `top_programs[0]` (the table shows them by default); the rest fill the expand-to-top-five section.
 * A recommended college is `top_programs[i].college` — a join, resolved server-side (§13.6).
 */
export interface CounselorStudentRow {
  id: string;
  name: string;
  grade_level: string | null;
  strand: string | null;
  /** Latest SCORED RIASEC Holland Code, e.g. "IAS". Null until the student has scored one. */
  holland_code: string | null;
  top_careers: CareerRecommendation[];
  top_programs: ProgramRecommendation[];
}

export interface CounselorStudents {
  counselor: {
    id: string;
    name: string;
    email: string | null;
    specialization: string | null;
  };
  students: CounselorStudentRow[];
}

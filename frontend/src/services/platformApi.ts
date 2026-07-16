import { httpClient, unwrap } from '@/services/httpClient';
import type { ApiSuccess } from '@/types/api';
import type { Paginated } from '@/types/class';
import type {
  AdminDashboard,
  AuditLogEntry,
  AuditLogFilters,
  CounselorDashboard,
  StudentDashboard,
} from '@/types/platform';

/**
 * The Platform module's read surface (FULLPLAN §20 — Phase 6): the admin audit-log viewer
 * and the three role dashboards, each pulled live from the domain tables (§54).
 */
export const platformApi = {
  auditLogs(filters: AuditLogFilters = {}): Promise<Paginated<AuditLogEntry>> {
    return unwrap(
      httpClient.get<ApiSuccess<Paginated<AuditLogEntry>>>('/admin/audit-logs', {
        params: filters,
      }),
    );
  },

  adminDashboard(): Promise<AdminDashboard> {
    return unwrap(httpClient.get<ApiSuccess<AdminDashboard>>('/admin/dashboard'));
  },

  counselorDashboard(): Promise<CounselorDashboard> {
    return unwrap(httpClient.get<ApiSuccess<CounselorDashboard>>('/counselor/dashboard'));
  },

  studentDashboard(): Promise<StudentDashboard> {
    return unwrap(httpClient.get<ApiSuccess<StudentDashboard>>('/student/dashboard'));
  },
};

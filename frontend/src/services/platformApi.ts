import { httpClient, unwrap } from '@/services/httpClient';
import type { ApiSuccess } from '@/types/api';
import type { Paginated } from '@/types/class';
import type {
  AdminDashboard,
  AuditFilterOptions,
  AuditLogEntry,
  AuditLogFilters,
  CounselorDashboard,
  StudentDashboard,
} from '@/types/platform';

/**
 * The Platform module's read surface (FULLPLAN §20 — Phase 6): the admin audit-log viewer
 * and the three role dashboards, each pulled live from the domain tables (§54).
 */
/** Strip `undefined` so the URL stays clean and the TanStack Query key stays stable. */
function auditParams(filters: AuditLogFilters): Record<string, string | number> {
  const params: Record<string, string | number> = {};

  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') {
      params[key] = value as string | number;
    }
  }

  return params;
}

export const platformApi = {
  auditLogs(filters: AuditLogFilters = {}): Promise<Paginated<AuditLogEntry>> {
    return unwrap(
      httpClient.get<ApiSuccess<Paginated<AuditLogEntry>>>('/admin/audit-logs', {
        params: auditParams(filters),
      }),
    );
  },

  auditFilterOptions(): Promise<AuditFilterOptions> {
    return unwrap(
      httpClient.get<ApiSuccess<AuditFilterOptions>>('/admin/audit-logs/filter-options'),
    );
  },

  /**
   * The filtered set as CSV, downloaded through the same authenticated client as everything else.
   *
   * A plain `<a href>` would not carry the bearer token — the API has no cookie session — so the
   * file is fetched as a blob and handed to the browser from memory. `page`/`per_page` are
   * deliberately dropped: the export is "everything matching what I am looking at", not the page.
   */
  async exportAuditLogs(filters: AuditLogFilters = {}): Promise<{
    blob: Blob;
    filename: string;
    truncated: boolean;
    rowCount: number;
  }> {
    const { page, per_page, ...rest } = filters;
    void page;
    void per_page;

    const response = await httpClient.get<Blob>('/admin/audit-logs/export', {
      params: auditParams(rest),
      responseType: 'blob',
    });

    const disposition = String(response.headers['content-disposition'] ?? '');
    const match = /filename="([^"]+)"/.exec(disposition);

    return {
      blob: response.data,
      filename: match?.[1] ?? 'audit-log.csv',
      truncated: String(response.headers['x-export-truncated']) === 'true',
      rowCount: Number(response.headers['x-export-row-count'] ?? 0),
    };
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

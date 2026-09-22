import { httpClient, unwrap } from '@/services/httpClient';
import type { ApiSuccess } from '@/types/api';
import type { Paginated } from '@/types/class';
import type { ScoringFormula, ScoringFormulaResponse } from '@/types/formula';
import type {
  PreviewInput,
  PreviewResult,
  RecommendationFreshness,
  RecomputePage,
} from '@/types/matching';
import type {
  AdminDashboard,
  AuditFilterOptions,
  AuditLogEntry,
  AuditLogFilters,
  CounselorDashboard,
  PlatformUsage,
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

  /** What this deployment is spending of the Cloudflare free plan, and what it cannot see. */
  platformUsage(): Promise<PlatformUsage> {
    return unwrap(httpClient.get<ApiSuccess<PlatformUsage>>('/admin/platform-usage'));
  },

  /** The operator flags (migration 0034) — today, whether counselors may register themselves. */
  settings(): Promise<AppSettings> {
    return unwrap(httpClient.get<ApiSuccess<AppSettings>>('/admin/settings'));
  },

  /**
   * Change one or more flags. Partial by design: a client that had to send every flag to change one
   * would silently revert any flag it did not know about yet.
   */
  updateSettings(payload: Partial<AppSettings>): Promise<AppSettings> {
    return unwrap(httpClient.patch<ApiSuccess<AppSettings>>('/admin/settings', payload));
  },
};

/** Mirrors the server's `APP_SETTINGS` registry. One flag today; the shape is built to grow. */
export interface AppSettings {
  counselor_signup_enabled: boolean;
}

/**
 * The §27 match formula (2026-09-21) — admin-only, like the flags above it.
 *
 * It lives on this client rather than on `recommendationApi` because it is an *operator*
 * configuration: the caller is the administration section of the admin shell, not the
 * recommendation screens a student reads. The endpoints are served by the Recommendation module,
 * which owns the arithmetic they configure.
 */
export const formulaApi = {
  get(): Promise<ScoringFormulaResponse> {
    return unwrap(
      httpClient.get<ApiSuccess<ScoringFormulaResponse>>('/admin/recommendation-formula'),
    );
  },

  /**
   * Replace it, whole.
   *
   * `PUT`, not `PATCH`, and that follows from the data rather than from taste: the weights in a
   * composite are not independent, and a request that changed one of them would leave the set
   * summing to something other than 1 — which silently rescales every score in the system.
   */
  save(formula: ScoringFormula, currentPassword: string): Promise<ScoringFormula> {
    return unwrap(
      httpClient.put<ApiSuccess<ScoringFormula>>('/admin/recommendation-formula', {
        ...formula,
        current_password: currentPassword,
      }),
    );
  },

  reset(currentPassword: string): Promise<ScoringFormula> {
    return unwrap(
      httpClient.post<ApiSuccess<ScoringFormula>>('/admin/recommendation-formula/reset', {
        current_password: currentPassword,
      }),
    );
  },
};

/**
 * Keeping recommendation sets current (backend 2026-09-22) — the admin Matching page.
 *
 * `recompute` handles one small page per call (the Worker's Free-plan subrequest budget allows about
 * three students a request); the page's hook calls it again until nothing is left.
 */
export const matchingApi = {
  freshness(): Promise<RecommendationFreshness> {
    return unwrap(
      httpClient.get<ApiSuccess<RecommendationFreshness>>('/admin/recommendations/freshness'),
    );
  },

  recompute(): Promise<RecomputePage> {
    return unwrap(httpClient.post<ApiSuccess<RecomputePage>>('/admin/recommendations/recompute', {}));
  },

  preview(input: PreviewInput): Promise<PreviewResult> {
    return unwrap(
      httpClient.post<ApiSuccess<PreviewResult>>('/admin/recommendations/preview', input),
    );
  },
};

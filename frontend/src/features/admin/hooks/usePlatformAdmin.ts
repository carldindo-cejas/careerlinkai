import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { counselorManagementApi } from '@/services/counselorManagementApi';
import { platformApi } from '@/services/platformApi';
import type {
  AuditLogFilters,
  CreateCounselorPayload,
  UpdateCounselorPayload,
} from '@/types/platform';

/**
 * Phase 6 admin hooks (FULLPLAN §36): the live dashboard, the audit-log viewer, and
 * counselor management. Components call these; these call the service modules.
 */

export const platformAdminKeys = {
  dashboard: ['admin', 'dashboard'] as const,
  auditLogs: (filters: AuditLogFilters) => ['admin', 'audit-logs', filters] as const,
  auditFilterOptions: ['admin', 'audit-logs', 'filter-options'] as const,
  counselors: (params: Record<string, unknown>) => ['admin', 'counselors', params] as const,
  counselorStudents: (id: string) => ['admin', 'counselors', id, 'students'] as const,
};

export function useAdminDashboard() {
  return useQuery({
    queryKey: platformAdminKeys.dashboard,
    queryFn: () => platformApi.adminDashboard(),
  });
}

export function useAuditLogs(filters: AuditLogFilters) {
  return useQuery({
    queryKey: platformAdminKeys.auditLogs(filters),
    queryFn: () => platformApi.auditLogs(filters),
    // Keep the previous page on screen while the next one loads — paging a table that
    // blanks out on every click reads as flicker, not progress.
    placeholderData: (previous) => previous,
  });
}

/**
 * The filter dropdowns' vocabulary — the modules and actions this deployment has actually recorded.
 *
 * Cached hard: the set changes only when a kind of action happens for the *first* time, and
 * re-fetching it alongside every page of rows would be two `DISTINCT` scans per keystroke in the
 * search box.
 */
export function useAuditFilterOptions() {
  return useQuery({
    queryKey: platformAdminKeys.auditFilterOptions,
    queryFn: () => platformApi.auditFilterOptions(),
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Export the filtered set as CSV.
 *
 * A mutation rather than a query because it is an *act* with a side effect — a file lands in the
 * user's downloads — and firing that from a cache-managed query would mean a refocus could
 * re-download it. The blob is fetched through the authenticated client (a plain `<a href>` carries
 * no bearer token) and handed to the browser via an object URL, revoked immediately after.
 */
export function useExportAuditLogs() {
  return useMutation({
    mutationFn: async (filters: AuditLogFilters) => {
      const { blob, filename, truncated, rowCount } = await platformApi.exportAuditLogs(filters);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');

      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      return { truncated, rowCount };
    },
  });
}

export function useCounselors(params: { page?: number; search?: string; status?: string }) {
  return useQuery({
    queryKey: platformAdminKeys.counselors(params),
    queryFn: () => counselorManagementApi.list(params),
    placeholderData: (previous) => previous,
  });
}

/** One counselor's assigned students, with their Holland Code and top recommendations (§20). */
export function useCounselorStudents(id: string) {
  return useQuery({
    queryKey: platformAdminKeys.counselorStudents(id),
    queryFn: () => counselorManagementApi.students(id),
    enabled: id !== '',
  });
}

function useInvalidateCounselors() {
  const queryClient = useQueryClient();

  return () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'counselors'] });
    void queryClient.invalidateQueries({ queryKey: platformAdminKeys.dashboard });
  };
}

export function useCreateCounselor() {
  const invalidate = useInvalidateCounselors();

  return useMutation({
    mutationFn: (payload: CreateCounselorPayload) => counselorManagementApi.create(payload),
    onSuccess: invalidate,
  });
}

export function useUpdateCounselor() {
  const invalidate = useInvalidateCounselors();

  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateCounselorPayload }) =>
      counselorManagementApi.update(id, payload),
    onSuccess: invalidate,
  });
}

export function useDeleteCounselor() {
  const invalidate = useInvalidateCounselors();

  return useMutation({
    mutationFn: (id: string) => counselorManagementApi.remove(id),
    onSuccess: invalidate,
  });
}

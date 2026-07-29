import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { classApi } from '@/services/classApi';
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
  counselorClasses: (id: string) => ['admin', 'counselors', id, 'classes'] as const,
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

/**
 * `enabled` follows the P2-1 / P3-2 pattern: a picker that fetches on **open** rather than on
 * mount, so a screen holding several of them costs one request per picker a user actually used.
 */
export function useCounselors(
  params: { page?: number; search?: string; status?: string },
  enabled = true,
) {
  return useQuery({
    queryKey: platformAdminKeys.counselors(params),
    queryFn: () => counselorManagementApi.list(params),
    placeholderData: (previous) => previous,
    enabled,
  });
}

/**
 * One counselor's live classes (audit F5, plan P3-6) — the list the reassignment panel works
 * through, and the same set whose non-emptiness refuses `DELETE /admin/counselors/{id}`.
 */
export function useCounselorClasses(counselorId: string) {
  return useQuery({
    queryKey: platformAdminKeys.counselorClasses(counselorId),
    queryFn: () => classApi.listForCounselor(counselorId),
    enabled: counselorId !== '',
  });
}

/**
 * Hand one class to another counselor.
 *
 * Invalidates the counselor **list** as well as the two class queries: `classes_count` is rendered
 * on every row of it, and it is the number the deletion guard refuses on — a stale one would tell
 * an admin the class had not moved and then refuse the removal for a class that is no longer there.
 */
export function useReassignClass(fromCounselorId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ classId, counselorId }: { classId: string; counselorId: string }) =>
      classApi.reassign(classId, counselorId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: platformAdminKeys.counselorClasses(fromCounselorId),
      });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'counselors'] });
      void queryClient.invalidateQueries({ queryKey: ['classes'] });
    },
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

/**
 * Issue a counselor a fresh temporary password (audit C2).
 *
 * Invalidated like the other three because the reset flips `must_change_password` back on, and the
 * list renders account state — leaving it stale would show an account as settled while it is
 * waiting on a rotation.
 */
export function useResetCounselorPassword() {
  const invalidate = useInvalidateCounselors();

  return useMutation({
    mutationFn: (id: string) => counselorManagementApi.resetPassword(id),
    onSuccess: invalidate,
  });
}

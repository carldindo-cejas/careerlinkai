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
  counselors: (params: Record<string, unknown>) => ['admin', 'counselors', params] as const,
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

export function useCounselors(params: { page?: number; search?: string; status?: string }) {
  return useQuery({
    queryKey: platformAdminKeys.counselors(params),
    queryFn: () => counselorManagementApi.list(params),
    placeholderData: (previous) => previous,
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

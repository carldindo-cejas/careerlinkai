import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { rosterApi } from '@/services/rosterApi';
import type { ConfirmedStudent } from '@/types/class';

/**
 * Roster hooks (FULLPLAN §36, §57).
 *
 * Preview is a mutation rather than a query on purpose: it is an action the counselor
 * takes, not state to be cached and refetched. Its result is a proposal that lives in the
 * roster-builder's own state until it is confirmed or thrown away.
 */

export const rosterKeys = {
  forClass: (classId: string) => ['classes', classId, 'roster'] as const,
};

export function useRoster(classId: string) {
  return useQuery({
    queryKey: rosterKeys.forClass(classId),
    queryFn: () => rosterApi.list(classId),
  });
}

export function usePreviewRoster(classId: string) {
  return useMutation({
    mutationFn: (names: string[]) => rosterApi.preview(classId, names),
  });
}

export function useConfirmRoster(classId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (students: ConfirmedStudent[]) => rosterApi.confirm(classId, students),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: rosterKeys.forClass(classId) });
    },
  });
}

/** Takes the student's *user* id, not their enrollment id (§20). */
export function useRemoveStudent(classId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (studentId: string) => rosterApi.remove(classId, studentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: rosterKeys.forClass(classId) });
    },
  });
}

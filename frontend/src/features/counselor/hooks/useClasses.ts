import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { classApi } from '@/services/classApi';
import type { CreateClassPayload, UpdateClassPayload } from '@/types/class';

/**
 * Class hooks (FULLPLAN §36). Components call these; these call services/classApi.
 */

export const classKeys = {
  all: ['classes'] as const,
  detail: (id: string) => ['classes', id] as const,
};

export function useClasses() {
  return useQuery({
    queryKey: classKeys.all,
    queryFn: () => classApi.list(),
  });
}

export function useClass(id: string) {
  return useQuery({
    queryKey: classKeys.detail(id),
    queryFn: () => classApi.get(id),
  });
}

/**
 * The created class comes back with its join code already on it — the counselor can read
 * the code out to the class before a single student exists (§57).
 */
export function useCreateClass() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: CreateClassPayload) => classApi.create(payload),
    onSuccess: (created) => {
      queryClient.setQueryData(classKeys.detail(created.id), created);
      void queryClient.invalidateQueries({ queryKey: classKeys.all });
    },
  });
}

export function useUpdateClass(id: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: UpdateClassPayload) => classApi.update(id, payload),
    onSuccess: (updated) => {
      queryClient.setQueryData(classKeys.detail(id), updated);
      void queryClient.invalidateQueries({ queryKey: classKeys.all });
    },
  });
}

export function useDeleteClass() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => classApi.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: classKeys.all });
    },
  });
}

/**
 * Rotating the code revokes the old one immediately (§38), so the cached class must be
 * replaced rather than left to go stale — a counselor reading a dead code out to a room
 * is the exact failure this screen exists to prevent.
 */
export function useRegenerateCode(id: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => classApi.regenerateCode(id),
    onSuccess: (updated) => {
      queryClient.setQueryData(classKeys.detail(id), updated);
      void queryClient.invalidateQueries({ queryKey: classKeys.all });
    },
  });
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { notificationApi } from '@/services/notificationApi';

/**
 * Notification hooks (FULLPLAN §36, §44 — Phase 6). Shared by all three shells: the same
 * bell serves a student, a counselor and an admin, because the endpoints already scope
 * everything to the token.
 */

export const notificationKeys = {
  list: ['notifications'] as const,
};

export function useNotifications(enabled = true) {
  return useQuery({
    queryKey: notificationKeys.list,
    queryFn: () => notificationApi.list(),
    enabled,
    // The only push channel v1 has is polling (§44 — in-app only). A minute is fresh
    // enough for "your results are ready" and costs ~1 request/min against a 100k/day
    // account-wide quota (§45).
    refetchInterval: 60_000,
  });
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => notificationApi.markRead(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: notificationKeys.list });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => notificationApi.markAllRead(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: notificationKeys.list });
    },
  });
}

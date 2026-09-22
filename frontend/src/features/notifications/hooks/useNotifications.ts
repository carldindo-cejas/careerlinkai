import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

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
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: notificationKeys.list,
    queryFn: () => notificationApi.list(),
    enabled,
    // The only push channel v1 has is polling (§44 — in-app only). A minute is fresh
    // enough for "your results are ready" and costs ~1 request/min against a 100k/day
    // account-wide quota (§45).
    refetchInterval: 60_000,
  });

  /*
    Keep the admin's counselor list in step with the account notifications that describe it
    (migration 0039). The list is cached for a minute and does not refetch on focus, so without
    this an administrator could read "Maria now signs in as …" in the bell and then open a list
    still showing her old address. The poll above is the one signal that something about an
    account changed, so the newest ACCOUNT notification is what marks the list stale.
    Invalidating an unmounted query only flags it, so for a counselor or student this costs
    nothing: they never load the list.
  */
  const newestAccountNotice = query.data?.items.find((item) => item.category === 'ACCOUNT')?.id;

  useEffect(() => {
    if (newestAccountNotice !== undefined) {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'counselors'] });
    }
  }, [newestAccountNotice, queryClient]);

  return query;
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

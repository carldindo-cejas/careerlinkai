import { useMutation, useQueryClient } from '@tanstack/react-query';

import { CURRENT_USER_QUERY_KEY } from '@/features/auth/hooks/useAuth';
import {
  accountApi,
  type ChangeEmailPayload,
  type UpdateAccountPayload,
} from '@/services/accountApi';
import { useAuthStore } from '@/stores/authStore';

/**
 * Editing your own account (`/counselor/profile`, 2026-09-20).
 *
 * Kept out of `features/auth/hooks/useAuth.ts` for the reason `services/accountApi.ts` explains:
 * `useAuth` is in every shell's static closure because `AppShell` signs people out, and the
 * student route has 560 KiB to spend. Only `CounselorProfilePage` imports this file.
 */

/**
 * Edit your own name (and, for a counselor, the profile fields beside it).
 *
 * The server answers with the whole updated user, so both the Zustand store and the `/auth/me`
 * cache are written from the response rather than invalidated. That matters here more than it
 * usually would: the name being edited is rendered in the sidebar, the top bar and the breadcrumb
 * of the very screen holding the form, and a refetch would leave all three showing the old name
 * for as long as the round trip takes.
 */
export function useUpdateAccount() {
  const queryClient = useQueryClient();
  const setUser = useAuthStore((state) => state.setUser);

  return useMutation({
    mutationFn: (payload: UpdateAccountPayload) => accountApi.updateAccount(payload),
    onSuccess: (user) => {
      setUser(user);
      queryClient.setQueryData(CURRENT_USER_QUERY_KEY, user);
    },
  });
}

/**
 * Change the address you sign in with.
 *
 * Unlike `useChangePassword`, this deliberately does **not** sign the caller out: the server
 * revokes nothing, because they proved their current password in the same request and the token
 * they hold is no less trustworthy than it was a moment ago.
 */
export function useChangeEmail() {
  const queryClient = useQueryClient();
  const setUser = useAuthStore((state) => state.setUser);

  return useMutation({
    mutationFn: (payload: ChangeEmailPayload) => accountApi.changeEmail(payload),
    onSuccess: (user) => {
      setUser(user);
      queryClient.setQueryData(CURRENT_USER_QUERY_KEY, user);
    },
  });
}

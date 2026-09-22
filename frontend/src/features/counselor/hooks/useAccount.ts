import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { CURRENT_USER_QUERY_KEY } from '@/features/auth/hooks/useAuth';
import {
  accountApi,
  type ChangeEmailPayload,
  type PendingEmailChange,
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

/** The staged change, if there is one. Cached under its own key so every step can write it. */
export const PENDING_EMAIL_CHANGE_QUERY_KEY = ['auth', 'change-email'] as const;

/**
 * Changing the address you sign in with, in two steps (migration 0039).
 *
 * The hooks below are deliberately four small ones rather than one that hides a state machine.
 * Each maps to exactly one endpoint, and the page owns the sequencing — which is the honest
 * arrangement when the middle of that sequence is a thing the *user* has to do (open a mailbox)
 * rather than a thing the client is waiting on.
 *
 * What they share is the cache entry: `PENDING_EMAIL_CHANGE_QUERY_KEY` holds the staged change,
 * and every hook that stages, re-stages or ends one writes it from its own response rather than
 * invalidating. The alternative would leave the code card rendering from a stale `null` for the
 * length of a round trip, on a screen whose whole job at that moment is to say what is pending.
 */

/**
 * Step one: ask, and a code goes to the new address.
 *
 * Deliberately does **not** touch the session. Nothing about the account has changed yet, and
 * writing the requested address into the store would show a counselor an email they cannot sign
 * in with — see `accountApi.requestEmailChange`.
 */
export function useRequestEmailChange() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: ChangeEmailPayload) => accountApi.requestEmailChange(payload),
    onSuccess: (pending) => {
      queryClient.setQueryData<PendingEmailChange | null>(
        PENDING_EMAIL_CHANGE_QUERY_KEY,
        pending,
      );
    },
  });
}

/**
 * What is waiting on a code, asked on mount.
 *
 * This is the hook that makes the flow survive the thing it is guaranteed to meet: the code
 * arrives in a mail app, often on a phone while the form is on a lab desktop, and the tab gets
 * reloaded on the way back. Without it the page would forget a live change and offer to start a
 * second one.
 *
 * `staleTime: 0` and no refetch on focus: coming back to the tab is exactly when this must be
 * re-read, because the change may have been completed or abandoned in another one.
 */
export function usePendingEmailChange(enabled = true) {
  return useQuery({
    queryKey: PENDING_EMAIL_CHANGE_QUERY_KEY,
    queryFn: () => accountApi.pendingEmailChange(),
    enabled,
    staleTime: 0,
  });
}

/** A new code to the address already staged — the destination cannot change here. */
export function useResendEmailChangeCode() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => accountApi.resendEmailChangeCode(),
    onSuccess: (pending) => {
      queryClient.setQueryData<PendingEmailChange | null>(
        PENDING_EMAIL_CHANGE_QUERY_KEY,
        pending,
      );
    },
  });
}

/** Abandon the staged change. Idempotent on the server, so this never needs a confirmation. */
export function useCancelEmailChange() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => accountApi.cancelEmailChange(),
    onSuccess: () => {
      queryClient.setQueryData<PendingEmailChange | null>(PENDING_EMAIL_CHANGE_QUERY_KEY, null);
    },
  });
}

/**
 * Step two: spend the code, and the address moves.
 *
 * This is where the session is written, and only here — the server has answered with the updated
 * user, so the store and the `/auth/me` cache are filled from the response rather than
 * invalidated. That matters on this screen: the address is rendered in the card above the form
 * that submitted it, and a refetch would leave the old one on display for the round trip.
 *
 * Unlike `useChangePassword` it does **not** end the session: nothing the caller holds became less
 * trustworthy — they proved their password at step one and their mailbox here.
 */
export function useVerifyEmailChange() {
  const queryClient = useQueryClient();
  const setUser = useAuthStore((state) => state.setUser);

  return useMutation({
    mutationFn: (code: string) => accountApi.verifyEmailChange(code),
    onSuccess: (user) => {
      setUser(user);
      queryClient.setQueryData(CURRENT_USER_QUERY_KEY, user);
      queryClient.setQueryData<PendingEmailChange | null>(PENDING_EMAIL_CHANGE_QUERY_KEY, null);
    },
  });
}

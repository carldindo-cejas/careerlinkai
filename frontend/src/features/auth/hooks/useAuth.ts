import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  authApi,
  type ChangePasswordPayload,
  type CounselorSignupPayload,
  type LoginPayload,
} from '@/services/authApi';
import { useAuthStore } from '@/stores/authStore';
import { ApiRequestError } from '@/types/api';
import type { User, UserRole } from '@/types/user';

/**
 * Auth hooks (FULLPLAN §36).
 *
 * Components call these; these call services/authApi. No component talks to the API
 * directly.
 */

export const CURRENT_USER_QUERY_KEY = ['auth', 'me'] as const;

/**
 * The authenticated user, resolved from the token.
 *
 * /auth/me is the source of truth: the token is persisted across reloads but the user
 * object is not, so the session is always re-verified against the server rather than
 * trusted from local storage.
 *
 * **This query decides whether a student is in the app**, which is why it no longer sets
 * `retry: false`. It inherits the global policy instead (see `createQueryClient`): a 4xx is
 * final — a 401 has already cleared the token by the time it gets here — while a 5xx, a 429 or a
 * connection that dropped on school wifi is retried with backoff. Under the old setting one
 * failed request was indistinguishable from a rejected token, and `ProtectedRoute` turned it into
 * a sign-out; during the 18 September 2026 incident that is what made a transient failure look
 * like being thrown out of the system.
 */
export function useCurrentUser() {
  const token = useAuthStore((state) => state.token);

  return useQuery<User>({
    queryKey: CURRENT_USER_QUERY_KEY,
    queryFn: () => authApi.me(),
    enabled: token !== null,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    staleTime: 5 * 60 * 1000,
  });
}

export interface LoginOptions {
  /**
   * Roles this login screen accepts. The server authenticates any staff account against
   * /auth/login; the *screen* decides who it is for — /login is the counselor door and
   * /admin-login the administrator's, and neither lets the other role through (§38).
   */
  allow: UserRole[];
  /** Shown when valid credentials belong to a role this screen does not serve. */
  refusalMessage: string;
}

export function useLogin(options?: LoginOptions) {
  const queryClient = useQueryClient();
  const setToken = useAuthStore((state) => state.setToken);
  const setUser = useAuthStore((state) => state.setUser);

  return useMutation({
    mutationFn: async (payload: LoginPayload) => {
      const result = await authApi.login(payload);

      if (options && !options.allow.includes(result.user.role)) {
        // Right credentials, wrong door. Revoke the token we were just issued — it must
        // not survive a sign-in the UI refused — then surface the refusal like any other
        // login failure. Best-effort: a failed revocation still leaves nothing stored.
        await authApi.revoke(result.token).catch(() => undefined);
        throw new ApiRequestError(options.refusalMessage, 403);
      }

      return result;
    },
    onSuccess: ({ user, token }) => {
      setToken(token);
      setUser(user);
      queryClient.setQueryData(CURRENT_USER_QUERY_KEY, user);
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  const clear = useAuthStore((state) => state.clear);

  return useMutation({
    mutationFn: () => authApi.logout(),
    // Clear locally even if the request fails: the user asked to be signed out, and a
    // failed revocation must not strand them in an authenticated-looking UI.
    onSettled: () => {
      clear();
      queryClient.clear();
    },
  });
}

/**
 * Changing a password revokes every token server-side (§38), so the client must sign
 * out and re-authenticate afterwards.
 */
export function useChangePassword() {
  const queryClient = useQueryClient();
  const clear = useAuthStore((state) => state.clear);

  return useMutation({
    mutationFn: (payload: ChangePasswordPayload) => authApi.changePassword(payload),
    onSuccess: () => {
      clear();
      queryClient.clear();
    },
  });
}

// --- Counselor self-signup (migration 0034) -------------------------------------------

export const SIGNUP_STATUS_QUERY_KEY = ['auth', 'signup-status'] as const;

/**
 * Whether counselor registration is currently open.
 *
 * Unauthenticated, so it sits outside every other key in this file's namespace-by-session
 * assumption — and it is **not** cached for long: an administrator closing registration is
 * something a sign-in screen left open in a browser tab should notice, and the query is one cheap
 * D1 read. `enabled` exists because the administrator door renders this form too and must never
 * ask the question, let alone offer the answer.
 */
export function useSignupStatus({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: SIGNUP_STATUS_QUERY_KEY,
    queryFn: () => authApi.signupStatus(),
    enabled,
    staleTime: 30 * 1000,
    // A failed status check renders no link and no error. The server refuses a closed submission
    // regardless of what this returns, so the worst case of being wrong here is a missing link.
    retry: false,
  });
}

export function useCounselorSignup() {
  return useMutation({
    mutationFn: (payload: CounselorSignupPayload) => authApi.counselorSignup(payload),
  });
}

export function useResendSignupCode() {
  return useMutation({
    mutationFn: (email: string) => authApi.resendSignupCode(email),
  });
}

/**
 * Verify the emailed code. No session results — the counselor signs in through the ordinary login
 * screen afterwards, which keeps token issuance on exactly one path.
 */
export function useVerifySignupCode() {
  return useMutation({
    mutationFn: ({ email, code }: { email: string; code: string }) =>
      authApi.verifySignupCode(email, code),
  });
}

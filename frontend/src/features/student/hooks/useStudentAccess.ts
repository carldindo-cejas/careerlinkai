import { useMutation, useQueryClient } from '@tanstack/react-query';

import { CURRENT_USER_QUERY_KEY } from '@/features/auth/hooks/useAuth';
import { studentAccessApi, type JoinClassPayload } from '@/services/studentAccessApi';
import { useAuthStore } from '@/stores/authStore';
import { useStudentClassStore } from '@/stores/studentClassStore';

/**
 * Passwordless class access (FULLPLAN §38), in two steps since the 18 September 2026 incident.
 *
 * `useConfirmIdentity` resolves the class code and username and answers with the name they belong
 * to; `useJoinClass` is the one that actually signs in. Splitting them is what stops a mistyped
 * roster number from silently becoming somebody else's session — see `studentAccessApi` for the
 * numbers that made the case.
 */
export function useConfirmIdentity() {
  return useMutation({
    mutationFn: (payload: JoinClassPayload) => studentAccessApi.confirm(payload),
  });
}

/**
 * A successful join is a sign-in: it yields the same kind of Sanctum token staff get, so
 * it populates the same auth store. What differs is only how the identity was claimed —
 * a class code and a username, never a password.
 */
export function useJoinClass() {
  const queryClient = useQueryClient();
  const setToken = useAuthStore((state) => state.setToken);
  const setUser = useAuthStore((state) => state.setUser);
  const setClass = useStudentClassStore((state) => state.setClass);

  return useMutation({
    mutationFn: (payload: JoinClassPayload) => studentAccessApi.join(payload),
    onSuccess: ({ user, token, class: classRoom, username }) => {
      // `setToken` also clears the "your session ended" notice — arriving with a live session is
      // the one unambiguous sign the student is no longer looking at the aftermath of the last one.
      setToken(token);
      setUser(user);
      setClass(classRoom, username);
      queryClient.setQueryData(CURRENT_USER_QUERY_KEY, user);
    },
  });
}

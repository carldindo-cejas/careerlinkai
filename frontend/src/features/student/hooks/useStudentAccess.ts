import { useMutation, useQueryClient } from '@tanstack/react-query';

import { CURRENT_USER_QUERY_KEY } from '@/features/auth/hooks/useAuth';
import { studentAccessApi, type JoinClassPayload } from '@/services/studentAccessApi';
import { useAuthStore } from '@/stores/authStore';
import { useStudentClassStore } from '@/stores/studentClassStore';

/**
 * Passwordless class access (FULLPLAN §38).
 *
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
      setToken(token);
      setUser(user);
      setClass(classRoom, username);
      queryClient.setQueryData(CURRENT_USER_QUERY_KEY, user);
    },
  });
}

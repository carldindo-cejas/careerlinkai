import type { QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { AUTH_STORAGE_KEY, useAuthStore } from '@/stores/authStore';
import { STUDENT_CLASS_STORAGE_KEY, useStudentClassStore } from '@/stores/studentClassStore';

/** The token another tab left in storage — `null` when it signed out or the key is gone. */
function storedToken(): string | null {
  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as { state?: { token?: unknown } } | null) : null;
    const token = parsed?.state?.token;

    return typeof token === 'string' ? token : null;
  } catch {
    return null;
  }
}

/**
 * Keep every tab on the same session.
 *
 * The token is persisted to local storage, which all tabs share, but each tab reads it once on
 * load and then works from memory. Without this, signing out in one tab left the others acting on
 * a revoked token, and signing in as someone else left them acting as the previous user until a
 * reload swapped them without warning.
 *
 * The browser fires `storage` in every *other* tab when the key changes, so this tab adopts the
 * new token, forgets the user it had, and drops every cached query — all of it was fetched as
 * somebody else. The route guards then do the rest: no token sends the tab to its sign-in door,
 * and a different one is re-verified against /auth/me and routed to that role's dashboard.
 */
export function useAuthTabSync(queryClient: QueryClient) {
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === STUDENT_CLASS_STORAGE_KEY) {
        void useStudentClassStore.persist.rehydrate();
        return;
      }

      // `key` is null when another tab cleared storage wholesale.
      if (event.key !== AUTH_STORAGE_KEY && event.key !== null) {
        return;
      }

      const token = storedToken();

      if (token === useAuthStore.getState().token) {
        return;
      }

      useAuthStore.setState({ token, user: null });
      queryClient.clear();
    }

    window.addEventListener('storage', onStorage);

    return () => window.removeEventListener('storage', onStorage);
  }, [queryClient]);
}

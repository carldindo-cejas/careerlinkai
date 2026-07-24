import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { User, UserRole } from '@/types/user';

/**
 * Global auth state (FULLPLAN §36 — Zustand owns the current user, token and role
 * context; server state belongs to TanStack Query).
 *
 * Only the token is persisted. The user object is deliberately not: it would go stale,
 * and /auth/me is the single source of truth for who the token belongs to.
 */
interface AuthState {
  token: string | null;
  user: User | null;
  /**
   * The role of the last signed-in user, kept across `clear()`.
   *
   * Not an authorization input — nothing is ever granted on the strength of it, and it
   * survives precisely because it is inert. It exists so the app can still answer "which
   * door does this person go back to" *after* the session it would have read that from is
   * gone: rotating a password revokes the token, and the redirect that follows happens when
   * `user` is already null (§38).
   */
  lastRole: UserRole | null;
  setToken: (token: string) => void;
  setUser: (user: User | null) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      lastRole: null,
      setToken: (token) => set({ token }),
      setUser: (user) => set(user ? { user, lastRole: user.role } : { user }),
      clear: () => set({ token: null, user: null }),
    }),
    {
      name: 'careerlinkai.auth',
      partialize: (state) => ({ token: state.token }),
    },
  ),
);

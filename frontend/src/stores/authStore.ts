import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { User } from '@/types/user';

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
  setToken: (token: string) => void;
  setUser: (user: User | null) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      setToken: (token) => set({ token }),
      setUser: (user) => set({ user }),
      clear: () => set({ token: null, user: null }),
    }),
    {
      name: 'careerlinkai.auth',
      partialize: (state) => ({ token: state.token }),
    },
  ),
);

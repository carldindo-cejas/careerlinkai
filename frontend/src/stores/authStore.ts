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
  /**
   * True when the session ended *to* the student rather than *by* them — the server rejected
   * their token, so `endSession()` cleared it rather than `clear()`.
   *
   * It exists to answer the question the 18 September 2026 incident left every student asking:
   * they were mid-question, and then they were on the sign-in screen with no explanation. The
   * sign-in screen reads this and says what happened. Deliberately **not** persisted — a notice
   * that survived a reload would outlive the event it describes.
   */
  sessionEnded: boolean;
  setToken: (token: string) => void;
  setUser: (user: User | null) => void;
  /** A sign-out the user asked for: logout, or a password change that revoked the token. */
  clear: () => void;
  /** A sign-out the server imposed: the token was rejected. Leaves a notice behind. */
  endSession: () => void;
}

/** The local-storage key the token is persisted under — shared by every tab on the origin. */
export const AUTH_STORAGE_KEY = 'careerlinkai.auth';

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      lastRole: null,
      sessionEnded: false,
      setToken: (token) => set({ token, sessionEnded: false }),
      setUser: (user) => set(user ? { user, lastRole: user.role } : { user }),
      clear: () => set({ token: null, user: null, sessionEnded: false }),
      endSession: () => set({ token: null, user: null, sessionEnded: true }),
    }),
    {
      name: AUTH_STORAGE_KEY,
      partialize: (state) => ({ token: state.token }),
    },
  ),
);

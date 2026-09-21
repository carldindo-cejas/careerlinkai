import { useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useCurrentUser } from '@/features/auth/hooks/useAuth';
import { homePathForRole, loginPathForRole, paths } from '@/routes/paths';
import { RouteFallback } from '@/routes/RouteFallback';
import { useAuthStore } from '@/stores/authStore';
import type { UserRole } from '@/types/user';

export interface ProtectedRouteProps {
  /** Roles allowed through. Omit to allow any authenticated user. */
  allow?: UserRole[];
}

/**
 * Route guard (FULLPLAN §37, §39).
 *
 * The token is persisted, the user is not — so on a cold load we always re-verify the
 * session against /auth/me rather than trusting local storage. Authorization is still
 * enforced server-side by Policies; this guard only decides what to render.
 */
export function ProtectedRoute({ allow }: ProtectedRouteProps) {
  const location = useLocation();
  const token = useAuthStore((state) => state.token);
  const setUser = useAuthStore((state) => state.setUser);
  const lastRole = useAuthStore((state) => state.lastRole);

  const { data: user, isPending, isError, refetch, isFetching } = useCurrentUser();

  useEffect(() => {
    if (user) {
      setUser(user);
    }
  }, [user, setUser]);

  // Each role is sent to its own door (§38): a student turned away from a student-only
  // route belongs at the class-code screen (they have no password), and an admin-only
  // route resolves to the administrator login — a guard redirect, not a visible link,
  // so /admin-login stays unreferenced in the UI.
  //
  // On a route that serves every role the guard has no `allow` to read the door from, so it
  // falls back to who was last signed in. /change-password is that route, and it is also the
  // one place a session ends *by design*: rotating a password revokes the token, and without
  // this an admin would be handed to the counselor door, which refuses them — a lockout, since
  // /admin-login is unlinked and nothing on screen would offer it.
  const signInPath = allow?.every((role) => role === 'student')
    ? paths.studentAccess
    : allow?.every((role) => role === 'admin')
      ? paths.adminLogin
      : allow
        ? paths.login
        : (lastRole && loginPathForRole(lastRole)) || paths.login;

  if (!token) {
    return <Navigate to={signInPath} state={{ from: location }} replace />;
  }

  // Shared with the router's Suspense boundary rather than copied — the two waits are
  // consecutive on a cold load and a student should not see them as two different screens.
  if (isPending) {
    return <RouteFallback />;
  }

  /**
   * **Reaching here with an error means the token was not the problem.**
   *
   * A 401 — revoked, expired, or an account no longer active — clears the token in the http
   * client, which re-renders this component into the `!token` branch above and sends the student
   * to their sign-in door. So the only failures that arrive here are the ones that left the
   * session intact: a 429, a 500, a request that never made it off a phone on school wifi.
   *
   * Those used to land in the same `Navigate` as a real rejection, which meant a single dropped
   * request presented to a student as being thrown out of the system — and, because the join
   * screen was where they landed, they signed in again, ended somebody else's session, and fed
   * the eviction loop of the 18 September 2026 incident. `useCurrentUser` now retries these
   * before giving up; this is what the student sees if the retries also fail, and the session is
   * still there behind it.
   */
  if (isError) {
    return (
      <div
        className="flex min-h-screen items-center justify-center p-4"
        role="alert"
      >
        <div className="flex w-full max-w-md flex-col gap-4">
          <Alert tone="warning">
            We could not reach the server. You are still signed in — check your connection and try
            again.
          </Alert>
          <Button onClick={() => void refetch()} loading={isFetching}>
            {isFetching ? 'Trying again…' : 'Try again'}
          </Button>
        </div>
      </div>
    );
  }

  // Pending is handled above, so no user here means the query resolved to nothing — a shape the
  // API cannot produce, and not something to guess at.
  if (!user) {
    return <Navigate to={signInPath} replace />;
  }

  // Staff on a temporary password go straight to the change-password screen and can
  // reach nothing else until it is set (§38).
  if (user.must_change_password && location.pathname !== paths.changePassword) {
    return <Navigate to={paths.changePassword} replace />;
  }

  if (allow && !allow.includes(user.role)) {
    return <Navigate to={homePathForRole(user.role)} replace />;
  }

  return <Outlet />;
}

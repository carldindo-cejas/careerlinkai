import { useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';

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

  const { data: user, isPending, isError } = useCurrentUser();

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

  // The token was rejected (revoked, expired, or the account is no longer active). The
  // http client has already cleared it.
  if (isError || !user) {
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

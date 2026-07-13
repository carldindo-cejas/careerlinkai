import { Loader2 } from 'lucide-react';
import { useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { useCurrentUser } from '@/features/auth/hooks/useAuth';
import { homePathForRole, paths } from '@/routes/paths';
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

  const { data: user, isPending, isError } = useCurrentUser();

  useEffect(() => {
    if (user) {
      setUser(user);
    }
  }, [user, setUser]);

  // A student turned away from a student-only route belongs at the class-code screen, not
  // at the staff login — that page has a password field and they have no password (§38).
  const signInPath = allow?.every((role) => role === 'student') ? paths.studentAccess : paths.login;

  if (!token) {
    return <Navigate to={signInPath} state={{ from: location }} replace />;
  }

  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center" role="status">
        <Loader2 className="size-6 animate-spin text-slate-400" aria-hidden="true" />
        <span className="sr-only">Loading…</span>
      </div>
    );
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

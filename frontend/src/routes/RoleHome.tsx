import { Navigate } from 'react-router-dom';

import { homePathForRole, paths } from '@/routes/paths';
import { useAuthStore } from '@/stores/authStore';

/**
 * Sends an authenticated user to the dashboard for their role.
 *
 * Rendered inside ProtectedRoute, so by the time this runs the session has already
 * been verified against /auth/me and the user is known.
 */
export function RoleHome() {
  const user = useAuthStore((state) => state.user);

  if (!user) {
    return <Navigate to={paths.login} replace />;
  }

  return <Navigate to={homePathForRole(user.role)} replace />;
}

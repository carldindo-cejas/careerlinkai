import { Navigate, Outlet } from 'react-router-dom';

import { useCurrentUser } from '@/features/auth/hooks/useAuth';
import { homePathForRole } from '@/routes/paths';
import { RouteFallback } from '@/routes/RouteFallback';
import { useAuthStore } from '@/stores/authStore';

/**
 * The inverse of ProtectedRoute: the sign-in doors are for people who are not signed in.
 *
 * The forms already redirect once `user` is set, but `user` is not persisted — a fresh tab
 * carries only the token, so the form rendered anyway and let a second account sign in over the
 * first. Because the persisted token is shared by every tab while each tab keeps its own copy in
 * memory, one browser could end up running admin, counselor and student side by side, until a
 * reload quietly turned every tab into whoever signed in last.
 *
 * So the token is verified first, exactly as ProtectedRoute does, and a live session goes to its
 * own dashboard instead of the form. A token the server rejects falls through to the form (the
 * http client has already cleared it on the 401).
 */
export function GuestRoute() {
  const token = useAuthStore((state) => state.token);
  const { data: user, isPending, isError } = useCurrentUser();

  if (!token || isError) {
    return <Outlet />;
  }

  if (isPending) {
    return <RouteFallback />;
  }

  return <Navigate to={homePathForRole(user.role)} replace />;
}

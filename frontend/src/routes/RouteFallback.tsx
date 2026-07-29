import { Loader2 } from 'lucide-react';

/**
 * The one full-screen "we are not ready to paint yet" state (P3-3).
 *
 * Two things wait at the top of a route and neither knows about the other: `ProtectedRoute`
 * waiting on `/auth/me`, and now `Suspense` waiting on the route group's chunk. They are
 * consecutive on a cold load — verify the session, *then* fetch the shell — so rendering two
 * different spinners would show the student two different screens for one wait.
 *
 * `role="status"` with the visible spinner marked `aria-hidden` is P2-3's rule: the announcement
 * is the sr-only text, not the icon.
 */
export function RouteFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center" role="status">
      <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

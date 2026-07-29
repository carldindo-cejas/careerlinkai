import { ErrorBoundary } from '@/app/ErrorBoundary';
import { AppProviders } from '@/app/providers';
import { AppRoutes } from '@/routes/router';

/**
 * The boundary sits **inside** the providers, not outside them (audit F6).
 *
 * Its fallback is a normal screen — it uses `Button`, and "Try again" re-renders the route it
 * caught. Both want the router and the query client to still be mounted. Wrapping the providers
 * instead would tear those down along with the failing tree, leaving the fallback rendering
 * outside the context it depends on and the retry with nothing to retry into.
 */
export function App() {
  return (
    <AppProviders>
      <ErrorBoundary>
        <AppRoutes />
      </ErrorBoundary>
    </AppProviders>
  );
}

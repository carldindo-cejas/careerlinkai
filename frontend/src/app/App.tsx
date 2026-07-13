import { AppProviders } from '@/app/providers';
import { AppRoutes } from '@/routes/router';

export function App() {
  return (
    <AppProviders>
      <AppRoutes />
    </AppProviders>
  );
}

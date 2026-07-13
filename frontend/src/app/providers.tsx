import { QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { BrowserRouter } from 'react-router-dom';

import { createQueryClient } from '@/app/queryClient';

export interface AppProvidersProps {
  children: ReactNode;
}

/**
 * Application providers (FULLPLAN §35).
 *
 * The QueryClient is created in state rather than at module scope so that each mounted
 * app — including each test — gets its own cache and tests cannot leak state into one
 * another.
 */
export function AppProviders({ children }: AppProvidersProps) {
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>{children}</BrowserRouter>
    </QueryClientProvider>
  );
}

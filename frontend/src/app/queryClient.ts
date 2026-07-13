import { QueryClient } from '@tanstack/react-query';

import { ApiRequestError } from '@/types/api';

/**
 * Server-state defaults (FULLPLAN §36).
 *
 * A 4xx is never retried: a 401, 403 or 422 will not resolve by asking again, and
 * retrying a rejected login would burn through the §41 rate limit for no reason.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500) {
            return false;
          }

          return failureCount < 2;
        },
      },
      mutations: {
        retry: false,
      },
    },
  });
}

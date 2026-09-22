import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { matchingApi } from '@/services/platformApi';
import type { PreviewInput } from '@/types/matching';

/**
 * The admin Matching page's hooks (backend 2026-09-22). Components call these; these call
 * `matchingApi`.
 */

export const matchingKeys = {
  freshness: ['matching', 'freshness'] as const,
};

export function useRecommendationFreshness() {
  return useQuery({
    queryKey: matchingKeys.freshness,
    queryFn: () => matchingApi.freshness(),
  });
}

export interface RecomputeProgress {
  regenerated: number;
  failed: number;
  remaining: number;
}

/**
 * Recompute every stale set, **one small page per request**.
 *
 * The Worker runs on the Free plan (50 subrequests a request), so the server does about three
 * students at a time and the browser drives the loop. It stops when nothing is left, or when a page
 * made no progress — a student whose set cannot be regenerated stays stale, and must not spin this
 * forever. Closing the tab simply stops; the next run resumes from the stalest set, because the
 * server's stale list is its own cursor.
 */
export function useRecomputeStale() {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<RecomputeProgress | null>(null);

  const mutation = useMutation({
    mutationFn: async (): Promise<RecomputeProgress> => {
      const total: RecomputeProgress = { regenerated: 0, failed: 0, remaining: 0 };

      setProgress({ ...total });

      for (;;) {
        const page = await matchingApi.recompute();

        total.regenerated += page.regenerated;
        total.failed += page.failed;
        total.remaining = page.remaining;
        setProgress({ ...total });

        if (page.remaining === 0 || page.regenerated === 0) {
          return total;
        }
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: matchingKeys.freshness });
    },
  });

  return { ...mutation, progress };
}

/** Score a hypothetical student against the live configuration (or a draft formula). Writes nothing. */
export function usePreviewMatches() {
  return useMutation({
    mutationFn: (input: PreviewInput) => matchingApi.preview(input),
  });
}

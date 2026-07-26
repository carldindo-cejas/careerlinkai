import { useQuery } from '@tanstack/react-query';

import { publicApi } from '@/services/publicApi';

/**
 * The public browse queries (prompt-driven, v1.5) — the Colleges and Careers pages of the public
 * site. All unauthenticated, and cached for five minutes: the catalog changes rarely, and the public
 * pages are the highest-traffic surface, so a fresh fetch per visit is wasteful.
 *
 * The careers and outlook lists are fetched whole and filtered client-side (see `CareersPage`), so
 * there is one query for the data and one for the filter options — not a request per filter change.
 */

const PUBLIC_STALE_TIME = 5 * 60 * 1000;

export function usePublicColleges(regionId: string | null) {
  return useQuery({
    // Keyed by region so switching the filter fetches (and caches) each scope independently.
    queryKey: ['public', 'colleges', regionId ?? 'all'],
    queryFn: () => publicApi.colleges(regionId ?? undefined),
    staleTime: PUBLIC_STALE_TIME,
  });
}

export function usePublicCollegeRegions() {
  return useQuery({
    queryKey: ['public', 'college-regions'],
    queryFn: () => publicApi.collegeRegions(),
    staleTime: PUBLIC_STALE_TIME,
  });
}

export function usePublicCareers() {
  return useQuery({
    queryKey: ['public', 'careers'],
    queryFn: () => publicApi.careers(),
    staleTime: PUBLIC_STALE_TIME,
  });
}

export function usePublicEmploymentOutlooks() {
  return useQuery({
    queryKey: ['public', 'employment-outlooks'],
    queryFn: () => publicApi.employmentOutlooks(),
    staleTime: PUBLIC_STALE_TIME,
  });
}

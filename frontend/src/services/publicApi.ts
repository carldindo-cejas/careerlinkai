import { httpClient, unwrap } from '@/services/httpClient';
import type { ApiSuccess } from '@/types/api';
import type { Career, College, EmploymentOutlook, Place } from '@/types/catalog';

/**
 * The unauthenticated public browse (prompt-driven, v1.5) — the Colleges and Careers pages of the
 * public site. No bearer token is required; the httpClient simply omits the Authorization header when
 * no one is signed in.
 *
 * These reuse the same `College`/`Career` contracts as the admin catalog: a public college is a
 * `College` whose `programs` list is capped to a short preview (with `programs_count` carrying the
 * true total, so the card can render "+N more"), and a public career is an active `Career` with its
 * employment outlook resolved.
 */
export const publicApi = {
  /** Every active college, optionally scoped to one region — with address, map link, and a program preview. */
  colleges(regionId?: string): Promise<College[]> {
    return unwrap(
      httpClient.get<ApiSuccess<{ colleges: College[] }>>('/colleges/public', {
        params: regionId ? { region_id: regionId } : {},
      }),
    ).then((data) => data.colleges);
  },

  /** The region filter's options — only regions that actually have an active college. */
  collegeRegions(): Promise<Place[]> {
    return unwrap(
      httpClient.get<ApiSuccess<{ regions: Place[] }>>('/regions/public'),
    ).then((data) => data.regions);
  },

  /** Every active career, with its employment outlook resolved and raw salary bounds. */
  careers(): Promise<Career[]> {
    return unwrap(
      httpClient.get<ApiSuccess<{ careers: Career[] }>>('/careers/public'),
    ).then((data) => data.careers);
  },

  /** The employment-outlook options for the careers filter. */
  employmentOutlooks(): Promise<EmploymentOutlook[]> {
    return unwrap(
      httpClient.get<ApiSuccess<EmploymentOutlook[]>>('/employment-outlooks/public'),
    );
  },
};

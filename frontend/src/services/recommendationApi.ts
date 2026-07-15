import { httpClient, unwrap } from '@/services/httpClient';
import type { ApiSuccess } from '@/types/api';
import type { RecommendationSet } from '@/types/recommendation';

/**
 * Recommendations (FULLPLAN §20, §27 — Phase 4).
 *
 * **`null` is a successful answer, not a failure.** A student who has not completed *both* RIASEC
 * and SCCT has no recommendations, and that is the ordinary state of most students most of the
 * time. The API answers 200 with `data: null` rather than 404 precisely so the client can tell
 * three genuinely different things apart:
 *
 *   - the request failed          → the hook's `isError`
 *   - you have none yet           → `data === null`
 *   - here they are               → a set
 *
 * That distinction is the whole substance of deviation D11, which existed because the Phase 3
 * screens could not make it and told students they had nothing to do while the endpoint was
 * 404ing. Shipping the recommendation screens with the same ambiguity would be a poor joke.
 */
export const recommendationApi = {
  /** Mine. There is no student id in this URL, so it cannot be made to mean anyone else's. */
  getMine(): Promise<RecommendationSet | null> {
    return unwrap(httpClient.get<ApiSuccess<RecommendationSet | null>>('/student/recommendations'));
  },

  /**
   * A counselor reading one of their own students (§4). The server 404s — deliberately, not 403s —
   * for a student outside their classes, so "not yours" and "not real" are indistinguishable.
   */
  getForStudent(studentId: string): Promise<RecommendationSet | null> {
    return unwrap(
      httpClient.get<ApiSuccess<RecommendationSet | null>>(
        `/counselor/students/${studentId}/recommendations`,
      ),
    );
  },
};

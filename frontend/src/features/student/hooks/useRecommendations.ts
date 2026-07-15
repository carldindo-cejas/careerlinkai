import { useMutation, useQuery } from '@tanstack/react-query';

import { aiApi } from '@/services/aiApi';
import { recommendationApi } from '@/services/recommendationApi';

/**
 * Recommendation hooks (FULLPLAN §36). Components call these; these call the service.
 */

export const recommendationKeys = {
  mine: ['student', 'recommendations'] as const,
  forStudent: (id: string) => ['counselor', 'students', id, 'recommendations'] as const,
};

export function useMyRecommendations() {
  return useQuery({
    queryKey: recommendationKeys.mine,
    queryFn: () => recommendationApi.getMine(),
  });
}

export function useStudentRecommendations(studentId: string) {
  return useQuery({
    queryKey: recommendationKeys.forStudent(studentId),
    queryFn: () => recommendationApi.getForStudent(studentId),
    enabled: Boolean(studentId),
  });
}

/**
 * "Explain more" (§20, §30 — Phase 5a). A mutation, not a query: the student asks, once,
 * and the server answers 200 whatever happened to the model — an existing explanation, a
 * fresh one, or `explanation: null` with the deterministic reason as the fallback. The
 * card renders whichever arrived; there is no error state that hides the reason.
 */
export function useExplainRecommendation() {
  return useMutation({
    mutationFn: (recommendationId: string) => aiApi.explainRecommendation(recommendationId),
  });
}

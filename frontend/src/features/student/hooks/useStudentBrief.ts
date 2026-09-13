import { useQuery } from '@tanstack/react-query';

import { chatApi } from '@/services/recommendationApi';

export const briefKeys = {
  mine: ['student', 'brief'] as const,
};

/**
 * What the assistant knows about the signed-in student, and starter questions for the chat
 * (AI-COVERAGE-PLAN.md Phase 4).
 *
 * Fetched once when the student shell mounts, so the chat opens already knowing whether the student
 * has recommendations and which questions to offer. A minute of staleness is fine: the brief only
 * changes when an assessment is submitted or recommendations are rebuilt.
 */
export function useStudentBrief() {
  return useQuery({
    queryKey: briefKeys.mine,
    queryFn: () => chatApi.getBrief(),
    staleTime: 60_000,
  });
}

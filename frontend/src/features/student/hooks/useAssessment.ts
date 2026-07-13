import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { studentAssessmentApi } from '@/services/assessmentApi';
import type { UpdateProfilePayload } from '@/types/assessment';

/**
 * Student assessment hooks (FULLPLAN §36). Components call these; these call the service.
 */

export const assessmentKeys = {
  profile: ['student', 'profile'] as const,
  assignments: ['student', 'assignments'] as const,
  attempt: (id: string) => ['student', 'attempts', id] as const,
  results: ['student', 'results'] as const,
  result: (id: string) => ['student', 'results', id] as const,
};

export function useProfile() {
  return useQuery({
    queryKey: assessmentKeys.profile,
    queryFn: () => studentAssessmentApi.getProfile(),
  });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: UpdateProfilePayload) => studentAssessmentApi.updateProfile(payload),
    onSuccess: (profile) => {
      queryClient.setQueryData(assessmentKeys.profile, profile);
    },
  });
}

export function useAssignments() {
  return useQuery({
    queryKey: assessmentKeys.assignments,
    queryFn: () => studentAssessmentApi.listAssignments(),
  });
}

export function useAttempt(attemptId: string) {
  return useQuery({
    queryKey: assessmentKeys.attempt(attemptId),
    queryFn: () => studentAssessmentApi.getAttempt(attemptId),

    // The attempt holds the student's answers so far. Refetching it mid-test would race the
    // answers being saved and could flicker a chosen option back to unselected — the player
    // holds its own answer state (see AssessmentPlayerPage) and this query is the *initial*
    // load, not a live mirror.
    refetchOnWindowFocus: false,
  });
}

export function useStartAttempt() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (assignmentId: string) => studentAssessmentApi.start(assignmentId),
    onSuccess: (attempt) => {
      queryClient.setQueryData(assessmentKeys.attempt(attempt.id), attempt);
      void queryClient.invalidateQueries({ queryKey: assessmentKeys.assignments });
    },
  });
}

/**
 * One answer, saved as the student picks it.
 *
 * Deliberately **not** optimistic and deliberately not invalidating the attempt query: the
 * player owns the selected-answer state locally, and a refetch here would be a round trip whose
 * only effect is to tell the player something it already knows. What this mutation is *for* is
 * durability — a student who closes the tab on question 40 comes back to question 40.
 */
export function useSaveAnswer(attemptId: string) {
  return useMutation({
    mutationFn: ({ questionId, optionId }: { questionId: string; optionId: string }) =>
      studentAssessmentApi.saveAnswer(attemptId, questionId, optionId),
  });
}

export function useSubmitAttempt(attemptId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => studentAssessmentApi.submit(attemptId),
    onSuccess: (result) => {
      // The result comes back in the submit response — scoring is inline (§24). Seeding it here
      // means the results screen renders instantly rather than fetching what we already have.
      queryClient.setQueryData(assessmentKeys.result(result.attempt_id), result);
      void queryClient.invalidateQueries({ queryKey: assessmentKeys.results });
      void queryClient.invalidateQueries({ queryKey: assessmentKeys.assignments });
      void queryClient.invalidateQueries({ queryKey: assessmentKeys.attempt(attemptId) });
    },
  });
}

export function useResults() {
  return useQuery({
    queryKey: assessmentKeys.results,
    queryFn: () => studentAssessmentApi.listResults(),
  });
}

export function useResult(attemptId: string) {
  return useQuery({
    queryKey: assessmentKeys.result(attemptId),
    queryFn: () => studentAssessmentApi.getResult(attemptId),
  });
}

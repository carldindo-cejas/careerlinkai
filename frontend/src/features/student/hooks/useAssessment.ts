import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

import { CURRENT_USER_QUERY_KEY } from '@/features/auth/hooks/useAuth';
import { demoInstead, demoReportFor, useTourDemo } from '@/features/student/tour/demoMode';
import { studentAssessmentApi } from '@/services/assessmentApi';
import type { UpdateProfilePayload } from '@/types/assessment';

/**
 * Student assessment hooks (FULLPLAN §36). Components call these; these call the service.
 *
 * Three of them can answer with the tour's example student instead of the signed-in one — see
 * `features/student/tour/demoMode.ts`. It is done here rather than in the pages so that the
 * substitution has one home: a screen that learned about it separately is a screen that can
 * forget, and the one thing worse than an empty tour stop is a page half filled with somebody
 * else's answers.
 */

export const assessmentKeys = {
  profile: ['student', 'profile'] as const,
  profileOptions: ['student', 'profile', 'options'] as const,
  assignments: ['student', 'assignments'] as const,
  attempt: (id: string) => ['student', 'attempts', id] as const,
  results: ['student', 'results'] as const,
  result: (id: string) => ['student', 'results', id] as const,
  report: (id: string) => ['student', 'results', id, 'report'] as const,
};

export function useProfile() {
  return useQuery({
    queryKey: assessmentKeys.profile,
    queryFn: () => studentAssessmentApi.getProfile(),
  });
}

/** Two rows each, identical for every user in the system — so it is cached for the session. */
export function useProfileOptions() {
  return useQuery({
    queryKey: assessmentKeys.profileOptions,
    queryFn: () => studentAssessmentApi.getProfileOptions(),
    staleTime: Infinity,
  });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: UpdateProfilePayload) => studentAssessmentApi.updateProfile(payload),
    onSuccess: (profile) => {
      queryClient.setQueryData(assessmentKeys.profile, profile);

      /*
        The name the rest of the app greets them by (prompt-driven, 2026-09-20).

        A student may now change their own name here, and `users.name` moves with it on the
        server — but the copy the shell renders comes from `/auth/me`, which is cached for five
        minutes and mirrored into the auth store by `ProtectedRoute`. Without this, a student
        corrects the spelling of their name, sees the form accept it, and the header above the
        form goes on greeting them by the old one until the cache expires.

        Invalidated rather than patched: the *display* name is the server's join of first and
        last, and reproducing that rule here would be a second place for it to live.

        Unconditional, because a save that did not touch the name refetches a query the shell
        would have refetched anyway — one request against a five-minute cache, on a form
        submitted a handful of times a year.
      */
      void queryClient.invalidateQueries({ queryKey: CURRENT_USER_QUERY_KEY });

      /*
        The results list and the printable report both carry the student's name in their identity
        block, and both are already-fetched queries that a rename just invalidated on the server.
      */
      void queryClient.invalidateQueries({ queryKey: assessmentKeys.results });
    },
  });
}

export function useAssignments() {
  const query = useQuery({
    queryKey: assessmentKeys.assignments,
    queryFn: () => studentAssessmentApi.listAssignments(),
  });

  return demoInstead(query, useTourDemo()?.assignments);
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
  const query = useQuery({
    queryKey: assessmentKeys.results,
    queryFn: () => studentAssessmentApi.listResults(),
  });

  return demoInstead(query, useTourDemo()?.results);
}

export function useResult(attemptId: string) {
  return useQuery({
    queryKey: assessmentKeys.result(attemptId),
    queryFn: () => studentAssessmentApi.getResult(attemptId),
  });
}

/** One query per attempt, in the order given — the print sheet and the results screen's two cards. */
export function useReports(attemptIds: string[]) {
  return useQueries({
    queries: attemptIds.map((attemptId) => ({
      queryKey: assessmentKeys.report(attemptId),
      /*
        Short-circuited in the query function rather than around the hook, because the ids
        themselves are the example student's (`tour-demo-…`) and a request for one would be a
        round trip that can only 404. Nothing else changes: the result is cached under its own
        key, which no real attempt can share.
      */
      queryFn: () => demoReportFor(attemptId) ?? studentAssessmentApi.getReport(attemptId),
    })),
  });
}

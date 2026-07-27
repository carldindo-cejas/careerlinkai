import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { aiApi } from '@/services/aiApi';
import { catalogLinksApi, chatApi, recommendationApi } from '@/services/recommendationApi';
import type { ChatTranscript } from '@/types/recommendation';

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

// --- The relationship lookups (migration 0018) -----------------------------------------------

export const catalogLinkKeys = {
  careerPrograms: (careerId: string) => ['student', 'careers', careerId, 'programs'] as const,
  programColleges: (programId: string) => ['student', 'programs', programId, 'colleges'] as const,
};

/**
 * Both lookups are `enabled`-gated rather than eagerly fetched: they are what a *disclosure*
 * shows, and a recommendations page that fetched the related programs for all five careers and
 * the sibling colleges for all five programs would spend ten requests to render a page on which
 * the student usually opens none of them.
 */
export function useCareerPrograms(careerId: string, enabled: boolean) {
  return useQuery({
    queryKey: catalogLinkKeys.careerPrograms(careerId),
    queryFn: () => catalogLinksApi.programsForCareer(careerId),
    enabled,
    // The catalog does not change while a student reads one page.
    staleTime: 5 * 60 * 1000,
  });
}

export function useProgramColleges(programId: string, enabled: boolean) {
  return useQuery({
    queryKey: catalogLinkKeys.programColleges(programId),
    queryFn: () => catalogLinksApi.collegesForProgram(programId),
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

// --- The chat assistant (migration 0019) -----------------------------------------------------

export const chatKeys = {
  transcript: ['student', 'chat'] as const,
};

export function useChatTranscript() {
  return useQuery({
    queryKey: chatKeys.transcript,
    queryFn: () => chatApi.getTranscript(),
    // A refetch mid-conversation would race the optimistic turn below and could flicker a
    // just-sent message back out of the panel.
    refetchOnWindowFocus: false,
  });
}

/**
 * Ask one question.
 *
 * **Optimistic on the question, never on the answer.** The student's own message goes into the
 * cache immediately — they typed it, it is not in doubt, and waiting a round trip to show it makes
 * the panel feel broken. The answer is only ever what the server sent back, because the one thing
 * this panel must never do is put words in the assistant's mouth that no model produced and no
 * §27 calculation backs.
 *
 * On failure the optimistic question is rolled back, so a message that never reached the server
 * does not sit in the transcript looking answered.
 */
export function useAskChat() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (message: string) => chatApi.ask(message),

    onMutate: async (message: string) => {
      await queryClient.cancelQueries({ queryKey: chatKeys.transcript });

      const previous = queryClient.getQueryData<ChatTranscript>(chatKeys.transcript);

      queryClient.setQueryData<ChatTranscript>(chatKeys.transcript, (current) => ({
        conversation_id: current?.conversation_id ?? null,
        messages: [
          ...(current?.messages ?? []),
          {
            id: `pending-${Date.now()}`,
            role: 'user',
            content: message,
            ai_request_id: null,
            created_at: new Date().toISOString(),
          },
        ],
      }));

      return { previous };
    },

    onError: (_error, _message, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(chatKeys.transcript, context.previous);
      }
    },

    onSuccess: (turn) => {
      // Replace the optimistic question with the server's row (real id, real timestamp) and append
      // the answer — rather than invalidating, which would blank the panel for a round trip.
      queryClient.setQueryData<ChatTranscript>(chatKeys.transcript, (current) => ({
        conversation_id: turn.conversation_id,
        messages: [
          ...(current?.messages ?? []).filter((message) => !message.id.startsWith('pending-')),
          turn.question,
          turn.answer,
        ],
      }));
    },
  });
}

export function useClearChat() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => chatApi.clear(),
    onSuccess: () => {
      queryClient.setQueryData<ChatTranscript>(chatKeys.transcript, {
        conversation_id: null,
        messages: [],
      });
    },
  });
}

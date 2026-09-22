import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { demoInstead, useTourDemo } from '@/features/student/tour/demoMode';
import { catalogLinksApi, chatApi, recommendationApi } from '@/services/recommendationApi';
import type { ChatTranscript, ChatTurn } from '@/types/recommendation';

/**
 * Recommendation hooks (FULLPLAN §36). Components call these; these call the service.
 */

export const recommendationKeys = {
  mine: ['student', 'recommendations'] as const,
  forStudent: (id: string) => ['counselor', 'students', id, 'recommendations'] as const,
};

export function useMyRecommendations() {
  const query = useQuery({
    queryKey: recommendationKeys.mine,
    queryFn: () => recommendationApi.getMine(),
  });

  // The tour's example student, for a student who has none of their own — see
  // `features/student/tour/demoMode.ts`. Only ever while the overlay is up.
  return demoInstead(query, useTourDemo()?.recommendations);
}

/**
 * One of *my* students, read by a counselor (§4). 404s — never 403s — for a student outside their
 * classes, so a status code cannot be used to enumerate student ids.
 *
 * `enabled` is a parameter rather than always-on because the caller that needs this is a roster of
 * students with one expanded at a time (`RosterTable`'s dropdown). There is no bulk endpoint
 * here — the admin's roster view gets its rows hydrated server-side, this one does not — so a
 * component that mounted the hook per student eagerly would fire one request per enrolled student
 * on page load, for cards nobody has opened. Same reasoning as `useCareerPrograms` below.
 */
export function useStudentRecommendations(studentId: string, enabled = true) {
  return useQuery({
    queryKey: recommendationKeys.forStudent(studentId),
    queryFn: () => recommendationApi.getForStudent(studentId),
    enabled: enabled && Boolean(studentId),
  });
}

/**
 * Rebuild my own recommendations (audit C4).
 *
 * The response **is** the new set, so it is written straight into the cache with `setQueryData`
 * rather than invalidated. Invalidating would discard what this request just returned and pay a
 * second round trip to fetch the identical bytes — and, worse, would blank the cards for the
 * duration of that refetch, which is precisely the "I have nothing" state the student pressed this
 * button to escape.
 */
export function useRegenerateMyRecommendations() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => recommendationApi.regenerateMine(),
    onSuccess: (set) => {
      queryClient.setQueryData(recommendationKeys.mine, set);
    },
  });
}

/** The counselor's equivalent, for one of their own students. Same cache-write reasoning. */
export function useRegenerateStudentRecommendations(studentId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => recommendationApi.regenerateForStudent(studentId),
    onSuccess: (set) => {
      queryClient.setQueryData(recommendationKeys.forStudent(studentId), set);
    },
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

/** Ask one typed question. See `useChatTurn` for how the turn reaches the cache. */
export function useAskChat() {
  return useChatTurn((message: string) => chatApi.ask(message), (message) => message);
}

/**
 * "Explain more" on a recommendation card, answered in the chat (2026-09-22).
 *
 * The bubble shows a short "Explain more about …"; what the server runs is the §30 explanation for
 * that one recommendation — the card sends its id, never the question text. The optimistic echo
 * uses the same words the server will write, so the swap on success is invisible.
 */
export function useExplainInChat() {
  return useChatTurn(
    ({ recommendationId }: { recommendationId: string; title: string }) =>
      chatApi.explain(recommendationId),
    ({ title }) => `Explain more about ${title}`,
  );
}

/** Every mutation that adds a turn shares this key, so the panel can say "Thinking…" for any. */
export const chatTurnMutationKey = ['student', 'chat', 'turn'] as const;

/**
 * One turn, whatever asked it — the shared body of `useAskChat` and `useExplainInChat`.
 *
 * **Optimistic on the question, never on the answer.** The student's own message goes into the
 * cache immediately — they asked it, it is not in doubt, and waiting a round trip to show it makes
 * the panel feel broken. The answer is only ever what the server sent back, because the one thing
 * this panel must never do is put words in the assistant's mouth that no model produced and no
 * §27 calculation backs.
 *
 * On failure the optimistic question is rolled back, so a message that never reached the server
 * does not sit in the transcript looking answered.
 */
function useChatTurn<TInput>(
  send: (input: TInput) => Promise<ChatTurn>,
  echo: (input: TInput) => string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: chatTurnMutationKey,
    mutationFn: send,

    onMutate: async (input: TInput) => {
      await queryClient.cancelQueries({ queryKey: chatKeys.transcript });

      const previous = queryClient.getQueryData<ChatTranscript>(chatKeys.transcript);

      queryClient.setQueryData<ChatTranscript>(chatKeys.transcript, (current) => ({
        conversation_id: current?.conversation_id ?? null,
        messages: [
          ...(current?.messages ?? []),
          {
            id: `pending-${Date.now()}`,
            role: 'user',
            content: echo(input),
            ai_request_id: null,
            // The optimistic echo of what the student just asked — a question, so nothing to cite,
            // nothing to flag and nothing to ask the school to answer.
            sources: [],
            feedback: null,
            knowledge_request: null,
            created_at: new Date().toISOString(),
          },
        ],
      }));

      return { previous };
    },

    onError: (_error, _input, context) => {
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

/**
 * Mark one assistant answer as wrong (Phase 4).
 *
 * Optimistic: the thumb fills the moment it is pressed, because a student reporting a wrong answer
 * should not be left wondering whether the report landed. There is no un-flag — the signal goes to
 * an admin review queue, and an item that can vanish before anyone looks at it is worse than a
 * stale one.
 */
export function useFlagAnswer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (messageId: string) => chatApi.flagAnswer(messageId),
    onSuccess: (_result, messageId) => {
      queryClient.setQueryData<ChatTranscript>(chatKeys.transcript, (current) =>
        current === undefined
          ? current
          : {
              ...current,
              messages: current.messages.map((message) =>
                message.id === messageId ? { ...message, feedback: 'DOWN' as const } : message,
              ),
            },
      );
    },
  });
}

/**
 * Ask the school to answer a question nothing covered (migration 0030).
 *
 * Optimistic, for the same reason the flag is: a student who presses a button and sees nothing
 * change assumes it did nothing. The server is idempotent, so a double press is the same state.
 */
export function useRequestKnowledge() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (messageId: string) => chatApi.requestKnowledge(messageId),
    onSuccess: (_result, messageId) => {
      queryClient.setQueryData<ChatTranscript>(chatKeys.transcript, (current) =>
        current === undefined
          ? current
          : {
              ...current,
              messages: current.messages.map((message) =>
                message.id === messageId
                  ? { ...message, knowledge_request: 'REQUESTED' as const }
                  : message,
              ),
            },
      );
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

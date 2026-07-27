import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { builderApi } from '@/services/builderApi';
import {
  isGenerationTerminal,
  type AuthorQuestion,
  type GenerationStatusResponse,
  type QuestionPatch,
  type VersionReview,
} from '@/types/builder';

/**
 * Assessment-builder hooks (Phase 5b — FULLPLAN §31, §36).
 *
 * The one non-obvious piece is `useGenerationStatus`: generation is a queued job (§43), so the
 * hook polls `/ai/requests/{id}/status` while the answer is non-terminal (PENDING or PROCESSING)
 * and stops the moment it is anything else — DRAFTED, FAILED and VALIDATION_FAILED all end it. A
 * DRAFTED result invalidates the version so the review list appears without a manual refresh.
 */

export const builderKeys = {
  template: (templateId: string) => ['builder', 'template', templateId] as const,
  version: (versionId: string) => ['builder', 'version', versionId] as const,
  generation: (aiRequestId: string) => ['builder', 'generation', aiRequestId] as const,
};

export function useBuilderTemplate(templateId: string) {
  return useQuery({
    queryKey: builderKeys.template(templateId),
    queryFn: () => builderApi.getTemplate(templateId),
  });
}

export function useVersionReview(versionId: string | null) {
  return useQuery({
    queryKey: builderKeys.version(versionId ?? 'none'),
    queryFn: () => builderApi.getVersion(versionId!),
    enabled: versionId !== null,
  });
}

export function useAddDimensions(templateId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (dimensions: { code: string; name: string }[]) =>
      builderApi.addDimensions(templateId, dimensions),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: builderKeys.template(templateId) });
    },
  });
}

export function useCreateVersion(templateId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => builderApi.createVersion(templateId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: builderKeys.template(templateId) });
    },
  });
}

export function useAddQuestions(versionId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (questions: Parameters<typeof builderApi.addQuestions>[1]) =>
      builderApi.addQuestions(versionId, questions),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: builderKeys.version(versionId) });
    },
  });
}

/**
 * The builder's auto-save.
 *
 * **The cache is patched from the server's answer rather than invalidated**, and that distinction
 * is the whole reason this hook is written out rather than being another `invalidateQueries`. An
 * invalidation refetches the version, which re-renders every question — and doing that on a debounce
 * while someone is typing takes the focus and the caret with it. The server returns the question it
 * actually wrote, so splicing that one row into the cached list keeps the editor still.
 */
export function useUpdateQuestion(versionId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ questionId, ...payload }: { questionId: string } & QuestionPatch) =>
      builderApi.updateQuestion(questionId, payload),
    onSuccess: (updated) => {
      queryClient.setQueryData<VersionReview>(builderKeys.version(versionId), (review) =>
        review === undefined
          ? review
          : {
              ...review,
              questions: review.questions.map((question) =>
                question.id === updated.id ? updated : question,
              ),
            },
      );

      // The readiness counter *can* move — replacing a mapping writes a confirmed one — and it
      // lives outside the questions array, so the publish gate is refreshed from the server.
      void queryClient.invalidateQueries({
        queryKey: builderKeys.version(versionId),
        refetchType: 'none',
      });
    },
  });
}

export function useDuplicateQuestion(versionId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (questionId: string) => builderApi.duplicateQuestion(questionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: builderKeys.version(versionId) });
    },
  });
}

export function useDeleteQuestion(versionId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (questionId: string) => builderApi.deleteQuestion(questionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: builderKeys.version(versionId) });
    },
  });
}

/**
 * Saving a drag.
 *
 * **Optimistic, and it has to be**: the item is already under the user's cursor in its new place,
 * so waiting for a round trip before showing it there would make every drop snap back and then
 * jump forward. `onMutate` writes the new order into the cache, `onError` restores the snapshot,
 * and the refetch on settle reconciles the `order_number`s the server assigned.
 */
export function useReorderQuestions(versionId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (questionIds: string[]) => builderApi.reorderQuestions(versionId, questionIds),
    onMutate: async (questionIds) => {
      await queryClient.cancelQueries({ queryKey: builderKeys.version(versionId) });

      const previous = queryClient.getQueryData<VersionReview>(builderKeys.version(versionId));

      queryClient.setQueryData<VersionReview>(builderKeys.version(versionId), (review) => {
        if (review === undefined) {
          return review;
        }

        const byId = new Map(review.questions.map((question) => [question.id, question]));

        return {
          ...review,
          questions: questionIds
            .map((id, index) => {
              const question = byId.get(id);

              return question === undefined
                ? undefined
                : { ...question, order_number: index + 1 };
            })
            .filter((question): question is AuthorQuestion => question !== undefined),
        };
      });

      return { previous };
    },
    onError: (_error, _questionIds, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(builderKeys.version(versionId), context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: builderKeys.version(versionId) });
    },
  });
}

/** One mapping at a time — the §25 act. No bulk form exists, by design (§31). */
export function useConfirmMapping(versionId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (mappingId: string) => builderApi.confirmMapping(mappingId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: builderKeys.version(versionId) });
    },
  });
}

export function usePublishVersion(versionId: string, templateId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => builderApi.publish(versionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: builderKeys.version(versionId) });
      void queryClient.invalidateQueries({ queryKey: builderKeys.template(templateId) });
    },
  });
}

export function useGenerateFromDescription(versionId: string) {
  return useMutation({
    mutationFn: (description: string) => builderApi.generateFromDescription(versionId, description),
  });
}

export function useGenerateFromDocument(versionId: string) {
  return useMutation({
    mutationFn: (extractedText: string) => builderApi.generateFromDocument(versionId, extractedText),
  });
}

/** How often to ask. Three seconds is responsive without being a load test on the poll. */
export const GENERATION_POLL_INTERVAL_MS = 3_000;

/**
 * The client's own hard stop.
 *
 * Deliberately **longer** than the server's 10-minute deadline (`GENERATION_DEADLINE_MS`), so in
 * the ordinary case the server wins the race and answers FAILED with a specific, diagnosable
 * reason — "the queued message was never delivered", "QUOTA_EXHAUSTED", and so on. This backstop
 * only fires when the poll itself cannot get an answer at all: the API is unreachable, the token
 * expired mid-generation, a proxy is eating the request. Without it, a request that never resolves
 * leaves a spinner running until the tab closes, which is the shape of the original bug and must
 * not be reachable from the client side either.
 */
export const GENERATION_POLL_TIMEOUT_MS = 11 * 60 * 1000;

/** What the panel actually needs to render, with the polling bookkeeping already resolved. */
export interface GenerationProgress {
  data: GenerationStatusResponse | undefined;
  /** True while the poll is legitimately still running. */
  isPolling: boolean;
  /** The client gave up (see `GENERATION_POLL_TIMEOUT_MS`) — terminal, and not the server's doing. */
  timedOut: boolean;
  /** The poll request itself is failing (network, auth), as opposed to the generation failing. */
  pollError: Error | null;
}

export function useGenerationStatus(
  aiRequestId: string | null,
  versionId: string | null,
): GenerationProgress {
  const queryClient = useQueryClient();
  const [timedOut, setTimedOut] = useState(false);

  // One timer per request id. A fresh generation resets it, so a second attempt gets a full
  // window rather than inheriting the first one's remaining time.
  useEffect(() => {
    setTimedOut(false);

    if (aiRequestId === null) {
      return;
    }

    const timer = setTimeout(() => setTimedOut(true), GENERATION_POLL_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [aiRequestId]);

  const query = useQuery({
    queryKey: builderKeys.generation(aiRequestId ?? 'none'),
    queryFn: async () => {
      const status = await builderApi.generationStatus(aiRequestId!);

      if (status.status === 'DRAFTED' && versionId !== null) {
        void queryClient.invalidateQueries({ queryKey: builderKeys.version(versionId) });
      }

      return status;
    },
    enabled: aiRequestId !== null && !timedOut,
    /**
     * Stop on any terminal status, and on the client's own deadline. Previously this compared
     * against the single literal `'PENDING'`, which was correct only because PENDING was the only
     * non-terminal state that existed — the moment the server learned to say PROCESSING, an
     * equality check would have stopped polling *mid-generation* and left the panel showing a
     * spinner for a draft that had already landed. Asking "is this terminal?" is the question that
     * stays right as states are added.
     */
    refetchInterval: (query) =>
      isGenerationTerminal(query.state.data?.status) ? false : GENERATION_POLL_INTERVAL_MS,
    // A single blip on a poll that runs for minutes should not end the whole generation.
    retry: 3,
  });

  return {
    data: query.data,
    isPolling: aiRequestId !== null && !timedOut && !isGenerationTerminal(query.data?.status),
    timedOut: timedOut && !isGenerationTerminal(query.data?.status),
    pollError: query.error,
  };
}

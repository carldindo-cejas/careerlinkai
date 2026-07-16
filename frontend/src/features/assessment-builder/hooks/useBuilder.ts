import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { builderApi } from '@/services/builderApi';

/**
 * Assessment-builder hooks (Phase 5b — FULLPLAN §31, §36).
 *
 * The one non-obvious piece is `useGenerationStatus`: generation is a queued job (§43), so
 * the hook polls `/ai/requests/{id}/status` while the answer is PENDING and stops the
 * moment it is anything else — DRAFTED, FAILED and VALIDATION_FAILED are all terminal. A
 * DRAFTED result invalidates the version so the review list appears without a manual
 * refresh.
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

export function useCreateTemplate() {
  return useMutation({
    mutationFn: (payload: { title: string; description?: string | null }) =>
      builderApi.createTemplate(payload),
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

export function useUpdateQuestion(versionId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ questionId, ...payload }: { questionId: string; question_text?: string }) =>
      builderApi.updateQuestion(questionId, payload),
    onSuccess: () => {
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

export function useGenerationStatus(aiRequestId: string | null, versionId: string | null) {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: builderKeys.generation(aiRequestId ?? 'none'),
    queryFn: async () => {
      const status = await builderApi.generationStatus(aiRequestId!);

      if (status.status === 'DRAFTED' && versionId !== null) {
        void queryClient.invalidateQueries({ queryKey: builderKeys.version(versionId) });
      }

      return status;
    },
    enabled: aiRequestId !== null,
    refetchInterval: (query) => (query.state.data?.status === 'PENDING' ? 4_000 : false),
  });
}

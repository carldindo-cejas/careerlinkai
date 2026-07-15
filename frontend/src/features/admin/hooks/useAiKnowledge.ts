import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { aiApi } from '@/services/aiApi';
import type { UpdateAiPolicyPayload } from '@/types/ai';

/**
 * AI / Knowledge hooks (FULLPLAN §36). Components call these; these call services/aiApi.
 */

export const aiKeys = {
  knowledgeDocuments: ['admin', 'knowledge-documents'] as const,
  policies: ['admin', 'ai-policies'] as const,
};

export function useKnowledgeDocuments() {
  return useQuery({
    queryKey: aiKeys.knowledgeDocuments,
    queryFn: () => aiApi.listKnowledgeDocuments(),
    // Processing is asynchronous (a queue job, §33) — poll while anything is in flight so
    // the admin sees UPLOADED → PROCESSING → COMPLETED without mashing refresh.
    refetchInterval: (query) =>
      query.state.data?.items.some(
        (document) =>
          document.processing_status === 'UPLOADED' ||
          document.processing_status === 'PROCESSING',
      )
        ? 5_000
        : false,
  });
}

export function useUploadKnowledgeDocument() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ file, extractedText }: { file: File; extractedText: string }) =>
      aiApi.uploadKnowledgeDocument(file, extractedText),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: aiKeys.knowledgeDocuments });
    },
  });
}

export function useArchiveKnowledgeDocument() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => aiApi.archiveKnowledgeDocument(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: aiKeys.knowledgeDocuments });
    },
  });
}

export function useReprocessKnowledgeDocument() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => aiApi.reprocessKnowledgeDocument(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: aiKeys.knowledgeDocuments });
    },
  });
}

export function useAiPolicies() {
  return useQuery({
    queryKey: aiKeys.policies,
    queryFn: () => aiApi.listAiPolicies(),
  });
}

export function useUpdateAiPolicy(id: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: UpdateAiPolicyPayload) => aiApi.updateAiPolicy(id, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: aiKeys.policies });
    },
  });
}

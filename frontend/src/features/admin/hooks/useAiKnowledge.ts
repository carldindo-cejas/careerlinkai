import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { aiApi, type KnowledgeListQuery } from '@/services/aiApi';
import type { UpdateAiPolicyPayload } from '@/types/ai';

/**
 * AI / Knowledge hooks (FULLPLAN §36). Components call these; these call services/aiApi.
 */

export const aiKeys = {
  /** The prefix every knowledge query lives under, so one invalidation still clears them all. */
  knowledgeDocuments: ['admin', 'knowledge-documents'] as const,
  knowledgeDocumentList: (query: KnowledgeListQuery) =>
    ['admin', 'knowledge-documents', 'list', query] as const,
  policies: ['admin', 'ai-policies'] as const,
};

export function useKnowledgeDocuments(query: KnowledgeListQuery = {}) {
  return useQuery({
    queryKey: aiKeys.knowledgeDocumentList(query),
    queryFn: () => aiApi.listKnowledgeDocuments(query),
    placeholderData: keepPreviousData,
    // Processing is asynchronous (a queue job, §33) — poll while anything is in flight so
    // the admin sees UPLOADED → PROCESSING → COMPLETED without mashing refresh.
    //
    // "In flight" means *on the current page*, which is the right reading now that the list can
    // be filtered and paged: a document processing on page three is not something this screen is
    // showing, and polling for it would be a request every five seconds for a row nobody can see.
    // The trade is that filtering to `COMPLETED` stops the poll, so a document finishing while
    // that filter is on appears on the next refetch rather than by itself. That is the correct
    // side to err on — the alternative polls forever on a filter that by definition excludes
    // everything still moving.
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

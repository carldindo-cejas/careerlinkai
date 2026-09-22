import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuthStore } from '@/stores/authStore';
import { aiApi, type KnowledgeListQuery, type KnowledgeScope } from '@/services/aiApi';
import type { KnowledgeEntryPayload, UpdateAiPolicyPayload } from '@/types/ai';

/**
 * AI / Knowledge hooks (FULLPLAN §36). Components call these; these call services/aiApi.
 *
 * ## Scope
 *
 * The knowledge screens serve both staff roles from one set of components — a counselor writes to
 * the same corpus an admin does and sees their own contributions back (migration 0031). Which
 * mount to call is decided here, once, from the signed-in user, and it is part of **every query
 * key**: two roles sharing a cache entry in one browser session is the difference between a
 * counselor seeing their library and a counselor seeing the last admin's.
 */

/**
 * Which API mount this user's requests go to.
 *
 * Not an authorization decision — the server scopes every one of these endpoints from the token
 * regardless of which prefix it arrives on, and an admin calling `/counselor/knowledge-documents`
 * would still get the admin's unscoped view. This only picks the route that exists for them.
 */
export function useKnowledgeScope(): KnowledgeScope {
  return useAuthStore((state) => (state.user?.role === 'admin' ? 'admin' : 'counselor'));
}

export const aiKeys = {
  /** The prefix every knowledge query lives under, so one invalidation still clears them all. */
  knowledgeDocuments: (scope: KnowledgeScope) => [scope, 'knowledge-documents'] as const,
  knowledgeDocumentList: (scope: KnowledgeScope, query: KnowledgeListQuery) =>
    [scope, 'knowledge-documents', 'list', query] as const,
  knowledgeEntryContent: (scope: KnowledgeScope, id: string) =>
    [scope, 'knowledge-documents', 'content', id] as const,
  policies: ['admin', 'ai-policies'] as const,
  /**
   * The prefix every part of the AI-gaps report lives under.
   *
   * **Load-bearing.** The report is five queries now — a header and one per tab — and the
   * mutations that change it (`useDismissQuestion`, `useReopenQuestion`, and every knowledge write
   * that resolves a backlog item) invalidate this one key. Anything hung off a different prefix
   * would go stale the moment somebody answered a question: the row would vanish from the
   * unanswered tab and never appear on the resolved one.
   */
  insights: (scope: KnowledgeScope) => [scope, 'ai-insights'] as const,
  insightsUnanswered: (scope: KnowledgeScope, page: number) =>
    [scope, 'ai-insights', 'unanswered', page] as const,
  insightsResolved: (scope: KnowledgeScope, page: number) =>
    [scope, 'ai-insights', 'resolved', page] as const,
  insightsFlagged: (scope: KnowledgeScope) => [scope, 'ai-insights', 'flagged'] as const,
  insightsCoverage: (scope: KnowledgeScope) => [scope, 'ai-insights', 'coverage'] as const,
};

/**
 * The report header — corpus health, the tab badges, and what this caller may do.
 *
 * Not polled: it summarises what has already happened, and a screen that refreshes itself while
 * somebody is reading a question they are about to answer is a screen that moves under their hands.
 */
export function useAiInsights() {
  const scope = useKnowledgeScope();

  return useQuery({
    queryKey: aiKeys.insights(scope),
    queryFn: () => aiApi.aiInsights(scope),
  });
}

/**
 * One page of the backlog.
 *
 * `keepPreviousData` is what makes the pager feel like paging rather than reloading: without it the
 * list collapses to a spinner on every Next, under the cursor of somebody reading it.
 */
export function useUnansweredQuestions(page: number) {
  const scope = useKnowledgeScope();

  return useQuery({
    queryKey: aiKeys.insightsUnanswered(scope, page),
    queryFn: () => aiApi.unansweredQuestions(scope, page),
    placeholderData: keepPreviousData,
  });
}

export function useResolvedQuestions(page: number) {
  const scope = useKnowledgeScope();

  return useQuery({
    queryKey: aiKeys.insightsResolved(scope, page),
    queryFn: () => aiApi.resolvedQuestions(scope, page),
    placeholderData: keepPreviousData,
  });
}

/**
 * The two tabs that are fetched only when opened.
 *
 * `enabled` is the whole point of splitting the endpoints: catalog coverage runs a scan over every
 * career and program, and flagged answers a correlated subquery per row. Neither should run to
 * render the backlog, which is what the reader came for nine visits out of ten.
 */
export function useFlaggedAnswers({ enabled }: { enabled: boolean }) {
  const scope = useKnowledgeScope();

  return useQuery({
    queryKey: aiKeys.insightsFlagged(scope),
    queryFn: () => aiApi.flaggedAnswers(scope),
    enabled,
  });
}

export function useCatalogCoverage({ enabled }: { enabled: boolean }) {
  const scope = useKnowledgeScope();

  return useQuery({
    queryKey: aiKeys.insightsCoverage(scope),
    queryFn: () => aiApi.catalogCoverage(scope),
    enabled,
  });
}

export function useKnowledgeDocuments(query: KnowledgeListQuery = {}) {
  const scope = useKnowledgeScope();

  return useQuery({
    queryKey: aiKeys.knowledgeDocumentList(scope, query),
    queryFn: () => aiApi.listKnowledgeDocuments(scope, query),
    placeholderData: keepPreviousData,
    // Processing is asynchronous (a queue job, §33) — poll while anything is in flight so
    // the list shows UPLOADED → PROCESSING → COMPLETED without mashing refresh.
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
  const scope = useKnowledgeScope();

  return useMutation({
    mutationFn: ({ file, extractedText }: { file: File; extractedText: string }) =>
      aiApi.uploadKnowledgeDocument(scope, file, extractedText),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: aiKeys.knowledgeDocuments(scope) });
      void queryClient.invalidateQueries({ queryKey: aiKeys.insights(scope) });
    },
  });
}

/**
 * Write an entry by hand (AiNormalisation Phase 1) — the path that does not require anyone to
 * already have a document.
 *
 * **Both caches are invalidated, and the insights one is not optional.** A payload carrying
 * `resolves_question` has just taken a row off the backlog server-side (migration 0031); leaving
 * the report cached would show the admin the question they just answered still sitting there,
 * which is indistinguishable from the bug that migration exists to fix. Half of "the backlog never
 * clears" was a stale query key.
 */
export function useCreateKnowledgeEntry() {
  const queryClient = useQueryClient();
  const scope = useKnowledgeScope();

  return useMutation({
    mutationFn: (payload: KnowledgeEntryPayload) => aiApi.createKnowledgeEntry(scope, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: aiKeys.knowledgeDocuments(scope) });
      void queryClient.invalidateQueries({ queryKey: aiKeys.insights(scope) });
    },
  });
}

/**
 * The entry's own text, loaded only when an edit form opens (`enabled`) — the list does not need
 * it, and an R2 read per row would make opening this page a great deal more expensive.
 */
export function useKnowledgeEntryContent(id: string | null) {
  const scope = useKnowledgeScope();

  return useQuery({
    queryKey: aiKeys.knowledgeEntryContent(scope, id ?? ''),
    queryFn: () => aiApi.knowledgeEntryContent(scope, id!),
    enabled: id !== null,
  });
}

export function useUpdateKnowledgeEntry(id: string) {
  const queryClient = useQueryClient();
  const scope = useKnowledgeScope();

  return useMutation({
    mutationFn: (payload: KnowledgeEntryPayload) => aiApi.updateKnowledgeEntry(scope, id, payload),
    onSuccess: () => {
      // Both the list (status went back to Queued) and this entry's cached text are now stale —
      // and so is the report, since an edit may also have resolved a backlog question.
      void queryClient.invalidateQueries({ queryKey: aiKeys.knowledgeDocuments(scope) });
      void queryClient.invalidateQueries({ queryKey: aiKeys.insights(scope) });
    },
  });
}

/** Regenerate every career and program entry now, instead of waiting for the 03:00 UTC cron. */
export function useSyncCatalogKnowledge() {
  const queryClient = useQueryClient();
  const scope = useKnowledgeScope();

  return useMutation({
    mutationFn: () => aiApi.syncCatalogKnowledge(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: aiKeys.knowledgeDocuments(scope) });
      void queryClient.invalidateQueries({ queryKey: aiKeys.insights(scope) });
    },
  });
}

/**
 * Archiving removes the entry's vectors from the index, which also lapses any resolution it was
 * the answer to — so the backlog it was keeping down grows again, and the report must be refetched
 * or the screen will disagree with the message the server just returned.
 */
export function useArchiveKnowledgeDocument() {
  const queryClient = useQueryClient();
  const scope = useKnowledgeScope();

  return useMutation({
    mutationFn: (id: string) => aiApi.archiveKnowledgeDocument(scope, id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: aiKeys.knowledgeDocuments(scope) });
      void queryClient.invalidateQueries({ queryKey: aiKeys.insights(scope) });
    },
  });
}

/**
 * Destroy an archived entry.
 *
 * Invalidates the insights report as well as the list, and that is not housekeeping: the questions
 * this entry answered lose their answer, so they reappear on the unanswered backlog. A stale report
 * would show them as still handled.
 */
export function useRemoveKnowledgeDocument() {
  const queryClient = useQueryClient();
  const scope = useKnowledgeScope();

  return useMutation({
    mutationFn: (id: string) => aiApi.removeKnowledgeDocument(scope, id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: aiKeys.knowledgeDocuments(scope) });
      void queryClient.invalidateQueries({ queryKey: aiKeys.insights(scope) });
    },
  });
}

export function useReprocessKnowledgeDocument() {
  const queryClient = useQueryClient();
  const scope = useKnowledgeScope();

  return useMutation({
    mutationFn: (id: string) => aiApi.reprocessKnowledgeDocument(scope, id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: aiKeys.knowledgeDocuments(scope) });
      void queryClient.invalidateQueries({ queryKey: aiKeys.insights(scope) });
    },
  });
}

export function useUnarchiveKnowledgeDocument() {
  const queryClient = useQueryClient();
  const scope = useKnowledgeScope();

  return useMutation({
    mutationFn: (id: string) => aiApi.unarchiveKnowledgeDocument(scope, id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: aiKeys.knowledgeDocuments(scope) });
      void queryClient.invalidateQueries({ queryKey: aiKeys.insights(scope) });
    },
  });
}

/** Dismiss a question nobody will ever write an entry for (migration 0031). Admin-only. */
export function useDismissQuestion() {
  const queryClient = useQueryClient();
  const scope = useKnowledgeScope();

  return useMutation({
    mutationFn: (question: string) => aiApi.dismissQuestion(question),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: aiKeys.insights(scope) });
    },
  });
}

/** Put a resolved question back on the backlog — the undo for answering and dismissing alike. */
export function useReopenQuestion() {
  const queryClient = useQueryClient();
  const scope = useKnowledgeScope();

  return useMutation({
    mutationFn: (resolutionId: string) => aiApi.reopenQuestion(scope, resolutionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: aiKeys.insights(scope) });
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

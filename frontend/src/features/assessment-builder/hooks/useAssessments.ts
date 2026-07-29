import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { assessmentAdminApi } from '@/services/assessmentAdminApi';
import type {
  AssessmentFormPayload,
  AssessmentListQuery,
  AssignPayload,
} from '@/types/assessmentAdmin';

/**
 * Assessment management hooks (FULLPLAN §36). Components call these; these call the service layer.
 *
 * **The two lookups are cached differently from the list, on purpose.** The taxonomy is curated
 * reference data that changes only when a migration ships, so it is fetched once and kept — the
 * create/edit form reads it on every keystroke to filter its scoring options, and re-fetching that
 * would be a request per interaction. The list is the opposite: its key carries the whole query
 * (search, filters, sort, page), so paginating fetches independently and every mutation below
 * invalidates the entire `['assessments', 'list']` branch rather than guessing which page moved.
 */

export const assessmentKeys = {
  types: () => ['assessments', 'types'] as const,
  scorings: () => ['assessments', 'scorings'] as const,
  list: (query: AssessmentListQuery = {}) => ['assessments', 'list', query] as const,
};

/** Reference data: fetched once per session and reused by every form that opens. */
const REFERENCE_DATA = {
  staleTime: Infinity,
  gcTime: Infinity,
} as const;

export function useAssessmentTypes() {
  return useQuery({
    queryKey: assessmentKeys.types(),
    queryFn: () => assessmentAdminApi.listTypes(),
    ...REFERENCE_DATA,
  });
}

export function useAssessmentScorings() {
  return useQuery({
    queryKey: assessmentKeys.scorings(),
    queryFn: () => assessmentAdminApi.listScorings(),
    ...REFERENCE_DATA,
  });
}

export function useAssessments(query: AssessmentListQuery = {}) {
  return useQuery({
    queryKey: assessmentKeys.list(query),
    queryFn: () => assessmentAdminApi.list(query),
    /**
     * Keep the previous page on screen while the next one loads. Without it, every keystroke in the
     * search box unmounts the table and replaces it with a spinner, which reads as the results
     * having vanished. The table dims itself via `isFetching` instead.
     */
    placeholderData: (previous) => previous,
  });
}

/** Every write invalidates the whole list branch — a create or a rename can move a row to any page. */
function useInvalidateList() {
  const queryClient = useQueryClient();

  return () => {
    void queryClient.invalidateQueries({ queryKey: ['assessments', 'list'] });
    // The same rows are read through two other endpoints — the builder's working view and the
    // counselor's assignable-instrument picker — and a rename or an archive changes both.
    void queryClient.invalidateQueries({ queryKey: ['builder'] });
    void queryClient.invalidateQueries({ queryKey: ['assessment-templates'] });
  };
}

export function useCreateAssessment() {
  const invalidate = useInvalidateList();

  return useMutation({
    mutationFn: (payload: AssessmentFormPayload) => assessmentAdminApi.create(payload),
    onSuccess: invalidate,
  });
}

export interface UpdateAssessmentArgs {
  id: string;
  payload: AssessmentFormPayload;
}

export function useUpdateAssessment() {
  const invalidate = useInvalidateList();

  return useMutation({
    mutationFn: ({ id, payload }: UpdateAssessmentArgs) => assessmentAdminApi.update(id, payload),
    onSuccess: invalidate,
  });
}

export function useArchiveAssessment() {
  const invalidate = useInvalidateList();

  return useMutation({
    mutationFn: (id: string) => assessmentAdminApi.archive(id),
    onSuccess: invalidate,
  });
}

export function useRestoreAssessment() {
  const invalidate = useInvalidateList();

  return useMutation({
    mutationFn: (id: string) => assessmentAdminApi.restore(id),
    onSuccess: invalidate,
  });
}

/**
 * Delete — soft on the server, and refused with a reason when the assessment has student responses
 * or open assignments. The row leaves every list, so the whole branch is invalidated.
 */
export function useDeleteAssessment() {
  const invalidate = useInvalidateList();

  return useMutation({
    mutationFn: (id: string) => assessmentAdminApi.remove(id),
    onSuccess: invalidate,
  });
}

/**
 * The confirmation dialog's live re-check.
 *
 * `enabled` on an open dialog and `staleTime: 0`, because the whole point is to catch the case the
 * list row cannot: a class starting the assessment while the dialog sat open. Caching this would
 * defeat it.
 */
export function useAssessmentDeletability(id: string | null) {
  return useQuery({
    queryKey: ['assessments', 'deletability', id] as const,
    queryFn: () => assessmentAdminApi.deletability(id!),
    enabled: id !== null,
    staleTime: 0,
    gcTime: 0,
  });
}

export interface AssignAssessmentArgs {
  id: string;
  payload: AssignPayload;
}

export function useAssignAssessment() {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateList();

  return useMutation({
    mutationFn: ({ id, payload }: AssignAssessmentArgs) => assessmentAdminApi.assign(id, payload),
    onSuccess: () => {
      invalidate();
      // A global assignment lands in *every* class, so every class's assignment panel is stale —
      // which one is impossible to name, so the whole `['classes', …]` branch goes.
      void queryClient.invalidateQueries({ queryKey: ['classes'] });
    },
  });
}

/**
 * Install RIASEC and SCCT (audit F1) — admin only.
 *
 * Invalidates the list on success for both outcomes, not just `created: true`. If the instruments
 * turned out to already exist, the list this admin is looking at was evidently missing them, so a
 * refetch is exactly the right response — it is how they find out the state is not what the screen
 * showed. Nothing else in the cache is touched: seeding creates templates and versions, and no
 * class, roster or attempt query can be affected by it.
 */
export function useSeedInstruments() {
  const invalidate = useInvalidateList();

  return useMutation({
    mutationFn: () => assessmentAdminApi.seedInstruments(),
    onSuccess: invalidate,
  });
}

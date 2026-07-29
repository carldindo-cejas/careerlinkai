import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  catalogApi,
  type CanonicalProgramListQuery,
  type CatalogListQuery,
} from '@/services/catalogApi';
import type {
  CreateCanonicalProgramPayload,
  CreateCareerPayload,
  CreateCollegePayload,
  CreateProgramPayload,
  UpdateCanonicalProgramPayload,
  UpdateCareerPayload,
  UpdateCollegePayload,
  UpdateProgramPayload,
} from '@/types/catalog';

/**
 * Catalog hooks (FULLPLAN §36). Components call these; these call services/catalogApi.
 */

/**
 * The query is **part of the key** on every list (audit F3/F4), so two searches are two cache
 * entries rather than one that overwrites the other. The bare `colleges` / `careers` prefixes stay
 * exactly as they were, which is what keeps every existing `invalidateQueries` call correct: a
 * prefix match invalidates every query built under it, whatever its filter.
 */
export const catalogKeys = {
  colleges: ['colleges'] as const,
  collegeList: (query: CatalogListQuery) => ['colleges', 'list', query] as const,
  college: (id: string) => ['colleges', id] as const,
  careers: ['careers'] as const,
  careerList: (query: CatalogListQuery) => ['careers', 'list', query] as const,
  employmentOutlooks: ['employment-outlooks'] as const,
  canonicalPrograms: ['canonical-programs'] as const,
  canonicalProgramList: (query: CanonicalProgramListQuery) =>
    ['canonical-programs', 'list', query] as const,
  canonicalProgramOptions: ['canonical-programs', 'options'] as const,
  canonicalProgramColleges: (id: string) => ['canonical-programs', id, 'colleges'] as const,
};

// --- The canonical program catalog (migration 0018) ------------------------------------------

export function useCanonicalPrograms(query: CanonicalProgramListQuery = {}) {
  return useQuery({
    queryKey: catalogKeys.canonicalProgramList(query),
    queryFn: () => catalogApi.listCanonicalPrograms(query),
    placeholderData: keepPreviousData,
  });
}

/**
 * The canonical-entry typeahead, used by the merge target picker.
 *
 * `enabled` keeps it from firing until a merge panel is actually open — the same on-open rather
 * than on-mount rule the careers picker follows. No `staleTime`: the previous version cached for
 * five minutes as "reference data", which is wrong for a list whose whole purpose is to be
 * searched, and doubly wrong in front of a merge that changes the list it is reading.
 */
/** Mirrors `CANONICAL_OPTION_LIMIT` on the server — the picker says when it is truncating. */
export const CANONICAL_OPTION_LIMIT = 20;

export function useCanonicalProgramOptions(search: string, enabled: boolean) {
  const term = search.trim() === '' ? undefined : search.trim();

  return useQuery({
    queryKey: [...catalogKeys.canonicalProgramOptions, term ?? ''] as const,
    queryFn: () => catalogApi.canonicalProgramOptions(term),
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useCanonicalProgramColleges(id: string, enabled: boolean) {
  return useQuery({
    queryKey: catalogKeys.canonicalProgramColleges(id),
    queryFn: () => catalogApi.canonicalProgramColleges(id),
    enabled,
  });
}

export function useCreateCanonicalProgram() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: CreateCanonicalProgramPayload) =>
      catalogApi.createCanonicalProgram(payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: catalogKeys.canonicalPrograms });
    },
  });
}

export function useUpdateCanonicalProgram() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateCanonicalProgramPayload }) =>
      catalogApi.updateCanonicalProgram(id, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: catalogKeys.canonicalPrograms });
    },
  });
}

/**
 * Merging re-points every offering that named the absorbed entry, so the college lists and the
 * program rows both move. Invalidate broadly rather than surgically — this is a rare, deliberate
 * admin act, and a stale card here is a wrong answer to "which colleges offer this?".
 */
export function useMergeCanonicalPrograms() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, targetId }: { id: string; targetId: string }) =>
      catalogApi.mergeCanonicalPrograms(id, targetId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: catalogKeys.canonicalPrograms });
      void queryClient.invalidateQueries({ queryKey: catalogKeys.colleges });
    },
  });
}

/**
 * The employment-outlook lookup (backend migration 0013). Reference data with a long stale time —
 * the four values do not change while an admin is filling in a career form.
 */
export function useEmploymentOutlooks() {
  return useQuery({
    queryKey: catalogKeys.employmentOutlooks,
    queryFn: () => catalogApi.listEmploymentOutlooks(),
    staleTime: 60 * 60 * 1000,
  });
}

// Colleges -----------------------------------------------------------------

/**
 * `keepPreviousData` on all three lists: typing into a search box changes the key on every
 * debounce, and without it the list unmounts to a spinner between each one — the rows flash out
 * and back, which reads as the page reloading rather than as a filter narrowing. The previous page
 * stays on screen, dimmed by `isFetching`, until the new one lands.
 */
export function useColleges(query: CatalogListQuery = {}) {
  return useQuery({
    queryKey: catalogKeys.collegeList(query),
    queryFn: () => catalogApi.listColleges(query),
    placeholderData: keepPreviousData,
  });
}

export function useCollege(id: string) {
  return useQuery({
    queryKey: catalogKeys.college(id),
    queryFn: () => catalogApi.getCollege(id),
  });
}

export function useCreateCollege() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: CreateCollegePayload) => catalogApi.createCollege(payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: catalogKeys.colleges });
    },
  });
}

export function useUpdateCollege(id: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: UpdateCollegePayload) => catalogApi.updateCollege(id, payload),
    onSuccess: () => {
      // Not setQueryData: the PATCH response carries the college without its nested
      // programs, and writing it into the detail cache would blank the program list the
      // admin is looking at.
      void queryClient.invalidateQueries({ queryKey: catalogKeys.college(id) });
      void queryClient.invalidateQueries({ queryKey: catalogKeys.colleges });
    },
  });
}

export function useDeleteCollege() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => catalogApi.removeCollege(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: catalogKeys.colleges });
    },
  });
}

// Programs -----------------------------------------------------------------

/**
 * Every program mutation invalidates its *college*, not a program cache of its own —
 * programs are only ever read through the nested college view (§20), so that is the thing
 * that has gone stale.
 */
export function useCreateProgram(collegeId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: CreateProgramPayload) => catalogApi.createProgram(collegeId, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: catalogKeys.college(collegeId) });
      void queryClient.invalidateQueries({ queryKey: catalogKeys.colleges });
    },
  });
}

export function useUpdateProgram(collegeId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateProgramPayload }) =>
      catalogApi.updateProgram(id, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: catalogKeys.college(collegeId) });
    },
  });
}

export function useDeleteProgram(collegeId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => catalogApi.removeProgram(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: catalogKeys.college(collegeId) });
      void queryClient.invalidateQueries({ queryKey: catalogKeys.colleges });
    },
  });
}

// Careers ------------------------------------------------------------------

export function useCareers(query: CatalogListQuery = {}) {
  return useQuery({
    queryKey: catalogKeys.careerList(query),
    queryFn: () => catalogApi.listCareers(query),
    placeholderData: keepPreviousData,
  });
}

/**
 * The mapping picker's source (audit F3) — a **server-backed typeahead**, not a filter over a
 * preloaded catalog.
 *
 * `enabled` is what stops every program row on a college page firing its own request on mount: the
 * query runs when a picker is opened, not when one is rendered. That is the same shape
 * `useStudentRecommendations` uses on the counselor panel, and for the same reason.
 *
 * `status: 'active'` is server-side rather than a `.filter()` on the way out. An archived career
 * cannot be linked (§8, §27 — the server refuses, and it would score nothing if it did not), so
 * filtering it here would spend slots of a 20-row page on options that can only fail.
 */
export function useCareerSearch(search: string, enabled: boolean) {
  const query: CatalogListQuery = {
    search: search.trim() === '' ? undefined : search.trim(),
    status: 'active',
    per_page: CAREER_PICKER_PAGE_SIZE,
  };

  return useQuery({
    queryKey: catalogKeys.careerList(query),
    queryFn: () => catalogApi.listCareers(query),
    enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * How many careers the picker shows at once. Small on purpose: this is a list to be *narrowed by
 * typing*, and a picker that returns 100 rows has invited the user to scroll instead — which is
 * the habit that made F3 invisible for as long as it was.
 */
export const CAREER_PICKER_PAGE_SIZE = 20;

export function useCreateCareer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: CreateCareerPayload) => catalogApi.createCareer(payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: catalogKeys.careers });
    },
  });
}

export function useUpdateCareer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateCareerPayload }) =>
      catalogApi.updateCareer(id, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: catalogKeys.careers });
      // A career's title and Holland code are rendered inside the mapping on every college
      // page, so editing one here goes stale over there.
      void queryClient.invalidateQueries({ queryKey: catalogKeys.colleges });
    },
  });
}

export function useDeleteCareer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => catalogApi.removeCareer(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: catalogKeys.careers });
      void queryClient.invalidateQueries({ queryKey: catalogKeys.colleges });
    },
  });
}

// The mapping --------------------------------------------------------------

/**
 * Attach and detach both return the updated program with its careers, but the cache the
 * screen actually reads is the *college*, so that is what gets invalidated.
 */
export function useAttachCareer(collegeId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ programId, careerId }: { programId: string; careerId: string }) =>
      catalogApi.attachCareer(programId, careerId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: catalogKeys.college(collegeId) });
    },
  });
}

export function useDetachCareer(collegeId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ programId, careerId }: { programId: string; careerId: string }) =>
      catalogApi.detachCareer(programId, careerId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: catalogKeys.college(collegeId) });
    },
  });
}

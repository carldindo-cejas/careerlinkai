import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { catalogApi } from '@/services/catalogApi';
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

export const catalogKeys = {
  colleges: ['colleges'] as const,
  college: (id: string) => ['colleges', id] as const,
  careers: ['careers'] as const,
  employmentOutlooks: ['employment-outlooks'] as const,
  canonicalPrograms: ['canonical-programs'] as const,
  canonicalProgramOptions: ['canonical-programs', 'options'] as const,
  canonicalProgramColleges: (id: string) => ['canonical-programs', id, 'colleges'] as const,
};

// --- The canonical program catalog (migration 0018) ------------------------------------------

export function useCanonicalPrograms(page = 1) {
  return useQuery({
    queryKey: [...catalogKeys.canonicalPrograms, page],
    queryFn: () => catalogApi.listCanonicalPrograms(page),
  });
}

/** The program form's picker. Reference data by the time an admin is filling in a form. */
export function useCanonicalProgramOptions() {
  return useQuery({
    queryKey: catalogKeys.canonicalProgramOptions,
    queryFn: () => catalogApi.canonicalProgramOptions(),
    staleTime: 5 * 60 * 1000,
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

export function useColleges() {
  return useQuery({
    queryKey: catalogKeys.colleges,
    queryFn: () => catalogApi.listColleges(),
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

export function useCareers() {
  return useQuery({
    queryKey: catalogKeys.careers,
    queryFn: () => catalogApi.listCareers(),
  });
}

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

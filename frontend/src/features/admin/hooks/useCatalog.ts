import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { catalogApi } from '@/services/catalogApi';
import type {
  CreateCareerPayload,
  CreateCollegePayload,
  CreateProgramPayload,
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
};

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

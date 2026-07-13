import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { counselorAssessmentApi } from '@/services/assessmentApi';

/**
 * Counselor assignment hooks (FULLPLAN §36).
 */

export const assignmentKeys = {
  templates: ['assessment-templates'] as const,
  forClass: (classId: string) => ['classes', classId, 'assignments'] as const,
  resultsForClass: (classId: string) => ['classes', classId, 'results'] as const,
};

export function useAssessmentTemplates() {
  return useQuery({
    queryKey: assignmentKeys.templates,
    queryFn: () => counselorAssessmentApi.listTemplates(),

    // The instrument catalog is seeded content that changes about once a year. Refetching it on
    // every focus is noise.
    staleTime: 5 * 60 * 1000,
  });
}

export function useClassAssignments(classId: string) {
  return useQuery({
    queryKey: assignmentKeys.forClass(classId),
    queryFn: () => counselorAssessmentApi.listAssignments(classId),
  });
}

export function useAssignAssessment(classId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ versionId, deadline }: { versionId: string; deadline?: string | null }) =>
      counselorAssessmentApi.assign(classId, versionId, deadline),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: assignmentKeys.forClass(classId) });
    },
  });
}

/**
 * Closing expires every attempt still in progress underneath it (§21), so the class results
 * change too — both caches are invalidated, not just the assignment list.
 */
export function useCloseAssignment(classId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (assignmentId: string) => counselorAssessmentApi.close(assignmentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: assignmentKeys.forClass(classId) });
      void queryClient.invalidateQueries({ queryKey: assignmentKeys.resultsForClass(classId) });
    },
  });
}

export function useClassResults(classId: string) {
  return useQuery({
    queryKey: assignmentKeys.resultsForClass(classId),
    queryFn: () => counselorAssessmentApi.listClassResults(classId),
  });
}

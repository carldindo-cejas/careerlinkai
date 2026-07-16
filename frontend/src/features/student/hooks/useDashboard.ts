import { useQuery } from '@tanstack/react-query';

import { platformApi } from '@/services/platformApi';

/** Phase 6: the live student dashboard aggregates (FULLPLAN §20, §54). */
export function useStudentDashboard() {
  return useQuery({
    queryKey: ['student', 'dashboard'],
    queryFn: () => platformApi.studentDashboard(),
  });
}

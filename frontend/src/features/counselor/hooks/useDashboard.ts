import { useQuery } from '@tanstack/react-query';

import { platformApi } from '@/services/platformApi';

/** Phase 6: the live counselor dashboard (FULLPLAN §20, §54). */
export function useCounselorDashboard() {
  return useQuery({
    queryKey: ['counselor', 'dashboard'],
    queryFn: () => platformApi.counselorDashboard(),
  });
}

import { useQuery } from '@tanstack/react-query';

import { demoInstead, useTourDemo } from '@/features/student/tour/demoMode';
import { platformApi } from '@/services/platformApi';

/**
 * Phase 6: the live student dashboard aggregates (FULLPLAN §20, §54).
 *
 * Also the query the tour decides on: `recommendations_ready` is the one flag that says a student
 * has finished everything, and it is what `StudentTour` reads before standing the example student
 * in for an empty screen. That makes the substitution below look circular and is not — the
 * decision is taken once, from the real answer, before anything is substituted.
 */
export function useStudentDashboard() {
  const query = useQuery({
    queryKey: ['student', 'dashboard'],
    queryFn: () => platformApi.studentDashboard(),
  });

  return demoInstead(query, useTourDemo()?.dashboard);
}

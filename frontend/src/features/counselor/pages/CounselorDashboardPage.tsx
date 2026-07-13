import { ArrowRight, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useClasses } from '@/features/counselor/hooks/useClasses';
import { paths } from '@/routes/paths';
import { useAuthStore } from '@/stores/authStore';

/**
 * Counselor dashboard (FULLPLAN §57).
 *
 * Assignments and results arrive in Phase 3. Today this is a way into the classes.
 */
export function CounselorDashboardPage() {
  const user = useAuthStore((state) => state.user);
  const profile = user?.counselor_profile;

  const { data, isPending } = useClasses();

  const classCount = data?.pagination.total ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">
          Welcome back,{' '}
          {profile ? `${profile.first_name} ${profile.last_name}` : (user?.name ?? 'Counselor')}
        </h1>
        <p className="text-sm text-slate-500">Counselor dashboard</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Classes</CardTitle>
          <CardDescription>
            {isPending
              ? 'Counting your classes…'
              : classCount === 0
                ? 'You have no classes yet. Create one to get a class code for your students.'
                : `You have ${classCount} ${classCount === 1 ? 'class' : 'classes'}.`}
          </CardDescription>
        </CardHeader>

        <CardContent>
          {isPending ? (
            <Loader2 className="size-5 animate-spin text-slate-400" aria-hidden="true" />
          ) : (
            <Link
              to={paths.counselorClasses}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-900 hover:underline"
            >
              {classCount === 0 ? 'Create a class' : 'Go to classes'}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

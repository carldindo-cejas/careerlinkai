import { GraduationCap, Loader2, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CollegeForm } from '@/features/admin/components/CollegeForm';
import { useColleges } from '@/features/admin/hooks/useCatalog';
import { collegeDetailPath } from '@/routes/paths';
import type { College } from '@/types/catalog';

/**
 * The colleges in the catalog (FULLPLAN §57, Phase 2).
 */
export function CollegeListPage() {
  const [isAdding, setIsAdding] = useState(false);
  const navigate = useNavigate();

  const { data, isPending, isError, error } = useColleges();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Colleges</h1>
          <p className="text-sm text-slate-500">
            The institutions students can be recommended to, and the programs each one offers.
          </p>
        </div>

        {!isAdding ? (
          <Button onClick={() => setIsAdding(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Add college
          </Button>
        ) : null}
      </div>

      {isAdding ? (
        <CollegeForm
          onCancel={() => setIsAdding(false)}
          // Straight to the new college: adding its programs is the next thing the admin
          // actually does, and that happens on the college's own page (§57).
          onCreated={(created) => {
            setIsAdding(false);
            void navigate(collegeDetailPath(created.id));
          }}
        />
      ) : null}

      {isPending ? (
        <div className="flex justify-center py-12" role="status">
          <Loader2 className="size-6 animate-spin text-slate-400" aria-hidden="true" />
          <span className="sr-only">Loading colleges…</span>
        </div>
      ) : null}

      {isError ? <Alert>{error.message}</Alert> : null}

      {data && data.items.length === 0 && !isAdding ? (
        <Card>
          <CardHeader>
            <CardTitle>The catalog is empty</CardTitle>
            <CardDescription>
              Add a college to start building the catalog. Recommendations are drawn from it,
              so nothing can be recommended until it has something in it.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {data && data.items.length > 0 ? (
        <ul className="grid gap-4 sm:grid-cols-2">
          {data.items.map((college) => (
            <li key={college.id}>
              <CollegeCard college={college} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function CollegeCard({ college }: { college: College }) {
  const programCount = college.programs_count ?? 0;

  return (
    <Card className="h-full transition-colors hover:border-slate-300">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle>
            <Link
              to={collegeDetailPath(college.id)}
              className="hover:underline focus-visible:underline focus-visible:outline-none"
            >
              {college.name}
            </Link>
          </CardTitle>
          <Badge tone={college.status === 'active' ? 'success' : 'neutral'}>{college.status}</Badge>
        </div>
        {college.description ? <CardDescription>{college.description}</CardDescription> : null}
      </CardHeader>

      <CardContent>
        <Link
          to={collegeDetailPath(college.id)}
          className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900"
        >
          <GraduationCap className="size-4" aria-hidden="true" />
          {programCount === 0
            ? 'No programs yet'
            : `${programCount} ${programCount === 1 ? 'program' : 'programs'}`}
        </Link>
      </CardContent>
    </Card>
  );
}

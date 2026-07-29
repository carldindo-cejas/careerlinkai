import { GraduationCap, Loader2, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/components/ui/cn';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { Select } from '@/components/ui/select';
import { CollegeForm } from '@/features/admin/components/CollegeForm';
import { useColleges } from '@/features/admin/hooks/useCatalog';
import { useListFilters } from '@/hooks/useListFilters';
import { collegeDetailPath } from '@/routes/paths';
import type { CatalogListQuery } from '@/services/catalogApi';
import type { College } from '@/types/catalog';

/** One screen of colleges. */
const PER_PAGE = 20;

/**
 * The colleges in the catalog (FULLPLAN §57, Phase 2).
 *
 * **This page had no pager and no search until P3-2**, and the API's default page is 20 — which is
 * exactly how many colleges seed 0004 installs. So it was showing 20 of 20 and looking complete, one
 * added institution away from hiding one with nothing on screen to say so. That is audit F4, and it
 * is the same shape as F3 on the careers picker: a list that fits today and lies tomorrow.
 */
export function CollegeListPage() {
  const [isAdding, setIsAdding] = useState(false);
  const navigate = useNavigate();

  const filters = useListFilters<'active' | 'archived'>();

  const query = useMemo<CatalogListQuery>(
    () => ({
      search: filters.search,
      status: filters.status === '' ? undefined : filters.status,
      page: filters.page,
      per_page: PER_PAGE,
    }),
    [filters.search, filters.status, filters.page],
  );

  const { data, isPending, isFetching, isError, error } = useColleges(query);

  const isFiltered = filters.search !== undefined || filters.status !== '';

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Colleges</h1>
          <p className="text-sm text-muted-foreground">
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

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          value={filters.searchInput}
          onChange={filters.setSearchInput}
          label="Search colleges"
          placeholder="Search colleges…"
        />

        <Select
          value={filters.status}
          onChange={(event) => filters.setStatus(event.target.value as 'active' | 'archived' | '')}
          aria-label="Filter by status"
          className="w-auto"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="archived">Archived</option>
        </Select>
      </div>

      {isPending ? (
        <div className="flex justify-center py-12" role="status">
          <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
          <span className="sr-only">Loading colleges…</span>
        </div>
      ) : null}

      {isError ? <Alert>{error.message}</Alert> : null}

      {data && data.items.length === 0 && !isAdding ? (
        <Card>
          <CardHeader>
            {isFiltered ? (
              <>
                <CardTitle>No matching colleges</CardTitle>
                <CardDescription>
                  Nothing matches{' '}
                  {filters.search ? <strong>“{filters.search}”</strong> : 'this filter'}. Try a
                  different term, or clear the filters.
                </CardDescription>
              </>
            ) : (
              <>
                <CardTitle>The catalog is empty</CardTitle>
                <CardDescription>
                  Add a college to start building the catalog. Recommendations are drawn from it,
                  so nothing can be recommended until it has something in it.
                </CardDescription>
              </>
            )}
          </CardHeader>
        </Card>
      ) : null}

      {data && data.items.length > 0 ? (
        <ul
          className={cn(
            'grid gap-4 sm:grid-cols-2',
            isFetching && 'opacity-60 transition-opacity',
          )}
        >
          {data.items.map((college) => (
            <li key={college.id}>
              <CollegeCard college={college} />
            </li>
          ))}
        </ul>
      ) : null}

      {data ? (
        <Pagination
          pagination={data.pagination}
          onPageChange={filters.setPage}
          noun="colleges"
          isFetching={isFetching}
        />
      ) : null}
    </div>
  );
}

function CollegeCard({ college }: { college: College }) {
  const programCount = college.programs_count ?? 0;

  return (
    <Card className="h-full transition-colors hover:border-primary">
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
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
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

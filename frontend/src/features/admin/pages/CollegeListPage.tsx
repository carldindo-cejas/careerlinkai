import { GraduationCap, Loader2, Plus, Trash2 } from 'lucide-react';
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
import { useColleges, useDeleteCollege } from '@/features/admin/hooks/useCatalog';
import { useListFilters } from '@/hooks/useListFilters';
import { collegeDetailPath } from '@/routes/paths';
import type { CatalogListQuery } from '@/services/catalogApi';
import { toast } from '@/stores/toastStore';
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

/**
 * One college in the grid.
 *
 * ## The whole box opens it, not just the name
 *
 * There used to be two links on this card — the title and the program count — and a card-sized
 * area between them that looked exactly as clickable and did nothing. An admin working through a
 * list of twenty campuses hits that dead zone constantly, and "it only works if you hit the words"
 * is not a thing anyone should have to learn about a list of boxes.
 *
 * It is done with one **stretched link** rather than an `onClick` on the card, and that is the
 * whole reason this is worth a comment: the anchor is still a real anchor, so it keeps its href,
 * its middle-click, its right-click "open in new tab", its focus ring and its place in the tab
 * order. A div with a click handler has none of those and has to fake every one of them badly.
 * The overlay is `absolute inset-0`, and the card is already `relative`.
 *
 * Everything that must stay clickable on top of it — the delete button — needs a stacking context
 * of its own (`relative z-10`), because the overlay covers the card edge to edge.
 */
function CollegeCard({ college }: { college: College }) {
  const programCount = college.programs_count ?? 0;
  const deleteCollege = useDeleteCollege();

  return (
    <Card className="group h-full transition-colors hover:border-primary focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1">
      {/*
        The stretched link. `aria-label` rather than the visible name because the name is already
        on the card as a heading — without it a screen reader announces the whole card's text as
        the link, and with plain "college.name" it would announce the name twice in a row.

        Its own outline is suppressed because a ring drawn on a full-bleed overlay traces the card
        twice over; the *card* takes the focus ring instead (`focus-within` above), which is the
        shape a keyboard user is actually about to activate.
      */}
      <Link
        to={collegeDetailPath(college.id)}
        aria-label={`Open ${college.name}`}
        className="absolute inset-0 z-0 rounded-none focus-visible:outline-none"
      />

      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="group-hover:underline">{college.name}</CardTitle>

          <div className="flex items-center gap-1">
            <Badge tone={college.status === 'active' ? 'success' : 'neutral'}>
              {college.status}
            </Badge>

            {/*
              Deleting from the list, not only from inside the college (§8).

              The wording is the detail page's, word for word, and deliberately so: archiving is
              the intended way to retire a college — the row and everything pointing at it
              survives, so a recommendation a student has already seen never dangles — and this is
              the harsher, rarer act. An admin who reaches for it from a grid, where there is no
              Archive button beside it, is the one most likely not to know that, so the confirm is
              where the choice gets offered.
            */}
            <Button
              variant="ghost"
              size="sm"
              className="relative z-10"
              loading={deleteCollege.isPending}
              aria-label={`Delete ${college.name}`}
              onClick={() => {
                if (
                  !window.confirm(
                    `Remove ${college.name} from the catalog? Its programs go with it. If you only want to stop recommending it, open it and archive it instead.`,
                  )
                ) {
                  return;
                }

                deleteCollege.mutate(college.id, {
                  onSuccess: () => toast.success(`${college.name} was removed from the catalog.`),
                  onError: (error) =>
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : `${college.name} could not be removed.`,
                    ),
                });
              }}
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
        {college.description ? <CardDescription>{college.description}</CardDescription> : null}
      </CardHeader>

      <CardContent>
        {/* Plain text now: the card itself is the link, and a link inside a link is not a thing. */}
        <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
          <GraduationCap className="size-4" aria-hidden="true" />
          {programCount === 0
            ? 'No programs yet'
            : `${programCount} ${programCount === 1 ? 'program' : 'programs'}`}
        </p>
      </CardContent>
    </Card>
  );
}

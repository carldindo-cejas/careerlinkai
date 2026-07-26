import { Loader2, MapPin } from 'lucide-react';
import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { CollegeCard } from '@/features/public/components/CollegeCard';
import {
  usePublicCollegeRegions,
  usePublicColleges,
} from '@/features/public/hooks/usePublicCatalog';

/**
 * The public Colleges page (prompt-driven, v1.5). Every registered college, filterable by region —
 * each card showing the institution's name, its school address, a preview of the programs it offers
 * (with "+N more…" for the rest), and a "View on Google Maps" button when a map link is on file.
 *
 * The region filter is server-side: choosing a region re-fetches the scoped list (cached per region).
 * The option list comes from the address tables, and only lists regions that actually have a college,
 * so the filter never offers a dead choice.
 */
export function CollegesPage() {
  const [regionId, setRegionId] = useState<string | null>(null);

  const regions = usePublicCollegeRegions();
  const colleges = usePublicColleges(regionId);

  const items = colleges.data ?? [];

  return (
    <div>
      {/* Header band on the steel canvas — title and the region filter. */}
      <section className="border-b border-sidebar-border">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
          <p className="mb-3 w-fit rounded-none border border-sidebar-border bg-sidebar-active/50 px-3 py-1 text-xs font-medium uppercase tracking-wide text-sidebar-foreground">
            Colleges
          </p>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Explore colleges and what they offer
          </h1>
          <p className="mt-3 max-w-2xl text-sidebar-foreground">
            Every institution in CareerLinkAI, with its location and programs. Filter by region to
            find the ones near you.
          </p>

          <div className="mt-6 flex max-w-xs flex-col gap-1.5">
            <Label htmlFor="region-filter" className="text-sidebar-foreground">
              Region
            </Label>
            <Select
              id="region-filter"
              value={regionId ?? ''}
              onChange={(event) => setRegionId(event.target.value === '' ? null : event.target.value)}
              className="border-sidebar-border bg-sidebar text-sidebar-active-foreground"
              disabled={regions.isPending}
            >
              <option value="">All regions</option>
              {(regions.data ?? []).map((region) => (
                <option key={region.id} value={region.id}>
                  {region.name}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </section>

      {/* Results on the paper canvas. */}
      <section className="bg-background text-foreground">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
          {colleges.isError ? (
            <Alert>We could not load the colleges. {colleges.error.message}</Alert>
          ) : null}

          {colleges.isPending ? (
            <div className="flex justify-center py-16" role="status">
              <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
              <span className="sr-only">Loading colleges…</span>
            </div>
          ) : null}

          {colleges.data && items.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <MapPin className="size-8 text-muted-foreground/60" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">
                {regionId
                  ? 'No colleges in this region yet. Try another region.'
                  : 'No colleges have been added yet. Check back soon.'}
              </p>
            </div>
          ) : null}

          {items.length > 0 ? (
            <>
              <p className="mb-6 text-sm text-muted-foreground">
                {items.length} {items.length === 1 ? 'college' : 'colleges'}
                {regionId ? ' in this region' : ''}
              </p>
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((college) => (
                  <CollegeCard key={college.id} college={college} />
                ))}
              </div>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}

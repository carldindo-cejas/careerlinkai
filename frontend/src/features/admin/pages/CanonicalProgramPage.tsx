import {
  ChevronDown,
  Download,
  GitMerge,
  Link2,
  Loader2,
  MapPin,
  Pencil,
  Plus,
  Upload,
  X,
} from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/components/ui/cn';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { Select } from '@/components/ui/select';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useListFilters } from '@/hooks/useListFilters';
import type { CanonicalProgramListQuery } from '@/services/catalogApi';
import { toast } from '@/stores/toastStore';
import { CanonicalCareerMapping } from '@/features/admin/components/CanonicalCareerMapping';
import { MappingImportPanel } from '@/features/admin/components/MappingImportPanel';
import {
  CANONICAL_OPTION_LIMIT,
  useCanonicalProgramColleges,
  useCanonicalProgramOptions,
  useCanonicalPrograms,
  useCreateCanonicalProgram,
  useExportMapping,
  useMergeCanonicalPrograms,
  useUpdateCanonicalProgram,
} from '@/features/admin/hooks/useCatalog';
import { ApiRequestError } from '@/types/api';
import { STRANDS, type CanonicalProgram, type Strand } from '@/types/catalog';

/**
 * The canonical program catalog (backend migration 0018).
 *
 * ## Why this screen exists
 *
 * `programs.college_id` is NOT NULL: a `programs` row *is* "this program, at this college". That is
 * the right model for the rest of the admin surface, but it leaves one student-facing question
 * unanswerable — **"which colleges offer BS Computer Science?"** — because UP Diliman's BSCS and
 * DLSU's BSCS share nothing but a string. `program_catalog` promotes that string to a row, so the
 * answer becomes a join.
 *
 * The 0018 migration backfilled one canonical entry per **normalized code**, which is a starting
 * point rather than an answer: where two colleges use one code for different programs, or two codes
 * for one, the grouping is wrong and a student sees the wrong list. This page is where that gets
 * fixed. Without it the FK would be a column nobody could correct — which is exactly why the
 * decision to add the table came with the decision to add this screen.
 *
 * ## Merge is the important control
 *
 * Editing a name is cosmetic. **Merge** re-points every college offering that named the absorbed
 * entry and retires it. It confirms first, and it is audited as its own action
 * (`CANONICAL_PROGRAM_MERGED`) rather than as an update, because the row it writes records how many
 * offerings moved — the only trace of a change nothing else logs.
 *
 * ## And this is where a program's careers live (backend migration 0040)
 *
 * What a program leads to used to be linked on each college's offering, one campus at a time. It is
 * now linked here, once, and every offering inherits it — which makes this page, not the college
 * pages, the place that decides which programs a student's RIASEC profile is matched to. The strand
 * works the same way, as a default: changing it here writes it to every offering.
 */
export function CanonicalProgramPage() {
  const [isAdding, setIsAdding] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [editing, setEditing] = useState<CanonicalProgram | null>(null);
  const exportMapping = useExportMapping();
  const [merging, setMerging] = useState<CanonicalProgram | null>(null);

  const filters = useListFilters<'active' | 'archived'>();
  const [sort, setSort] = useState<'name' | 'code' | 'created_at'>('name');

  const query = useMemo<CanonicalProgramListQuery>(
    () => ({
      search: filters.search,
      status: filters.status === '' ? undefined : filters.status,
      page: filters.page,
      sort,
      direction: sort === 'created_at' ? 'desc' : 'asc',
    }),
    [filters.search, filters.status, filters.page, sort],
  );

  const { data, isPending, isFetching, isError, error } = useCanonicalPrograms(query);

  const entries = data?.items ?? [];
  const isFiltered = filters.search !== undefined || filters.status !== '';

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h1 className="text-xl font-semibold text-foreground">Canonical programs</h1>
          <p className="text-sm text-muted-foreground">
            One entry per program as a thing in the world — &ldquo;BS Computer Science&rdquo; —
            of which each college&apos;s program is one offering. The careers linked here are what
            every offering of it is matched to a student&apos;s results on.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/*
            The mapping as a spreadsheet: export it (also the backup to take before a big change),
            edit it anywhere, import it back after a preview.
          */}
          <Button
            variant="secondary"
            loading={exportMapping.isPending}
            onClick={() =>
              exportMapping.mutate(undefined, {
                onSuccess: (count) => toast.success(`Exported ${count} links.`),
              })
            }
          >
            <Download className="size-4" aria-hidden="true" />
            Export CSV
          </Button>
          <Button variant="secondary" onClick={() => setIsImporting(true)}>
            <Upload className="size-4" aria-hidden="true" />
            Import CSV
          </Button>
          {!isAdding ? (
            <Button onClick={() => setIsAdding(true)}>
              <Plus className="size-4" aria-hidden="true" />
              Add canonical program
            </Button>
          ) : null}
        </div>
      </div>

      {isImporting ? <MappingImportPanel onDone={() => setIsImporting(false)} /> : null}

      <Alert tone="info">
        Link a career here once and every college offering the program leads to it. A college page
        can still add an extra career for that campus alone. Where two entries are really the same
        program, use <strong>Merge</strong>.
      </Alert>

      {isAdding ? <CanonicalForm onDone={() => setIsAdding(false)} /> : null}
      {editing ? <CanonicalForm entry={editing} onDone={() => setEditing(null)} /> : null}
      {merging ? (
        <MergePanel source={merging} onDone={() => setMerging(null)} />
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          value={filters.searchInput}
          onChange={filters.setSearchInput}
          label="Search canonical programs"
          placeholder="Search by name or code…"
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

        <Select
          value={sort}
          onChange={(event) => setSort(event.target.value as 'name' | 'code' | 'created_at')}
          aria-label="Sort canonical programs"
          className="w-auto"
        >
          <option value="name">By name</option>
          <option value="code">By code</option>
          <option value="created_at">Newest first</option>
        </Select>
      </div>

      {isPending ? (
        <div className="flex justify-center py-12" role="status">
          <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
          <span className="sr-only">Loading canonical programs…</span>
        </div>
      ) : null}

      {isError ? <Alert>{error.message}</Alert> : null}

      {data && entries.length === 0 ? (
        <Card>
          <CardHeader>
            {isFiltered ? (
              <>
                <CardTitle>No matching entries</CardTitle>
                <CardDescription>
                  Nothing matches{' '}
                  {filters.search ? <strong>“{filters.search}”</strong> : 'this filter'}. Search
                  covers both the name and the code.
                </CardDescription>
              </>
            ) : (
              <>
                <CardTitle>Nothing here yet</CardTitle>
                <CardDescription>
                  Canonical entries are created automatically the first time a program uses a new
                  code, so this fills itself as the catalog grows.
                </CardDescription>
              </>
            )}
          </CardHeader>
        </Card>
      ) : null}

      <div className={cn('flex flex-col gap-3', isFetching && 'opacity-60 transition-opacity')}>
        {entries.map((entry) => (
          <CanonicalRow
            key={entry.id}
            entry={entry}
            onEdit={() => setEditing(entry)}
            onMerge={() => setMerging(entry)}
          />
        ))}
      </div>

      {data ? (
        <Pagination
          pagination={data.pagination}
          onPageChange={filters.setPage}
          noun="canonical programs"
          isFetching={isFetching}
        />
      ) : null}
    </div>
  );
}

function CanonicalRow({
  entry,
  onEdit,
  onMerge,
}: {
  entry: CanonicalProgram;
  onEdit: () => void;
  onMerge: () => void;
}) {
  const [showColleges, setShowColleges] = useState(false);
  const [showCareers, setShowCareers] = useState(false);
  const { data, isLoading } = useCanonicalProgramColleges(entry.id, showColleges);

  const count = entry.offerings_count ?? 0;
  const careers = entry.careers ?? [];
  const scoring = careers.filter((career) => career.status === 'active').length;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="flex flex-wrap items-center gap-2 font-medium text-foreground">
              {entry.name}
              <Badge>{entry.code}</Badge>
              {entry.status === 'archived' ? <Badge tone="warning">Archived</Badge> : null}
              {/*
                Said on the row, not only inside the editor: an entry with no active career is one
                every student's program list scores at a flat neutral, and it should be findable by
                scanning the page rather than by opening forty editors.
              */}
              {scoring === 0 ? <Badge tone="warning">No careers — not matched</Badge> : null}
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {/*
                The count is the whole reason an admin scans this list: an entry with one offering
                where they expected four is a grouping that needs merging.
              */}
              {count === 0
                ? 'No college currently offers this'
                : `${count} college ${count === 1 ? 'offering' : 'offerings'}`}
              {` · leads to ${careers.length} ${careers.length === 1 ? 'career' : 'careers'}`}
              {` · ${entry.recommended_strand ?? 'no strand requirement'}`}
              {entry.description ? ` · ${entry.description}` : null}
            </p>
          </div>

          {/*
            Each button names its entry. The visible text stays "Edit" / "Merge" — the row it sits
            in is obvious on screen — but a page of nine rows otherwise presents nine identically
            named buttons to a screen reader, with nothing to say which entry is about to be
            retired. That matters most on Merge, which is the one control here that cannot be
            undone from this screen (P2-3's rule, applied to the row actions).
          */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowCareers((c) => !c)}
              aria-expanded={showCareers}
              aria-label={`${showCareers ? 'Hide' : 'Edit'} careers ${entry.code} leads to`}
            >
              <Link2 className="size-4" aria-hidden="true" />
              {showCareers ? 'Hide careers' : 'Careers'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowColleges((c) => !c)}
              aria-label={`${showColleges ? 'Hide' : 'View'} colleges offering ${entry.code}`}
            >
              <ChevronDown className="size-4" aria-hidden="true" />
              {showColleges ? 'Hide colleges' : 'View colleges'}
            </Button>
            <Button variant="secondary" size="sm" onClick={onEdit} aria-label={`Edit ${entry.code}`}>
              <Pencil className="size-4" aria-hidden="true" />
              Edit
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={onMerge}
              aria-label={`Merge ${entry.code} into another entry`}
            >
              <GitMerge className="size-4" aria-hidden="true" />
              Merge
            </Button>
          </div>
        </div>

        {showCareers ? <CanonicalCareerMapping entry={entry} /> : null}

        {showColleges ? (
          isLoading ? (
            <p className="text-sm text-muted-foreground">Loading colleges…</p>
          ) : (data?.offerings.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">
              No active college offers this program. If that is wrong, the offering is probably
              pointed at a different canonical entry — merge them.
            </p>
          ) : (
            <ul className="flex flex-col gap-2 border-l-2 border-border pl-4">
              {data!.offerings.map(({ college, program }) => (
                <li
                  key={program.id}
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                >
                  <span className="text-foreground">
                    {college.name}
                    <span className="ml-2 text-muted-foreground">
                      {program.code} · {program.name}
                    </span>
                  </span>
                  {college.map_link ? (
                    <a
                      href={college.map_link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs text-primary underline"
                    >
                      <MapPin className="size-3" aria-hidden="true" />
                      Map
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}

/** A native select's value is always a string; this keeps "no requirement" distinguishable. */
const NO_STRAND = '__none__';

function CanonicalForm({ entry, onDone }: { entry?: CanonicalProgram; onDone: () => void }) {
  const create = useCreateCanonicalProgram();
  const update = useUpdateCanonicalProgram();
  const mutation = entry ? update : create;

  const [code, setCode] = useState(entry?.code ?? '');
  const [name, setName] = useState(entry?.name ?? '');
  const [description, setDescription] = useState(entry?.description ?? '');
  const initialStrand = entry?.recommended_strand ?? NO_STRAND;
  const [strand, setStrand] = useState<string>(initialStrand);

  const serverError = mutation.error instanceof ApiRequestError ? mutation.error : null;
  const strandChanged = strand !== initialStrand;
  const offerings = entry?.offerings_count ?? 0;

  function onSubmit(event: FormEvent) {
    event.preventDefault();

    if (mutation.isPending) return;

    const recommendedStrand = strand === NO_STRAND ? null : (strand as Strand);

    const payload = {
      code: code.trim(),
      name: name.trim(),
      description: description.trim() === '' ? null : description.trim(),
      /*
        On an edit, sent **only when changed**. The server writes a changed strand to every
        offering of the program, and a campus may deliberately differ — so a rename that happened
        to resend the unchanged value must not be able to flatten it. (The server also compares
        against what is stored; this keeps the request saying what the admin actually did.)
      */
      ...(entry === undefined || strandChanged ? { recommended_strand: recommendedStrand } : {}),
    };

    if (entry) {
      update.mutate(
        { id: entry.id, payload },
        {
          onSuccess: (saved) => {
            toast.success(
              strandChanged && offerings > 0
                ? `Saved ${saved.name}. The strand now applies to all ${offerings} college ${offerings === 1 ? 'offering' : 'offerings'}.`
                : `Saved ${saved.name}.`,
            );
            onDone();
          },
        },
      );
    } else {
      create.mutate(payload, {
        onSuccess: (saved) => {
          toast.success(`Created ${saved.name}.`);
          onDone();
        },
      });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{entry ? `Edit ${entry.name}` : 'New canonical program'}</CardTitle>
        <CardDescription>
          The code is normalised — case, spaces, hyphens and dots are stripped — so
          &ldquo;bs-cs&rdquo; and &ldquo;BSCS&rdquo; are the same entry.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {serverError && Object.keys(serverError.errors).length === 0 ? (
            <Alert>{serverError.message}</Alert>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="canonical-code">Code</Label>
              <Input
                id="canonical-code"
                value={code}
                placeholder="BSCS"
                aria-invalid={Boolean(serverError?.fieldError('code'))}
                onChange={(event) => setCode(event.target.value)}
              />
              {serverError?.fieldError('code') ? (
                <p className="text-sm text-destructive">{serverError.fieldError('code')}</p>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="canonical-name">Name</Label>
              <Input
                id="canonical-name"
                value={name}
                placeholder="BS Computer Science"
                aria-invalid={Boolean(serverError?.fieldError('name'))}
                onChange={(event) => setName(event.target.value)}
              />
              {serverError?.fieldError('name') ? (
                <p className="text-sm text-destructive">{serverError.fieldError('name')}</p>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="canonical-description">Description (optional)</Label>
              <Input
                id="canonical-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="canonical-strand">Recommended strand</Label>
              <Select
                id="canonical-strand"
                value={strand}
                aria-invalid={Boolean(serverError?.fieldError('recommended_strand'))}
                onChange={(event) => setStrand(event.target.value)}
              >
                <option value={NO_STRAND}>No strand requirement</option>
                {STRANDS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
              {serverError?.fieldError('recommended_strand') ? (
                <p className="text-sm text-destructive">
                  {serverError.fieldError('recommended_strand')}
                </p>
              ) : null}
            </div>
          </div>

          {/*
            Said before saving, because it is the one field here whose effect reaches past this row:
            every college's offering is rewritten, including any campus that had been set apart.
          */}
          {entry && strandChanged && offerings > 0 ? (
            <Alert tone="warning">
              Saving applies this strand to all {offerings} college{' '}
              {offerings === 1 ? 'offering' : 'offerings'} of {entry.code}, replacing any campus
              that was set differently. A campus can be set apart again on its college page.
            </Alert>
          ) : null}

          <div className="flex gap-2">
            <Button type="submit" loading={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : entry ? 'Save changes' : 'Create'}
            </Button>
            <Button type="button" variant="secondary" onClick={onDone}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Merge, behind a confirmation.
 *
 * It is the one control on this page that changes what a student sees, and it is not reversible
 * from the UI — so the panel states the consequence in the terms it will actually have ("N college
 * offerings will move") rather than asking "are you sure?".
 */
/**
 * The merge target picker is a **server-backed typeahead**, not a dropdown of what is on screen.
 *
 * It used to be handed `entries.filter(…)` — the ≤50 rows of the current page. So the moment the
 * catalog outgrew one page, an entry could not be merged into a target that happened to be on
 * another one, and nothing said so: the target simply was not in the list. That is audit F3's shape
 * on the one control here that changes what students are shown, and adding search to the *page*
 * made it worse rather than better — the admin could now find the target, scroll to its row, press
 * Merge, and still not find it among the candidates.
 */
function MergePanel({ source, onDone }: { source: CanonicalProgram; onDone: () => void }) {
  const merge = useMergeCanonicalPrograms();
  const [target, setTarget] = useState<CanonicalProgram | null>(null);
  const [search, setSearch] = useState('');
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const options = useCanonicalProgramOptions(debouncedSearch, isPickerOpen);

  /*
   * The source is excluded client-side: "not itself" is a fact about this panel, not about the
   * catalog, and the server would have to be told which entry to leave out to know it. One id.
   */
  const candidates = (options.data ?? []).filter((entry) => entry.id !== source.id);

  const moving = source.offerings_count ?? 0;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Merge &ldquo;{source.name}&rdquo; into another entry</CardTitle>
          <CardDescription>
            Every college offering that currently points at {source.code} will point at the entry
            you choose, and {source.code} is retired. This cannot be undone here.
          </CardDescription>
        </div>
        <Button variant="ghost" size="sm" onClick={onDone} aria-label="Cancel the merge">
          <X className="size-4" aria-hidden="true" />
        </Button>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {merge.isError ? (
          <Alert>
            {merge.error instanceof Error ? merge.error.message : 'The merge could not be applied.'}
          </Alert>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="merge-target">Keep this entry</Label>
          <Combobox
            id="merge-target"
            value={target?.id ?? null}
            selectedLabel={target ? `${target.code} · ${target.name}` : null}
            onChange={(id) => {
              setTarget(candidates.find((entry) => entry.id === id) ?? null);
              // A changed target invalidates the confirmation — the sentence they agreed to
              // named a different program.
              setConfirmed(false);
            }}
            options={candidates.map((entry) => ({
              id: entry.id,
              // The offerings count is kept in the label: this picker sits in front of a merge, and
              // "12 offerings" against a candidate is the difference between absorbing a stub and
              // absorbing a live entry.
              name: `${entry.code} · ${entry.name} (${entry.offerings_count ?? 0} offerings)`,
            }))}
            query={search}
            onQueryChange={setSearch}
            onOpenChange={setIsPickerOpen}
            loading={options.isFetching}
            placeholder="Choose the entry that survives…"
            searchPlaceholder="Search by name or code…"
            emptyText={
              search.trim() === ''
                ? 'No other canonical entries to merge into.'
                : `No active entry matches “${search.trim()}”.`
            }
            footer={
              candidates.length >= CANONICAL_OPTION_LIMIT
                ? `Showing the first ${CANONICAL_OPTION_LIMIT} — keep typing to narrow it down.`
                : null
            }
          />
        </div>

        {target ? (
          <Alert tone="warning">
            {moving === 0
              ? `${source.code} has no offerings to move. It will simply be retired.`
              : `${moving} college ${moving === 1 ? 'offering' : 'offerings'} will move from ${source.code} to ${target.code}, and ${source.code} will be retired.`}
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          {!confirmed ? (
            <Button variant="secondary" disabled={target === null} onClick={() => setConfirmed(true)}>
              Review this merge
            </Button>
          ) : (
            <Button
              variant="danger"
              loading={merge.isPending}
              disabled={merge.isPending || target === null}
              onClick={() =>
                merge.mutate(
                  { id: source.id, targetId: target!.id },
                  {
                    onSuccess: (result) => {
                      // The panel closes on success, so without this the only evidence the merge
                      // happened is a list that quietly reordered itself.
                      toast.success(
                        `Merged into ${result.target.name}. ${result.offerings_moved} college ${
                          result.offerings_moved === 1 ? 'offering' : 'offerings'
                        } moved.`,
                      );
                      onDone();
                    },
                  },
                )
              }
            >
              {merge.isPending ? 'Merging…' : `Yes, merge into ${target!.code}`}
            </Button>
          )}

          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

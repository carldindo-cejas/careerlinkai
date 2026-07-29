import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Download,
  FilterX,
  Loader2,
  Search,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/components/ui/cn';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '@/hooks/useDebouncedValue';
import {
  useAuditFilterOptions,
  useAuditLogs,
  useExportAuditLogs,
} from '@/features/admin/hooks/usePlatformAdmin';
import { toast } from '@/stores/toastStore';
import {
  AUDIT_ACTION_TYPES,
  AUDIT_ACTORS,
  type AuditActionType,
  type AuditActor,
  type AuditLogEntry,
  type AuditLogFilters,
  type AuditSort,
} from '@/types/platform';

/**
 * The audit-log viewer (FULLPLAN §13.8, §20 — Phase 6; advanced filtering added v1.6, admin only).
 *
 * This screen is where two design decisions finally pay off:
 *   * §38 answers every failed student join with the same generic 401 and writes the real
 *     reason here — so this page is the *only* place an operator can see why.
 *   * D18's lesson: a listener that throws is swallowed by design; this trail is where a
 *     swallowed failure becomes visible.
 *
 * **Every filter is server-side, and that is not a performance detail.** `audit_logs` has no
 * retention policy (§13.8 — it grows without bound), so a client-side filter would be filtering
 * whichever 25 rows happened to be on screen while reporting a total for all of them. The page
 * owns the query, the query travels, and the count that comes back is the filtered count.
 *
 * The Action Type filter deliberately offers *groups* rather than the fifty-odd raw actions: an
 * operator thinks "show me everything that was deleted", and the grouping is resolved server-side
 * from an exhaustive map so `ROSTER_STUDENT_REMOVED` and `PROGRAM_CAREER_UNLINKED` — both
 * deletions, neither matching any suffix pattern — land where they belong.
 */

const PER_PAGE = 25;

const ACTION_TYPE_LABELS: Record<AuditActionType, string> = {
  CREATE: 'Create',
  UPDATE: 'Update',
  DELETE: 'Delete',
  ARCHIVE: 'Archive',
  RESTORE: 'Restore',
  PUBLISH: 'Publish',
  ASSIGN: 'Assign',
  SUBMIT: 'Submit',
  LOGIN: 'Login',
  LOGOUT: 'Logout',
  OTHER: 'Other',
};

const ACTOR_LABELS: Record<AuditActor, string> = {
  admin: 'Administrator',
  counselor: 'Counselor',
  student: 'Student',
  system: 'System / unresolved',
};

export function AuditLogPage() {
  const [searchInput, setSearchInput] = useState('');
  const [actionType, setActionType] = useState<AuditActionType | ''>('');
  const [action, setAction] = useState('');
  const [module, setModule] = useState('');
  const [actor, setActor] = useState<AuditActor | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState<AuditSort>('created_at');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);

  const search = useDebouncedValue(searchInput, SEARCH_DEBOUNCE_MS);
  const options = useAuditFilterOptions();
  const exportLogs = useExportAuditLogs();

  // Any change to what is being *filtered* returns to page one: page 4 of the unfiltered trail
  // rarely exists in the filtered one, and a page past the end comes back empty.
  useEffect(() => {
    setPage(1);
  }, [search, actionType, action, module, actor, from, to]);

  const filters: AuditLogFilters = useMemo(
    () => ({
      search: search || undefined,
      action_type: actionType || undefined,
      action: action || undefined,
      module: module || undefined,
      actor: actor || undefined,
      from: from || undefined,
      to: to || undefined,
      sort,
      direction,
      page,
      per_page: PER_PAGE,
    }),
    [search, actionType, action, module, actor, from, to, sort, direction, page],
  );

  const { data, isLoading, isError, error, isFetching } = useAuditLogs(filters);

  const anyFilter =
    searchInput !== '' ||
    actionType !== '' ||
    action !== '' ||
    module !== '' ||
    actor !== '' ||
    from !== '' ||
    to !== '';

  function clearFilters() {
    setSearchInput('');
    setActionType('');
    setAction('');
    setModule('');
    setActor('');
    setFrom('');
    setTo('');
    setPage(1);
  }

  function onSort(column: AuditSort) {
    if (column === sort) {
      setDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(column);
      setDirection(column === 'created_at' ? 'desc' : 'asc');
    }

    setPage(1);
  }

  async function onExport() {
    try {
      const result = await exportLogs.mutateAsync(filters);

      if (result.truncated) {
        // The cap is stated rather than silently applied — an operator who exported "everything"
        // and got a prefix of it needs to know before they act on the file.
        toast.info(
          `Exported the first ${result.rowCount.toLocaleString()} rows. Narrow the date range to get the rest.`,
        );
      } else {
        toast.success(`Exported ${result.rowCount.toLocaleString()} rows.`);
      }
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'The export failed.');
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Audit log</h1>
          <p className="text-sm text-muted-foreground">
            The append-only record of every critical action. Failed student sign-ins are answered
            generically on purpose — the real reason is only ever written here.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={onExport}
          loading={exportLogs.isPending}
          disabled={data === undefined || data.pagination.total === 0}
        >
          <Download className="size-4" aria-hidden="true" />
          Export CSV
        </Button>
      </div>

      {/* Search + the four dropdowns. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-search">Search</Label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id="audit-search"
              value={searchInput}
              placeholder="Action, module, actor or target id…"
              className="pl-9"
              onChange={(event) => setSearchInput(event.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-action-type">Action type</Label>
          <Select
            id="audit-action-type"
            value={actionType}
            onChange={(event) => setActionType(event.target.value as AuditActionType | '')}
          >
            <option value="">All action types</option>
            {AUDIT_ACTION_TYPES.map((type) => (
              <option key={type} value={type}>
                {ACTION_TYPE_LABELS[type]}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-module">Module</Label>
          <Select
            id="audit-module"
            value={module}
            onChange={(event) => setModule(event.target.value)}
          >
            <option value="">All modules</option>
            {(options.data?.modules ?? []).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-actor">Actor</Label>
          <Select
            id="audit-actor"
            value={actor}
            onChange={(event) => setActor(event.target.value as AuditActor | '')}
          >
            <option value="">All actors</option>
            {AUDIT_ACTORS.map((role) => (
              <option key={role} value={role}>
                {ACTOR_LABELS[role]}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {/* The date range and the exact-action narrowing. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-from">From</Label>
          <Input
            id="audit-from"
            type="date"
            value={from}
            max={to === '' ? undefined : to}
            onChange={(event) => setFrom(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-to">To</Label>
          <Input
            id="audit-to"
            type="date"
            value={to}
            min={from === '' ? undefined : from}
            onChange={(event) => setTo(event.target.value)}
          />
        </div>

        {/*
          The exact action, alongside the group filter rather than instead of it. The group answers
          "everything deleted"; this answers "every ASSESSMENT_PUBLISHED". The two compose, and the
          list is the vocabulary this deployment has actually recorded rather than every action the
          code can write — a dropdown of forty actions that have never occurred is one to read past.
        */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-action">Specific action</Label>
          <Select
            id="audit-action"
            value={action}
            onChange={(event) => setAction(event.target.value)}
          >
            <option value="">Any action</option>
            {(options.data?.actions ?? []).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </div>

        {anyFilter ? (
          <div className="flex items-end">
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <FilterX className="size-4" aria-hidden="true" />
              Clear filters
            </Button>
          </div>
        ) : null}
      </div>

      {isError ? <Alert>We could not load the audit log. {error.message}</Alert> : null}

      {isLoading ? (
        <div className="flex justify-center py-12" role="status">
          <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
          <span className="sr-only">Loading the trail…</span>
        </div>
      ) : null}

      {data && data.items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Nothing recorded{anyFilter ? ' for these filters' : ' yet'}</CardTitle>
            <CardDescription>
              {anyFilter
                ? 'Try widening the date range, or clearing a filter.'
                : 'Every login, class change, publish and join attempt lands here as it happens.'}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {data && data.items.length > 0 ? (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                    <SortableHeader
                      label="When"
                      column="created_at"
                      sort={sort}
                      direction={direction}
                      onSort={onSort}
                    />
                    <SortableHeader
                      label="Action"
                      column="action"
                      sort={sort}
                      direction={direction}
                      onSort={onSort}
                    />
                    <th className="px-4 py-3 font-medium">Actor</th>
                    <SortableHeader
                      label="Module"
                      column="module"
                      sort={sort}
                      direction={direction}
                      onSort={onSort}
                    />
                    <th className="px-4 py-3 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody className={cn(isFetching && 'opacity-60 transition-opacity')}>
                  {data.items.map((entry) => (
                    <AuditRow key={entry.id} entry={entry} />
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {data ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {data.pagination.total.toLocaleString()} entr
            {data.pagination.total === 1 ? 'y' : 'ies'}
            {data.pagination.last_page > 1
              ? ` · page ${data.pagination.current_page} of ${data.pagination.last_page}`
              : ''}
          </p>
          {data.pagination.last_page > 1 ? (
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1 || isFetching}
                onClick={() => setPage((value) => value - 1)}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= data.pagination.last_page || isFetching}
                onClick={() => setPage((value) => value + 1)}
              >
                Next
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AuditRow({ entry }: { entry: AuditLogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = entry.old_values !== null || entry.new_values !== null;

  return (
    <>
      <tr className="border-b border-border align-top last:border-b-0">
        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
          {entry.created_at ? new Date(entry.created_at).toLocaleString() : '—'}
        </td>
        <td className="px-4 py-3">
          <Badge tone={toneFor(entry.action)} className="normal-case">
            {entry.action}
          </Badge>
          {/* The group, from the server's own classification — never re-derived here. */}
          <p className="mt-0.5 text-xs text-muted-foreground">
            {ACTION_TYPE_LABELS[entry.action_type]}
          </p>
        </td>
        <td className="px-4 py-3 text-foreground/80">
          {entry.user_name ?? (
            <span className="italic text-muted-foreground">system / unresolved</span>
          )}
          {entry.user_role ? (
            <p className="mt-0.5 text-xs capitalize text-muted-foreground">{entry.user_role}</p>
          ) : null}
        </td>
        <td className="px-4 py-3 text-muted-foreground">{entry.module}</td>
        <td className="px-4 py-3">
          {hasDetails ? (
            <button
              type="button"
              className="text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? 'Hide' : 'Show'}
            </button>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b border-border bg-muted/60">
          <td colSpan={5} className="px-4 py-3">
            <div className="grid gap-3 sm:grid-cols-2">
              {entry.old_values ? (
                <DetailBlock label="Before" values={entry.old_values} />
              ) : null}
              {entry.new_values ? <DetailBlock label="After" values={entry.new_values} /> : null}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 text-xs text-muted-foreground">
              {entry.ip_address ? <span>IP: {entry.ip_address}</span> : null}
              {entry.target_type ? (
                <span>
                  Target: {entry.target_type}
                  {entry.target_id ? ` · ${entry.target_id}` : ''}
                </span>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function DetailBlock({ label, values }: { label: string; values: Record<string, unknown> }) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <pre className="overflow-x-auto rounded-none bg-muted p-3 text-xs text-foreground/80 ring-1 ring-border">
        {JSON.stringify(values, null, 2)}
      </pre>
    </div>
  );
}

function SortableHeader({
  label,
  column,
  sort,
  direction,
  onSort,
}: {
  label: string;
  column: AuditSort;
  sort: AuditSort;
  direction: 'asc' | 'desc';
  onSort: (column: AuditSort) => void;
}) {
  const active = sort === column;
  const Icon = active ? (direction === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;

  return (
    <th
      className="px-4 py-3 font-medium"
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          'inline-flex items-center gap-1.5 uppercase tracking-wide transition-colors hover:text-foreground',
          active && 'text-foreground',
        )}
        aria-label={`Sort by ${label}`}
      >
        {label}
        <Icon className="size-3.5" aria-hidden="true" />
      </button>
    </th>
  );
}

/**
 * Failures and deletions read as outlines; everything else stays neutral.
 *
 * Outline rather than a warning tint because this is a mono scheme: a filled `warning` badge is
 * deep steel and a filled `success` badge is base steel, which at 12px sit a shade apart and read
 * as the same thing. Scanning a log for what went wrong is the whole job of this page, so the
 * failures are separated by *fill* — hollow against filled — which survives being glanced at.
 */
function toneFor(action: string): 'neutral' | 'success' | 'outline' {
  if (action.endsWith('_FAILED') || action.endsWith('_THROTTLED') || action.endsWith('_DELETED')) {
    return 'outline';
  }

  if (action.endsWith('_SUCCESS') || action === 'ASSESSMENT_PUBLISHED') {
    return 'success';
  }

  return 'neutral';
}

/** Debounce the search box so it drives one request rather than one per keystroke. */

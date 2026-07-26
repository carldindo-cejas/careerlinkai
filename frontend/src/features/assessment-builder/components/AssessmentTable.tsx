import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Archive,
  ArchiveRestore,
  Eye,
  Globe,
  Loader2,
  Pencil,
  Search,
  Send,
  Users,
} from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { cn } from '@/components/ui/cn';
import type { SortDirection } from '@/types/address';
import type {
  AssessmentAssignmentFilter,
  AssessmentRow,
  AssessmentSort,
  AssessmentStatusFilter,
  AssessmentType,
} from '@/types/assessmentAdmin';
import type { Paginated } from '@/types/class';

/**
 * The administrator's assessment table.
 *
 * **Search, filters, sorting and pagination are all server-side** — the query is lifted to the page,
 * which re-fetches. A table that sorted or filtered only the rows it happened to have loaded would
 * be telling the truth about one page and lying about the rest, and the row counts underneath it
 * would be lying about all of them.
 *
 * Two columns carry a judgement rather than a field, and both are computed on the server so the
 * filters and the badges cannot disagree:
 *
 *   * **Status** is *derived* — an assessment is "Published" when some version of it is. The
 *     template's own status column only distinguishes archived from not, which is a different
 *     question and gets its own badge.
 *   * **Assignment** has three states, not two. "Not assigned" is not "specific classes, zero of
 *     them", and collapsing them would print `Specific classes (0)`.
 */

const VERSIONS_SHOWN = 3;

interface AssessmentTableProps {
  data: Paginated<AssessmentRow> | undefined;
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
  errorMessage?: string | undefined;

  search: string;
  onSearchChange: (value: string) => void;

  types: AssessmentType[];
  typeFilter: string;
  onTypeFilterChange: (value: string) => void;
  statusFilter: AssessmentStatusFilter | '';
  onStatusFilterChange: (value: AssessmentStatusFilter | '') => void;
  assignmentFilter: AssessmentAssignmentFilter | '';
  onAssignmentFilterChange: (value: AssessmentAssignmentFilter | '') => void;

  sort: AssessmentSort;
  direction: SortDirection;
  onSort: (column: AssessmentSort) => void;

  page: number;
  onPageChange: (page: number) => void;

  onView: (row: AssessmentRow) => void;
  onEdit: (row: AssessmentRow) => void;
  onAssign: (row: AssessmentRow) => void;
  onArchive: (row: AssessmentRow) => void;
  onRestore: (row: AssessmentRow) => void;
  /** The row a destructive mutation is currently running against, so only its button spins. */
  busyId: string | null;
}

export function AssessmentTable({
  data,
  isPending,
  isFetching,
  isError,
  errorMessage,
  search,
  onSearchChange,
  types,
  typeFilter,
  onTypeFilterChange,
  statusFilter,
  onStatusFilterChange,
  assignmentFilter,
  onAssignmentFilterChange,
  sort,
  direction,
  onSort,
  page,
  onPageChange,
  onView,
  onEdit,
  onAssign,
  onArchive,
  onRestore,
  busyId,
}: AssessmentTableProps) {
  const filtered =
    search !== '' || typeFilter !== '' || statusFilter !== '' || assignmentFilter !== '';

  return (
    <div className="flex flex-col gap-4">
      {/* Search and the three filters. They wrap onto their own rows on a phone rather than
          shrinking into unreadable slivers. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="assessment-search">Search</Label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id="assessment-search"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search assessments…"
              className="pl-9"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="assessment-type-filter">Assessment type</Label>
          <Select
            id="assessment-type-filter"
            value={typeFilter}
            onChange={(event) => onTypeFilterChange(event.target.value)}
          >
            <option value="">All types</option>
            {types.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="assessment-status-filter">Status</Label>
          <Select
            id="assessment-status-filter"
            value={statusFilter}
            onChange={(event) =>
              onStatusFilterChange(event.target.value as AssessmentStatusFilter | '')
            }
          >
            <option value="">All statuses</option>
            <option value="PUBLISHED">Published</option>
            <option value="UNPUBLISHED">No published version</option>
            <option value="ARCHIVED">Archived</option>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="assessment-assignment-filter">Assignment</Label>
          <Select
            id="assessment-assignment-filter"
            value={assignmentFilter}
            onChange={(event) =>
              onAssignmentFilterChange(event.target.value as AssessmentAssignmentFilter | '')
            }
          >
            <option value="">All assignments</option>
            <option value="GLOBAL">Global</option>
            <option value="CLASS">Specific classes</option>
            <option value="UNASSIGNED">Not assigned</option>
          </Select>
        </div>
      </div>

      {isError ? <Alert>We could not load the assessments. {errorMessage}</Alert> : null}

      {isPending ? (
        <div className="flex justify-center py-12" role="status">
          <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
          <span className="sr-only">Loading assessments…</span>
        </div>
      ) : null}

      {data && data.items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {filtered
              ? 'No assessments match these filters.'
              : 'No assessments yet. Create one to get started.'}
          </CardContent>
        </Card>
      ) : null}

      {data && data.items.length > 0 ? (
        <Card>
          <CardContent className="p-0">
            {/* The table scrolls inside its own container — the page itself never scrolls
                sideways, however many columns there are. */}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                    <SortableHeader
                      label="Assessment"
                      column="title"
                      sort={sort}
                      direction={direction}
                      onSort={onSort}
                    />
                    <SortableHeader
                      label="Type"
                      column="type"
                      sort={sort}
                      direction={direction}
                      onSort={onSort}
                    />
                    <th className="px-4 py-3 font-medium">Versions</th>
                    <SortableHeader
                      label="Status"
                      column="status"
                      sort={sort}
                      direction={direction}
                      onSort={onSort}
                    />
                    <th className="px-4 py-3 font-medium">Assignment</th>
                    <th className="px-4 py-3 text-right font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className={cn(isFetching && 'opacity-60 transition-opacity')}>
                  {data.items.map((row) => (
                    <tr key={row.id} className="border-b border-border last:border-b-0 align-top">
                      <td className="px-4 py-3">
                        <p className="font-medium text-foreground">{row.title}</p>
                        {row.scorings.length > 0 ? (
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {row.scorings.map((scoring) => scoring.name).join(' · ')}
                          </p>
                        ) : (
                          <p className="mt-0.5 text-xs text-muted-foreground/60">
                            No scoring method set
                          </p>
                        )}
                      </td>

                      <td className="px-4 py-3">
                        {row.type ? (
                          <Badge tone="outline">{row.type.name}</Badge>
                        ) : (
                          // Predates the taxonomy. Named rather than blank, because a blank cell
                          // reads as a rendering bug and this is a row someone needs to fix.
                          <span className="text-xs text-muted-foreground/60">Untyped</span>
                        )}
                      </td>

                      <td className="px-4 py-3">
                        <VersionList versions={row.versions} />
                      </td>

                      <td className="whitespace-nowrap px-4 py-3">
                        {row.is_archived ? (
                          <Badge tone="warning">Archived</Badge>
                        ) : row.is_published ? (
                          <Badge tone="success">Published</Badge>
                        ) : (
                          <Badge>No published version</Badge>
                        )}
                      </td>

                      <td className="whitespace-nowrap px-4 py-3">
                        <AssignmentCell assignment={row.assignment} />
                      </td>

                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`View ${row.title}`}
                            title="View in the builder"
                            onClick={() => onView(row)}
                          >
                            <Eye className="size-4" aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Edit ${row.title}`}
                            title="Edit title, type and scoring"
                            onClick={() => onEdit(row)}
                          >
                            <Pencil className="size-4" aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Assign ${row.title}`}
                            title={
                              row.is_archived
                                ? 'Restore this assessment before assigning it'
                                : 'Assign globally or to classes'
                            }
                            disabled={row.is_archived}
                            onClick={() => onAssign(row)}
                          >
                            <Send className="size-4" aria-hidden="true" />
                          </Button>
                          {row.is_archived ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              loading={busyId === row.id}
                              aria-label={`Restore ${row.title}`}
                              title="Restore"
                              onClick={() => onRestore(row)}
                            >
                              <ArchiveRestore className="size-4" aria-hidden="true" />
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              loading={busyId === row.id}
                              aria-label={`Archive ${row.title}`}
                              title="Archive"
                              onClick={() => onArchive(row)}
                            >
                              <Archive className="size-4" aria-hidden="true" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
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
            {data.pagination.total} assessment{data.pagination.total === 1 ? '' : 's'}
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
                onClick={() => onPageChange(page - 1)}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= data.pagination.last_page || isFetching}
                onClick={() => onPageChange(page + 1)}
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

/**
 * `v3, v2, v1` — newest first, with the tail folded into "+N more".
 *
 * Three is enough to show what is current and what came before it; an instrument on its ninth
 * version would otherwise make its row four lines tall for information nobody reads at a glance.
 * The published one is toned so the eye can find it without reading the numbers.
 */
function VersionList({ versions }: { versions: AssessmentRow['versions'] }) {
  if (versions.length === 0) {
    return <span className="text-xs text-muted-foreground/60">None yet</span>;
  }

  const shown = versions.slice(0, VERSIONS_SHOWN);
  const remaining = versions.length - shown.length;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((version) => (
        <Badge
          key={version.id}
          tone={version.status === 'PUBLISHED' ? 'success' : 'outline'}
          className="font-mono"
        >
          v{version.version_number}
        </Badge>
      ))}
      {remaining > 0 ? (
        <span
          className="text-xs text-muted-foreground"
          title={versions.map((version) => `v${version.version_number}`).join(', ')}
        >
          +{remaining} more…
        </span>
      ) : null}
    </div>
  );
}

function AssignmentCell({ assignment }: { assignment: AssessmentRow['assignment'] }) {
  if (assignment.scope === 'GLOBAL') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-foreground">
        <Globe className="size-4 text-muted-foreground" aria-hidden="true" />
        Global
      </span>
    );
  }

  if (assignment.scope === 'CLASS') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-foreground">
        <Users className="size-4 text-muted-foreground" aria-hidden="true" />
        {assignment.class_count} class{assignment.class_count === 1 ? '' : 'es'}
      </span>
    );
  }

  return <span className="text-sm text-muted-foreground/60">Not assigned</span>;
}

function SortableHeader({
  label,
  column,
  sort,
  direction,
  onSort,
}: {
  label: string;
  column: AssessmentSort;
  sort: AssessmentSort;
  direction: SortDirection;
  onSort: (column: AssessmentSort) => void;
}) {
  const active = sort === column;
  const Icon = active ? (direction === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;

  return (
    <th className="px-4 py-3 font-medium" aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
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

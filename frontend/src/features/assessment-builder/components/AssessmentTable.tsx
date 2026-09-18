import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Archive,
  ArchiveRestore,
  CalendarX,
  Copy,
  Globe,
  Loader2,
  Pencil,
  Search,
  Send,
  Shuffle,
  Trash2,
  Users,
} from 'lucide-react';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { cn } from '@/components/ui/cn';
import type { SortDirection } from '@/types/address';
import {
  ASSESSMENT_DATE_FIELDS,
  type AssessmentAssignmentFilter,
  type AssessmentDateField,
  type AssessmentRow,
  type AssessmentSort,
  type AssessmentStatusFilter,
  type AssessmentType,
  type PresentationMode,
} from '@/types/assessmentAdmin';
import type { Paginated } from '@/types/class';

/**
 * The assessment table, for administrators and counselors alike.
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
 *
 * ## The whole row opens the assessment
 *
 * Not a 32-pixel eye icon at the end of eight columns (prompt §5). The row is the affordance: it
 * takes a click anywhere, it takes Enter and Space from the keyboard, it is a single tab stop, and
 * it says so on hover and on focus. The title inside it is a real `<button>` so that assistive
 * technology is offered the same act with a name attached rather than a bare clickable region.
 *
 * **The action controls stop the click from reaching the row.** Publish, Assign, Archive, Copy and
 * Delete all live in a cell that cancels propagation, and so does the delivery-mode select — a
 * dropdown that also navigated would be unusable. That is the entire subtlety of making a row
 * clickable, and it is why the cancel is on the container rather than repeated on eight handlers,
 * where the ninth would be the one that got forgotten.
 *
 * ## Two layouts, one data contract
 *
 * Under `lg` the table becomes a list of cards. Eight columns do not survive 360 px, and the two
 * usual escapes are both worse than this: shrinking the columns makes every cell a two-character
 * sliver, and hiding columns hides the Assignment and Status information that is the reason someone
 * opened the list. The card carries the same fields stacked, the same actions, and the same
 * whole-surface click.
 */

const VERSIONS_SHOWN = 3;

/**
 * The tooltip on every authoring control a counselor cannot use on a curated instrument. One
 * constant rather than five copies, because the sentence is a claim about the server's rule and
 * five copies is how one of them ends up describing a different rule.
 */
const NOT_YOURS =
  'This is a shared instrument, managed by an administrator. You can still assign it to your classes — or make your own copy to edit.';

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

  /** Which date the range below filters on — one picker, three server-side ranges behind it. */
  dateField: AssessmentDateField;
  onDateFieldChange: (value: AssessmentDateField) => void;
  dateFrom: string;
  onDateFromChange: (value: string) => void;
  dateTo: string;
  onDateToChange: (value: string) => void;

  sort: AssessmentSort;
  direction: SortDirection;
  onSort: (column: AssessmentSort) => void;

  page: number;
  onPageChange: (page: number) => void;

  /** Whether the viewer is an administrator — decides whether the Owner column is worth a column. */
  showOwner: boolean;

  /** Clicking the row, the card, or the title. The primary act on this screen. */
  onOpen: (row: AssessmentRow) => void;
  /** The metadata dialog — title, type, scoring. A different act from opening the builder. */
  onEdit: (row: AssessmentRow) => void;
  onAssign: (row: AssessmentRow) => void;
  onCopy: (row: AssessmentRow) => void;
  onArchive: (row: AssessmentRow) => void;
  onRestore: (row: AssessmentRow) => void;
  onDelete: (row: AssessmentRow) => void;
  onPresentationModeChange: (row: AssessmentRow, mode: PresentationMode) => void;
  /** The row a destructive or slow mutation is currently running against, so only its control spins. */
  busyId: string | null;
}

const DATE_FIELD_LABELS: Record<AssessmentDateField, string> = {
  published_at: 'Date published',
  created_at: 'Date created',
  updated_at: 'Date updated',
};

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
  dateField,
  onDateFieldChange,
  dateFrom,
  onDateFromChange,
  dateTo,
  onDateToChange,
  sort,
  direction,
  onSort,
  page,
  onPageChange,
  showOwner,
  onOpen,
  onEdit,
  onAssign,
  onCopy,
  onArchive,
  onRestore,
  onDelete,
  onPresentationModeChange,
  busyId,
}: AssessmentTableProps) {
  const filtered =
    search !== '' ||
    typeFilter !== '' ||
    statusFilter !== '' ||
    assignmentFilter !== '' ||
    dateFrom !== '' ||
    dateTo !== '';

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

      {/*
        The date range, on its own row.

        **One picker with a "which date" selector, rather than three separate ranges on screen.**
        The server supports all three independently — "created in January but published in March" is
        a real question — but showing six date inputs at once turns the common case (one range) into
        a puzzle. The selector keeps the common case one control and the uncommon case reachable.
      */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="assessment-date-field">Filter dates by</Label>
          <Select
            id="assessment-date-field"
            value={dateField}
            onChange={(event) => onDateFieldChange(event.target.value as AssessmentDateField)}
          >
            {ASSESSMENT_DATE_FIELDS.map((field) => (
              <option key={field} value={field}>
                {DATE_FIELD_LABELS[field]}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="assessment-date-from">From</Label>
          <Input
            id="assessment-date-from"
            type="date"
            value={dateFrom}
            max={dateTo === '' ? undefined : dateTo}
            onChange={(event) => onDateFromChange(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="assessment-date-to">To</Label>
          <Input
            id="assessment-date-to"
            type="date"
            value={dateTo}
            min={dateFrom === '' ? undefined : dateFrom}
            onChange={(event) => onDateToChange(event.target.value)}
          />
        </div>

        {dateFrom !== '' || dateTo !== '' ? (
          <div className="flex items-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onDateFromChange('');
                onDateToChange('');
              }}
            >
              <CalendarX className="size-4" aria-hidden="true" />
              Clear dates
            </Button>
          </div>
        ) : null}
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
        <>
          {/* --- Phone and tablet: a list of cards ------------------------------------------- */}
          <ul className={cn('flex flex-col gap-3 lg:hidden', isFetching && 'opacity-60')}>
            {data.items.map((row) => (
              <li key={row.id}>
                <AssessmentCard
                  row={row}
                  onOpen={onOpen}
                  onEdit={onEdit}
                  onAssign={onAssign}
                  onCopy={onCopy}
                  onArchive={onArchive}
                  onRestore={onRestore}
                  onDelete={onDelete}
                  onPresentationModeChange={onPresentationModeChange}
                  busy={busyId === row.id}
                  showOwner={showOwner}
                />
              </li>
            ))}
          </ul>

          {/* --- Laptop and up: the table --------------------------------------------------- */}
          {/*
            `min-w-0 overflow-hidden` on the card, not only `overflow-x-auto` on the div inside it.

            A scroll container clips what it *paints*, but its content still contributes to the
            intrinsic width of every `overflow: visible` ancestor — so a table wider than the card
            propagated its min-content width all the way to `<body>` and the whole page slid
            sideways, while the table itself sat there scrolling correctly. Measured at 1024 px and
            1280 px by `scripts/responsive-audit.mjs`; `overflow-hidden` here is what actually ends
            the chain, and `min-w-0` is what lets the card shrink to its flex line in the first
            place.
          */}
          <Card className="hidden min-w-0 overflow-hidden lg:block">
            <CardContent className="p-0">
              {/*
                The table scrolls inside its own container — the page itself never scrolls
                sideways, however many columns there are.

                `max-w-full` is load-bearing rather than belt-and-braces: without a definite maximum
                the container is sized by the table it is meant to be clipping, and the intrinsic
                width leaks out through every `overflow: visible` ancestor to the document. That is
                the defect `responsive-audit.mjs` measured at 1024 px and 1280 px.
              */}
              <div className="max-w-full overflow-x-auto">
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
                      {showOwner ? <th className="px-4 py-3 font-medium">Owner</th> : null}
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
                      {/* Prompt §6: settable here, without opening anything. */}
                      <th className="px-4 py-3 font-medium">Delivery</th>
                      <SortableHeader
                        label="Published"
                        column="published_at"
                        sort={sort}
                        direction={direction}
                        onSort={onSort}
                      />
                      <th className="px-4 py-3 text-right font-medium">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className={cn(isFetching && 'opacity-60 transition-opacity')}>
                    {data.items.map((row) => (
                      <tr
                        key={row.id}
                        /**
                         * The row is the control (prompt §5). `tabIndex` makes it one stop, the
                         * key handler gives it Enter and Space, and the hover/focus styling is
                         * what tells someone it is clickable before they try.
                         */
                        tabIndex={0}
                        aria-label={`Open ${row.title}`}
                        onClick={() => onOpen(row)}
                        onKeyDown={(event) => activateOnKey(event, () => onOpen(row))}
                        className={cn(
                          'cursor-pointer border-b border-border align-top transition-colors last:border-b-0',
                          'hover:bg-muted focus-visible:bg-muted focus-visible:outline-none',
                          'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                        )}
                      >
                        <td className="px-4 py-3">
                          {/*
                            A real button inside the row, so assistive technology is offered the
                            act with a name rather than a clickable table row it has to guess at.
                            It does not need its own handler — the click bubbles to the row.
                          */}
                          <button
                            type="button"
                            tabIndex={-1}
                            className="text-left font-medium text-foreground hover:underline"
                          >
                            {row.title}
                          </button>
                          <TitleSubline row={row} />
                        </td>

                        {showOwner ? (
                          <td className="px-4 py-3">
                            <OwnerCell row={row} />
                          </td>
                        ) : null}

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
                          <StatusBadge row={row} />
                        </td>

                        <td className="whitespace-nowrap px-4 py-3">
                          <AssignmentCell assignment={row.assignment} />
                        </td>

                        <td className="px-4 py-3" onClick={stop} onKeyDown={stop}>
                          <PresentationModeControl
                            row={row}
                            onChange={onPresentationModeChange}
                            busy={busyId === row.id}
                          />
                        </td>

                        <td className="whitespace-nowrap px-4 py-3">
                          <DateCell
                            value={row.published_at}
                            emptyLabel="Never"
                            title={
                              row.first_published_at !== null &&
                              row.first_published_at !== row.published_at
                                ? `First published ${formatDate(row.first_published_at)}`
                                : undefined
                            }
                          />
                        </td>

                        {/*
                          **The cell that cancels the row's click.** Every action lives inside it,
                          so none of them can navigate by accident — and a control added here later
                          inherits that without anyone having to remember.
                        */}
                        <td className="px-4 py-3 text-right" onClick={stop} onKeyDown={stop}>
                          <div className="flex items-center justify-end gap-1">
                            <RowActions
                              row={row}
                              onEdit={onEdit}
                              onAssign={onAssign}
                              onCopy={onCopy}
                              onArchive={onArchive}
                              onRestore={onRestore}
                              onDelete={onDelete}
                              busy={busyId === row.id}
                            />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
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
 * One assessment, as a card, under `lg`.
 *
 * The same click target logic as the row and the same actions — a phone must not be a read-only
 * version of this screen (prompt §10: "do not simply hide important functionality on mobile").
 * `min-h-11` on the actions is the 44 px touch target; the delivery select is full width because a
 * native select on a phone opens a sheet anyway and a narrow one is just harder to hit.
 */
function AssessmentCard({
  row,
  onOpen,
  onEdit,
  onAssign,
  onCopy,
  onArchive,
  onRestore,
  onDelete,
  onPresentationModeChange,
  busy,
  showOwner,
}: {
  row: AssessmentRow;
  onOpen: (row: AssessmentRow) => void;
  onEdit: (row: AssessmentRow) => void;
  onAssign: (row: AssessmentRow) => void;
  onCopy: (row: AssessmentRow) => void;
  onArchive: (row: AssessmentRow) => void;
  onRestore: (row: AssessmentRow) => void;
  onDelete: (row: AssessmentRow) => void;
  onPresentationModeChange: (row: AssessmentRow, mode: PresentationMode) => void;
  busy: boolean;
  showOwner: boolean;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${row.title}`}
      onClick={() => onOpen(row)}
      onKeyDown={(event) => activateOnKey(event, () => onOpen(row))}
      className={cn(
        'flex cursor-pointer flex-col gap-3 border border-border bg-card p-4 transition-colors',
        'hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {/* `break-words` rather than `truncate`: a long instrument title on a 320 px screen is
              better read over two lines than cut off mid-word. */}
          <p className="break-words font-medium text-foreground">{row.title}</p>
          <TitleSubline row={row} />
        </div>
        <StatusBadge row={row} />
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <Field label="Type">
          {row.type ? row.type.name : <span className="text-muted-foreground/60">Untyped</span>}
        </Field>
        <Field label="Assignment">
          <AssignmentCell assignment={row.assignment} />
        </Field>
        <Field label="Versions">
          <VersionList versions={row.versions} />
        </Field>
        <Field label="Published">
          <DateCell value={row.published_at} emptyLabel="Never" />
        </Field>
        {showOwner ? (
          <Field label="Owner">
            <OwnerCell row={row} />
          </Field>
        ) : null}
      </dl>

      <div onClick={stop} onKeyDown={stop} className="flex flex-col gap-3">
        <PresentationModeControl
          row={row}
          onChange={onPresentationModeChange}
          busy={busy}
          fullWidth
        />

        <div className="flex flex-wrap items-center gap-1">
          <RowActions
            row={row}
            onEdit={onEdit}
            onAssign={onAssign}
            onCopy={onCopy}
            onArchive={onArchive}
            onRestore={onRestore}
            onDelete={onDelete}
            busy={busy}
            withLabels
          />
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-foreground">{children}</dd>
    </div>
  );
}

/**
 * The actions, shared by the row and the card.
 *
 * **View is gone** and that is the point of prompt §5 — it opened this assessment, and the row
 * itself now does that. **Edit stays**, because it is a different act: it opens the metadata dialog
 * (title, type, scoring methods), which is the one thing about an assessment that is editable after
 * publication and is not what the builder is for. Everything here is an act that is *not* "open it",
 * and every one of them would be a mis-click waiting to happen if the row were clickable and they
 * were not isolated from it.
 *
 * `can_manage` and `can_copy` come from the server (backend 0037) rather than being inferred from
 * `ownership` here. The controls are **disabled with the reason in their tooltip** rather than
 * hidden: a missing control is indistinguishable from a bug, and a 404 after a click is worse than
 * either.
 */
function RowActions({
  row,
  onEdit,
  onAssign,
  onCopy,
  onArchive,
  onRestore,
  onDelete,
  busy,
  withLabels = false,
}: {
  row: AssessmentRow;
  onEdit: (row: AssessmentRow) => void;
  onAssign: (row: AssessmentRow) => void;
  onCopy: (row: AssessmentRow) => void;
  onArchive: (row: AssessmentRow) => void;
  onRestore: (row: AssessmentRow) => void;
  onDelete: (row: AssessmentRow) => void;
  busy: boolean;
  withLabels?: boolean;
}) {
  const label = (text: string) => (withLabels ? <span className="text-xs">{text}</span> : null);

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="min-h-11 sm:min-h-0"
        disabled={!row.can_manage}
        aria-label={`Edit ${row.title}'s details`}
        title={row.can_manage ? 'Edit title, type and scoring' : NOT_YOURS}
        onClick={() => onEdit(row)}
      >
        <Pencil className="size-4" aria-hidden="true" />
        {label('Details')}
      </Button>

      <Button
        variant="ghost"
        size="sm"
        className="min-h-11 sm:min-h-0"
        aria-label={`Assign ${row.title}`}
        title={
          row.is_archived
            ? 'Restore this assessment before assigning it'
            : 'Assign to classes'
        }
        disabled={row.is_archived}
        onClick={() => onAssign(row)}
      >
        <Send className="size-4" aria-hidden="true" />
        {label('Assign')}
      </Button>

      {/*
        **Copy** (prompt §1) — how a counselor gets an editable RIASEC or SCCT. It is offered on
        every row the viewer can see, including their own, because taking a variant of your own
        instrument is a real thing to want; what it is never offered on is someone else's private
        one, and the server decides that.
      */}
      <Button
        variant="ghost"
        size="sm"
        className="min-h-11 sm:min-h-0"
        loading={busy}
        disabled={!row.can_copy}
        aria-label={`Make a copy of ${row.title}`}
        title={
          row.can_copy
            ? 'Make your own editable copy of this assessment'
            : 'You cannot copy this assessment.'
        }
        onClick={() => onCopy(row)}
      >
        <Copy className="size-4" aria-hidden="true" />
        {label('Copy')}
      </Button>

      {row.is_archived ? (
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11 sm:min-h-0"
          loading={busy}
          disabled={!row.can_manage}
          aria-label={`Restore ${row.title}`}
          title={row.can_manage ? 'Restore' : NOT_YOURS}
          onClick={() => onRestore(row)}
        >
          <ArchiveRestore className="size-4" aria-hidden="true" />
          {label('Restore')}
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11 sm:min-h-0"
          loading={busy}
          disabled={!row.can_manage}
          aria-label={`Archive ${row.title}`}
          title={row.can_manage ? 'Archive' : NOT_YOURS}
          onClick={() => onArchive(row)}
        >
          <Archive className="size-4" aria-hidden="true" />
          {label('Archive')}
        </Button>
      )}

      {/*
        **Disabled rather than hidden when the delete is blocked.** A missing button is
        indistinguishable from a UI bug, and the administrator is left guessing; a disabled one with
        the server's own reason in its tooltip answers "why can't I remove this?" without them
        having to try.
      */}
      <Button
        variant="ghost"
        size="sm"
        className="min-h-11 sm:min-h-0"
        disabled={!row.can_delete || !row.can_manage}
        aria-label={`Delete ${row.title}`}
        title={
          !row.can_manage
            ? NOT_YOURS
            : row.can_delete
              ? 'Delete permanently'
              : (row.delete_blocked_reason ?? 'This assessment cannot be deleted.')
        }
        onClick={() => onDelete(row)}
      >
        <Trash2
          className={cn('size-4', row.can_delete && row.can_manage && 'text-destructive')}
          aria-hidden="true"
        />
        {label('Delete')}
      </Button>
    </>
  );
}

/**
 * Sequential or random, **set from the table** (prompt §6).
 *
 * A native select rather than a toggle, because the two modes are a named choice and the label has
 * to be readable: "Random" as an unlabelled icon toggle is exactly the control someone flips by
 * accident and cannot then explain. It is disabled for a viewer who may not author this instrument,
 * with the same tooltip as every other authoring control.
 *
 * The change takes effect for **attempts started afterwards**. One already in flight keeps the order
 * it was dealt, because the order is stored on the attempt — which the hint says, since "did this
 * just reshuffle the class currently sitting it?" is the first thing anyone wonders.
 */
function PresentationModeControl({
  row,
  onChange,
  busy,
  fullWidth = false,
}: {
  row: AssessmentRow;
  onChange: (row: AssessmentRow, mode: PresentationMode) => void;
  busy: boolean;
  /**
   * **`w-full` in the card, a fixed width in the table** — and this is not a styling preference.
   *
   * `width: 100%` on a control inside an auto-layout table cell is a circular constraint: the cell
   * has no definite width to be 100% *of*, so the browser resolves it against the control's
   * preferred size and folds that into the table's min-content width. Measured, it cost this table
   * 97 px of intrinsic width and pushed the whole page into a horizontal scroll at 1280 —
   * `scripts/responsive-audit.mjs` is what caught it, and re-running it is what proves it gone.
   *
   * In the card there is no table, the container width is definite, and full width is right.
   */
  fullWidth?: boolean;
}) {
  const id = `presentation-mode-${row.id}`;

  return (
    <div className={cn('flex items-center gap-2', fullWidth && 'w-full')}>
      <Shuffle
        className={cn(
          'size-4 shrink-0',
          row.presentation_mode === 'RANDOM' ? 'text-primary' : 'text-muted-foreground/50',
        )}
        aria-hidden="true"
      />
      <label htmlFor={id} className="sr-only">
        Question order for {row.title}
      </label>
      <Select
        id={id}
        // `h-11` in the card (a phone) and `h-9` in the table (a mouse) — the same touch floor the
        // Button and Input primitives now apply, on the one control this table added.
        className={cn('text-xs', fullWidth ? 'h-11 w-full sm:h-9' : 'h-9 w-28')}
        value={row.presentation_mode}
        disabled={!row.can_manage || busy}
        title={
          row.can_manage
            ? 'Random shuffles the questions once per student, when they start. Attempts already in progress keep the order they were given.'
            : NOT_YOURS
        }
        onChange={(event) => onChange(row, event.target.value as PresentationMode)}
      >
        <option value="SEQUENTIAL">In order</option>
        <option value="RANDOM">Random</option>
      </Select>
    </div>
  );
}

/** The scoring methods and, when it is one, where the assessment was copied from. */
function TitleSubline({ row }: { row: AssessmentRow }) {
  return (
    <>
      {row.scorings.length > 0 ? (
        <p className="mt-0.5 text-xs text-muted-foreground">
          {row.scorings.map((scoring) => scoring.name).join(' · ')}
        </p>
      ) : (
        <p className="mt-0.5 text-xs text-muted-foreground/60">No scoring method set</p>
      )}
      <p className="mt-0.5 text-xs text-muted-foreground/60">
        {row.category} · created {formatDate(row.created_at)}
        {row.source_template_id !== null ? ' · copied' : ''}
      </p>
    </>
  );
}

function StatusBadge({ row }: { row: AssessmentRow }) {
  if (row.is_archived) {
    return <Badge tone="warning">Archived</Badge>;
  }

  return row.is_published ? (
    <Badge tone="success">Published</Badge>
  ) : (
    <Badge>No published version</Badge>
  );
}

/**
 * Whose instrument this is.
 *
 * `ownership` is the author *type* and `author` is the person; showing both is what makes a list of
 * six copies of RIASEC legible. "Shared" rather than "Global" because that is what it means to the
 * counselor reading it — a global assessment is one they can use, not one they own.
 */
function OwnerCell({ row }: { row: AssessmentRow }) {
  if (row.ownership === 'GLOBAL') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-foreground/80">
        <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        Shared
      </span>
    );
  }

  return (
    <span className="block break-words text-sm text-foreground/80" title={row.author?.name}>
      {row.author?.name ?? 'Private'}
    </span>
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

/**
 * A date, or an honest word for its absence.
 *
 * **"Never" and "—" are different claims and get different words.** A null `published_at` means the
 * assessment has never been published, which is a fact worth stating; a null `updated_at` would
 * mean the row is missing data. Printing an em dash for both would make the first look like a
 * rendering gap.
 *
 * The absolute date is the `title`, so the relative one ("3 days ago") stays scannable without
 * losing the precision someone auditing a rollout actually needs.
 */
function DateCell({
  value,
  emptyLabel,
  title,
}: {
  value: string | null;
  emptyLabel: string;
  title?: string | undefined;
}) {
  if (value === null) {
    return <span className="text-xs text-muted-foreground/60">{emptyLabel}</span>;
  }

  return (
    <span
      className="text-sm text-foreground/80"
      title={title ?? new Date(value).toLocaleString()}
    >
      {formatDate(value)}
    </span>
  );
}

/** `26 Jul 2026` — unambiguous in every locale, unlike a numeric day/month order. */
function formatDate(value: string | null): string {
  if (value === null) {
    return '—';
  }

  return new Date(value).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
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

/**
 * Keep a click or a key inside the actions area from reaching the clickable row behind it.
 *
 * One handler on the container rather than one per control: the ninth control someone adds is the
 * one that would have been forgotten, and the symptom — "the archive button sometimes navigates" —
 * is the kind that gets reported as flaky rather than as a bug.
 */
function stop(event: MouseEvent | KeyboardEvent) {
  event.stopPropagation();
}

/** Enter and Space activate a clickable row, as they do on a button. */
function activateOnKey(event: KeyboardEvent, action: () => void) {
  if (event.key !== 'Enter' && event.key !== ' ') {
    return;
  }

  // Space scrolls the page by default, which on a list of clickable rows is very obviously wrong.
  event.preventDefault();
  action();
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
          // `-my-3 py-3` makes the button fill its header cell rather than sitting as a 16px strip
          // inside it: the tap target becomes the whole header, which is what someone aiming at a
          // column heading is aiming at anyway, and the row height does not change.
          'inline-flex -my-3 items-center gap-1.5 py-3 uppercase tracking-wide transition-colors hover:text-foreground',
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

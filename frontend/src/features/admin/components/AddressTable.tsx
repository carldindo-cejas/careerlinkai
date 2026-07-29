import { ArrowDown, ArrowUp, ArrowUpDown, Loader2, Pencil, Trash2 } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { cn } from '@/components/ui/cn';
import type { AddressRow, AddressSort, SortDirection } from '@/types/address';
import type { Paginated } from '@/types/class';

/**
 * The searchable, sortable, paginated table shared by all four address levels — every level is a
 * flat `id · code · name · created` row, so one component serves them all.
 *
 * Search and sort are *server-side* (the query is lifted to the page, which re-fetches), so the
 * table stays correct across pages rather than sorting only the rows that happen to be loaded.
 */

interface AddressTableProps {
  noun: string;
  data: Paginated<AddressRow> | undefined;
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
  errorMessage?: string | undefined;

  search: string;
  onSearchChange: (value: string) => void;

  sort: AddressSort;
  direction: SortDirection;
  onSort: (column: AddressSort) => void;

  /**
   * No `page` prop: the current page comes from the response's own `pagination.current_page`. The
   * caller's `page` state is what it *asked* for, which is the same thing only when the request has
   * landed — one authority, not two that agree most of the time.
   */
  onPageChange: (page: number) => void;

  onEdit: (row: AddressRow) => void;
  onDelete: (row: AddressRow) => void;
  deletingId: string | null;
}

export function AddressTable({
  noun,
  data,
  isPending,
  isFetching,
  isError,
  errorMessage,
  search,
  onSearchChange,
  sort,
  direction,
  onSort,
  onPageChange,
  onEdit,
  onDelete,
  deletingId,
}: AddressTableProps) {
  return (
    <div className="flex flex-col gap-4">
      <SearchInput
        value={search}
        onChange={onSearchChange}
        label={`Search ${noun}s`}
        placeholder={`Search ${noun}s…`}
      />

      {isError ? <Alert>We could not load the {noun}s. {errorMessage}</Alert> : null}

      {isPending ? (
        <div className="flex justify-center py-12" role="status">
          <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
          <span className="sr-only">Loading {noun}s…</span>
        </div>
      ) : null}

      {data && data.items.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {search
              ? `No ${noun}s match “${search}”.`
              : `No ${noun}s yet. Use the bulk import above to add some.`}
          </CardContent>
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
                      label="Name"
                      column="name"
                      sort={sort}
                      direction={direction}
                      onSort={onSort}
                    />
                    <SortableHeader
                      label="Code"
                      column="code"
                      sort={sort}
                      direction={direction}
                      onSort={onSort}
                    />
                    <SortableHeader
                      label="Added"
                      column="created_at"
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
                    <tr key={row.id} className="border-b border-border last:border-b-0">
                      <td className="px-4 py-3 font-medium text-foreground">{row.name}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {row.code ? (
                          <span className="font-mono text-xs">{row.code}</span>
                        ) : (
                          <span className="text-muted-foreground/60">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                        {row.created_at ? new Date(row.created_at).toLocaleDateString() : '—'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Edit ${row.name}`}
                            onClick={() => onEdit(row)}
                          >
                            <Pencil className="size-4" aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={deletingId === row.id}
                            aria-label={`Delete ${row.name}`}
                            onClick={() => onDelete(row)}
                          >
                            <Trash2 className="size-4" aria-hidden="true" />
                          </Button>
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
        <Pagination
          pagination={data.pagination}
          onPageChange={onPageChange}
          noun={`${noun}s`}
          isFetching={isFetching}
        />
      ) : null}
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
  column: AddressSort;
  sort: AddressSort;
  direction: SortDirection;
  onSort: (column: AddressSort) => void;
}) {
  const active = sort === column;
  const Icon = active ? (direction === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;

  return (
    <th className="px-4 py-3 font-medium">
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

import { Button } from '@/components/ui/button';
import type { Paginated } from '@/types/class';

/**
 * The Previous/Next pager for a server-paginated list.
 *
 * Extracted from `AddressTable` for the same reason as `SearchInput`: P3-2 added four more lists,
 * and a pager copied five times is five chances to get `disabled` wrong in a way that only shows
 * up on the last page of a list nobody has grown yet.
 *
 * **It renders nothing when there is one page.** That is deliberate and it is why the whole
 * `pagination` object is the prop rather than a page number: a control that says "Page 1 of 1" with
 * both buttons greyed out is furniture, and the lists this appears on are one page long until the
 * catalog grows.
 */
export interface PaginationProps {
  pagination: Paginated<unknown>['pagination'];
  onPageChange: (page: number) => void;
  /** Pluralised by the caller — "colleges", "careers" — for the "· 42 careers" summary. */
  noun: string;
  /** True while a page is in flight, so the buttons cannot queue a second jump. */
  isFetching?: boolean;
}

export function Pagination({ pagination, onPageChange, noun, isFetching = false }: PaginationProps) {
  if (pagination.last_page <= 1) return null;

  const { current_page: page, last_page: lastPage, total } = pagination;

  return (
    <nav className="flex items-center justify-between" aria-label={`${noun} pages`}>
      <p className="text-sm text-muted-foreground">
        Page {page} of {lastPage} · {total} {noun}
      </p>

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
          disabled={page >= lastPage || isFetching}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </Button>
      </div>
    </nav>
  );
}

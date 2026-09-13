import { useState } from 'react';

import type { Paginated } from '@/types/class';

/**
 * Slices an already-fetched list into pages, in the shape `<Pagination>` expects.
 *
 * Several lists fetch their whole (small) collection in one request and filter it in the browser —
 * the public catalog pages, a class roster, a counselor's students — so there is no server page to
 * ask for, but a class of sixty still should not render sixty rows at once. This is the client-side
 * counterpart to the server pagination the admin lists use, deliberately returning the same
 * `pagination` object so every list in the app shares one pager.
 *
 * The current page is *clamped* rather than reset by an effect: when a filter narrows the list from
 * four pages to one while the reader sits on page 3, the clamp lands them on the last real page on
 * the very same render, with no flash of an empty list.
 */
export interface ClientPagination<TItem> {
  pageItems: TItem[];
  pagination: Paginated<unknown>['pagination'];
  setPage: (page: number) => void;
}

export function useClientPagination<TItem>(items: TItem[], perPage: number): ClientPagination<TItem> {
  const [requestedPage, setRequestedPage] = useState(1);

  const total = items.length;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const currentPage = Math.min(Math.max(requestedPage, 1), lastPage);

  const start = (currentPage - 1) * perPage;

  return {
    pageItems: items.slice(start, start + perPage),
    pagination: { current_page: currentPage, per_page: perPage, total, last_page: lastPage },
    setPage: setRequestedPage,
  };
}

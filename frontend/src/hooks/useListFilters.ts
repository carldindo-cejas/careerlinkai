import { useEffect, useState } from 'react';

import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '@/hooks/useDebouncedValue';

/**
 * The state behind a searchable, filterable, paginated list (§20's list surfaces).
 *
 * Four pages needed the identical five pieces of state and the identical rule between them, so the
 * rule lives here once:
 *
 * **Changing a filter returns to page one.** Page 4 of an unfiltered list rarely exists in the
 * filtered one, and a request for a page past the last comes back with an empty `items` — so a user
 * who searches while on page 4 gets a blank list and no matches count, which reads as "nothing
 * found" for a term that may have dozens of hits. Getting this wrong on one page out of four is
 * exactly the kind of thing that survives review, which is why it is not written four times.
 *
 * `searchInput` is what the box shows (every keystroke); `search` is what the query uses (one value
 * per pause). Both are returned because a component needs the first for the input's `value` and the
 * second for its "no results for X" message — using `searchInput` for the message would name a term
 * the list has not been filtered by yet.
 */
export interface ListFilters<TStatus extends string> {
  searchInput: string;
  setSearchInput: (value: string) => void;
  /** The debounced term — `undefined` when empty, so it can be spread straight into a query. */
  search: string | undefined;
  status: TStatus | '';
  setStatus: (value: TStatus | '') => void;
  page: number;
  setPage: (page: number) => void;
}

export function useListFilters<TStatus extends string = string>(): ListFilters<TStatus> {
  const [searchInput, setSearchInput] = useState('');
  const [status, setStatus] = useState<TStatus | ''>('');
  const [page, setPage] = useState(1);

  const debounced = useDebouncedValue(searchInput, SEARCH_DEBOUNCE_MS);
  const search = debounced.trim() === '' ? undefined : debounced.trim();

  useEffect(() => setPage(1), [search, status]);

  return { searchInput, setSearchInput, search, status, setStatus, page, setPage };
}

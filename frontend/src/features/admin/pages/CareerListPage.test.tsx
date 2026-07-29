import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { CareerListPage } from '@/features/admin/pages/CareerListPage';
import { catalogApi } from '@/services/catalogApi';
import type { Career } from '@/types/catalog';

vi.mock('@/services/catalogApi');

/**
 * Catalog list search, filter and paging (audit F4, plan item P3-2).
 *
 * The careers page is the one tested of the four because it carries every control the others do —
 * a search box, a status filter, a sort and a pager — and because the state behind all four lives
 * in one shared `useListFilters`. The rule tested here that matters most is the one that is easy to
 * get right on three pages out of four, which is exactly why it is not written four times.
 */

function career(id: string, title: string, status: 'active' | 'archived' = 'active'): Career {
  return {
    id,
    title,
    description: null,
    salary_min: null,
    salary_max: null,
    employment_outlook_id: null,
    employment_outlook: null,
    typical_riasec_code: 'IEC',
    status,
    created_at: null,
    updated_at: null,
  };
}

function page(items: Career[], total = items.length, currentPage = 1) {
  return {
    items,
    pagination: {
      current_page: currentPage,
      per_page: 20,
      total,
      last_page: Math.max(1, Math.ceil(total / 20)),
    },
  };
}

function renderPage() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <CareerListPage />
    </QueryClientProvider>,
  );

  return userEvent.setup();
}

/** The most recent `listCareers` query, which is what the screen is actually showing. */
function lastQuery() {
  const calls = vi.mocked(catalogApi.listCareers).mock.calls;

  return calls[calls.length - 1]?.[0];
}

describe('CareerListPage', () => {
  beforeEach(() => {
    vi.mocked(catalogApi.listCareers).mockReset();
    vi.mocked(catalogApi.listCareers).mockResolvedValue(
      page([career('c-1', 'Software Engineer'), career('c-2', 'Data Analyst')]),
    );
  });

  it('asks the server for page one by title on first load', async () => {
    renderPage();

    expect(await screen.findByText('Software Engineer')).toBeInTheDocument();
    expect(lastQuery()).toMatchObject({
      search: undefined,
      status: undefined,
      page: 1,
      sort: 'name',
      direction: 'asc',
    });
  });

  /**
   * Search is **server-side**. It was tempting to filter the loaded page in the browser — it is
   * fewer moving parts and looks identical on a catalog that fits on one page. It is also exactly
   * the mistake audit F3 records: a filter over the rows you happen to have is not a search, it is
   * a search of page one wearing a search's clothes.
   */
  it('sends the typed term to the server, once the typing stops', async () => {
    const user = renderPage();

    await screen.findByText('Software Engineer');

    await user.type(screen.getByLabelText(/search careers/i), 'nurse');

    await waitFor(() => expect(lastQuery()).toMatchObject({ search: 'nurse' }));

    // Debounced: five keystrokes are not five requests. One for the initial load, one for the
    // settled term — anything more is a request per keystroke against a paginated endpoint.
    expect(vi.mocked(catalogApi.listCareers).mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('sends the status filter to the server', async () => {
    const user = renderPage();

    await screen.findByText('Software Engineer');

    await user.selectOptions(screen.getByLabelText(/filter by status/i), 'archived');

    await waitFor(() => expect(lastQuery()).toMatchObject({ status: 'archived' }));
  });

  it('sends the sort, newest-first descending', async () => {
    const user = renderPage();

    await screen.findByText('Software Engineer');

    await user.selectOptions(screen.getByLabelText(/sort careers/i), 'created_at');

    await waitFor(() =>
      expect(lastQuery()).toMatchObject({ sort: 'created_at', direction: 'desc' }),
    );
  });

  /**
   * **Searching returns to page one.** Page 4 of an unfiltered catalog rarely exists in the
   * filtered one, and a request past the last page comes back with an empty `items` — so an admin
   * who searches while on page 4 would see "no matching careers" for a term with dozens of hits.
   * The rule lives in `useListFilters` so all four list pages get it; this is where it is proved.
   */
  it('returns to page one when the search changes', async () => {
    vi.mocked(catalogApi.listCareers).mockResolvedValue(
      page([career('c-1', 'Software Engineer')], 60, 1),
    );

    const user = renderPage();

    await screen.findByText('Software Engineer');
    await user.click(screen.getByRole('button', { name: /next/i }));

    await waitFor(() => expect(lastQuery()).toMatchObject({ page: 2 }));

    await user.type(screen.getByLabelText(/search careers/i), 'nurse');

    await waitFor(() => expect(lastQuery()).toMatchObject({ search: 'nurse', page: 1 }));
  });

  it('pages through the list', async () => {
    vi.mocked(catalogApi.listCareers).mockResolvedValue(
      page([career('c-1', 'Software Engineer')], 60, 1),
    );

    const user = renderPage();

    expect(await screen.findByText(/page 1 of 3 · 60 careers/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /next/i }));

    await waitFor(() => expect(lastQuery()).toMatchObject({ page: 2 }));
  });

  it('hides the pager when everything fits on one page', async () => {
    renderPage();

    await screen.findByText('Software Engineer');

    // A "Page 1 of 1" with both buttons greyed out is furniture, and the catalog is one page long
    // until it is not.
    expect(screen.queryByRole('button', { name: /next/i })).not.toBeInTheDocument();
  });

  /**
   * Two empty states, because they call for two different actions: an empty catalog wants "add a
   * career", an empty *filter* wants "that term matched nothing". Showing the first when a search
   * matched nothing tells an admin their catalog is empty, which is a lie with consequences —
   * §27 ranks from this table.
   */
  it('distinguishes an empty catalog from a search that matched nothing', async () => {
    vi.mocked(catalogApi.listCareers).mockResolvedValue(page([], 0));

    const user = renderPage();

    expect(await screen.findByText(/no careers yet/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/search careers/i), 'zzz');

    expect(await screen.findByText(/no matching careers/i)).toBeInTheDocument();
    expect(screen.getByText(/“zzz”/)).toBeInTheDocument();
    expect(screen.queryByText(/no careers yet/i)).not.toBeInTheDocument();
  });

  /**
   * `type="search"` renders a native clear affordance in Chrome and Safari and **nothing** in
   * Firefox, so the box carries its own — a filter a user cannot see how to remove is a list that
   * looks broken.
   *
   * Asserted against what is on screen rather than against a new request: returning to the
   * unfiltered term is a cache hit, and react-query correctly serves it without calling the API
   * again. Asserting "the query was re-sent" would be asserting the absence of caching.
   */
  it('clears the search from the box itself', async () => {
    vi.mocked(catalogApi.listCareers).mockImplementation((query = {}) =>
      Promise.resolve(
        query.search === undefined
          ? page([career('c-1', 'Software Engineer'), career('c-2', 'Data Analyst')])
          : page([career('c-9', 'Nurse Practitioner')]),
      ),
    );

    const user = renderPage();

    await screen.findByText('Software Engineer');

    const box = screen.getByLabelText(/search careers/i);

    await user.type(box, 'nurse');

    expect(await screen.findByText('Nurse Practitioner')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /clear search careers/i }));

    expect(box).toHaveValue('');
    expect(await screen.findByText('Software Engineer')).toBeInTheDocument();
    expect(screen.queryByText('Nurse Practitioner')).not.toBeInTheDocument();
  });
});

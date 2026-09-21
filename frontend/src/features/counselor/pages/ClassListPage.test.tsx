import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { ClassListPage } from '@/features/counselor/pages/ClassListPage';
import { classApi } from '@/services/classApi';
import type { ClassRoom, Paginated } from '@/types/class';

vi.mock('@/services/classApi');

/**
 * The classes screen (prompt-driven, 2026-09-20): six cards a page, at every width.
 *
 * The page size is the thing worth a test. It is a number sent to the server, not a CSS rule, so
 * nothing about the rendered grid would catch it drifting back to the server's default of twenty —
 * the page would simply get longer, which is exactly the bug that was asked to be fixed.
 */

function classRoom(index: number): ClassRoom {
  return {
    id: `3333333${index}-3333-4333-8333-333333333333`,
    counselor_id: '11111111-1111-4111-8111-111111111111',
    name: `Grade 12 STEM ${index}`,
    academic_year: '2026-2027',
    grade_level_id: null,
    shs_strand_id: null,
    grade_level: 'Grade 12',
    shs_strand: null,
    join_code: `HVJE-000${index}`,
    join_code_expires_at: null,
    status: 'active',
    created_at: null,
    updated_at: null,
  };
}

function page(current: number, lastPage: number): Paginated<ClassRoom> {
  return {
    items: Array.from({ length: 6 }, (_, index) => classRoom(current * 10 + index)),
    pagination: {
      current_page: current,
      last_page: lastPage,
      per_page: 6,
      total: lastPage * 6,
    },
  };
}

function renderPage() {
  const person = userEvent.setup();

  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <ClassListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return person;
}

describe('ClassListPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('asks for six classes a page', async () => {
    vi.mocked(classApi.list).mockResolvedValue(page(1, 3));

    renderPage();

    await waitFor(() => expect(classApi.list).toHaveBeenCalledWith(1, 6));
    expect(await screen.findByText('Grade 12 STEM 10')).toBeInTheDocument();
  });

  it('pages without changing the size', async () => {
    vi.mocked(classApi.list).mockImplementation((requested = 1) =>
      Promise.resolve(page(requested, 3)),
    );

    const person = renderPage();

    await screen.findByText('Grade 12 STEM 10');
    await person.click(screen.getByRole('button', { name: /next/i }));

    await waitFor(() => expect(classApi.list).toHaveBeenCalledWith(2, 6));
    expect(await screen.findByText('Grade 12 STEM 20')).toBeInTheDocument();
  });

  /** One page is one page: a pager that greys both its buttons out is furniture. */
  it('renders no pager when everything fits on one page', async () => {
    vi.mocked(classApi.list).mockResolvedValue(page(1, 1));

    renderPage();

    await screen.findByText('Grade 12 STEM 10');
    expect(screen.queryByRole('button', { name: /next/i })).not.toBeInTheDocument();
  });
});

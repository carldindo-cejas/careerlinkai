import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { CollegeDetailPage } from '@/features/admin/pages/CollegeDetailPage';
import { catalogApi } from '@/services/catalogApi';
import type { College, Program } from '@/types/catalog';

vi.mock('@/services/catalogApi');

/**
 * A college's programs (2026-09-21) — the table, and the two things that changed with it.
 *
 * The list used to be one card per program with a career picker inside each, and a **Delete**
 * button on every card. Deleting a program takes its career links and every recommendation pointing
 * at it with it, so a student who was shown "BS Nursing at HNU" last week loses the row that says
 * so. Archiving drops it out of §27's ranking and leaves the history readable. The distinction is
 * the point of the change, and the assertion below is what stops the delete call coming back.
 *
 * The rest is the shape: rows rather than cards, a row opens the editor, and the editor floats over
 * the list instead of pushing twenty rows down the page.
 */

const PROGRAM: Program = {
  id: 'prog-1',
  college_id: 'col-1',
  code: 'BSCS',
  name: 'BS Computer Science',
  department_name: 'College of Computer Studies',
  description: null,
  recommended_strand: 'Academic',
  status: 'active',
  program_catalog_id: null,
  careers: [],
  created_at: null,
  updated_at: null,
};

const COLLEGE: College = {
  id: 'col-1',
  name: 'Bohol Island State University',
  description: null,
  status: 'active',
  region: null,
  province: null,
  town: null,
  barangay: null,
  map_link: null,
  programs: [PROGRAM],
  created_at: null,
  updated_at: null,
};

async function renderPage(college: College = COLLEGE) {
  vi.mocked(catalogApi.getCollege).mockResolvedValue(college);
  vi.mocked(catalogApi.updateProgram).mockResolvedValue({ ...PROGRAM, status: 'archived' });

  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/admin/colleges/col-1']}>
        <Routes>
          <Route path="/admin/colleges/:collegeId" element={<CollegeDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  await screen.findByRole('heading', { name: COLLEGE.name });

  return userEvent.setup();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the programs list', () => {
  it('is a table, and a row carries what the narrow columns hide', async () => {
    await renderPage();

    const row = screen.getByRole('row', { name: /BS Computer Science/ });

    expect(within(row).getByText('BSCS')).toBeInTheDocument();
    expect(within(row).getByText('active')).toBeInTheDocument();
    // The strand column is hidden below `md`; the same fact is repeated under the name so a phone
    // is short of a column rather than short of the information.
    expect(within(row).getAllByText(/Academic/).length).toBeGreaterThan(0);
  });

  it('opens the editor in a dialog when a row is chosen', async () => {
    const user = await renderPage();

    await user.click(screen.getByRole('button', { name: /BSCS.*BS Computer Science/ }));

    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByRole('heading', { name: 'Edit BSCS' })).toBeInTheDocument();
    // The career mapping moved into the editor with the rest of the program's fields — in a table
    // it has nowhere else to live, and linking careers *is* editing the program.
    expect(within(dialog).getByText(/Careers this program leads to/i)).toBeInTheDocument();
  });
});

describe('retiring a program', () => {
  it('archives it rather than deleting it', async () => {
    const user = await renderPage();

    await user.click(screen.getByRole('button', { name: 'Archive BSCS' }));

    await waitFor(() =>
      expect(catalogApi.updateProgram).toHaveBeenCalledWith('prog-1', { status: 'archived' }),
    );

    // The assertion that matters. A delete would cascade to every recommendation naming this
    // program, and a student's history would lose the row that explains a card they were shown.
    expect(catalogApi.removeProgram).not.toHaveBeenCalled();
  });

  it('offers to restore one that is already archived', async () => {
    const user = await renderPage({
      ...COLLEGE,
      programs: [{ ...PROGRAM, status: 'archived' }],
    });

    await user.click(screen.getByRole('button', { name: 'Restore BSCS' }));

    await waitFor(() =>
      expect(catalogApi.updateProgram).toHaveBeenCalledWith('prog-1', { status: 'active' }),
    );
  });

  it('keeps Delete on the college itself, which is a different decision', async () => {
    await renderPage();

    // Archiving a college is the intended retirement (§8); deleting one is the harsher, rarer act
    // and is still offered here, worded as such.
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
  });
});

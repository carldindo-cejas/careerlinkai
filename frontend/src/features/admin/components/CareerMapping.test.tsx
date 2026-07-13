import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { CareerMapping } from '@/features/admin/components/CareerMapping';
import { catalogApi } from '@/services/catalogApi';
import type { Career, Program } from '@/types/catalog';

vi.mock('@/services/catalogApi');

const COLLEGE_ID = '11111111-1111-4111-8111-111111111111';
const PROGRAM_ID = '22222222-2222-4222-8222-222222222222';

function career(id: string, title: string, code: string | null): Career {
  return {
    id,
    title,
    description: null,
    salary_range: null,
    employment_outlook: null,
    typical_riasec_code: code,
    status: 'active',
    created_at: null,
    updated_at: null,
  };
}

const SOFTWARE_ENGINEER = career('c-1', 'Software Engineer', 'IEC');
const DATA_ANALYST = career('c-2', 'Data Analyst', 'ICE');

function program(careers: Career[] = []): Program {
  return {
    id: PROGRAM_ID,
    college_id: COLLEGE_ID,
    code: 'BSCS',
    name: 'BS Computer Science',
    department_name: null,
    description: null,
    recommended_strand: 'Academic',
    status: 'active',
    careers,
    created_at: null,
    updated_at: null,
  };
}

function renderMapping(linked: Career[] = []) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <CareerMapping collegeId={COLLEGE_ID} program={program(linked)} />
    </QueryClientProvider>,
  );

  return userEvent.setup();
}

describe('CareerMapping', () => {
  beforeEach(() => {
    vi.mocked(catalogApi.listCareers).mockReset();
    vi.mocked(catalogApi.attachCareer).mockReset();
    vi.mocked(catalogApi.detachCareer).mockReset();

    vi.mocked(catalogApi.listCareers).mockResolvedValue({
      items: [SOFTWARE_ENGINEER, DATA_ANALYST],
      pagination: { current_page: 1, per_page: 100, total: 2, last_page: 1 },
    });
  });

  it('links a career to the program', async () => {
    vi.mocked(catalogApi.attachCareer).mockResolvedValue(program([SOFTWARE_ENGINEER]));

    const user = renderMapping();

    await user.selectOptions(
      await screen.findByLabelText(/link a career to bscs/i),
      SOFTWARE_ENGINEER.id,
    );
    await user.click(screen.getByRole('button', { name: /^link$/i }));

    await waitFor(() => {
      expect(catalogApi.attachCareer).toHaveBeenCalledWith(PROGRAM_ID, SOFTWARE_ENGINEER.id);
    });
  });

  /**
   * The mapping is a set: re-attaching a career would give it two votes in §27's average
   * and quietly bend the program's score, so the server rejects it with a 422. Offering an
   * option that can only fail is a trap, so an already-linked career is not in the list.
   */
  it('does not offer a career that is already linked', async () => {
    renderMapping([SOFTWARE_ENGINEER]);

    const select = await screen.findByLabelText(/link a career to bscs/i);

    expect(
      screen.getByRole('option', { name: /data analyst/i, hidden: true }),
    ).toBeInTheDocument();
    expect(select).not.toHaveTextContent('Software Engineer (IEC)');
  });

  it('unlinks a linked career', async () => {
    vi.mocked(catalogApi.detachCareer).mockResolvedValue(program([]));

    const user = renderMapping([SOFTWARE_ENGINEER]);

    await user.click(
      screen.getByRole('button', { name: /unlink software engineer from bscs/i }),
    );

    await waitFor(() => {
      expect(catalogApi.detachCareer).toHaveBeenCalledWith(PROGRAM_ID, SOFTWARE_ENGINEER.id);
    });
  });

  /**
   * An empty mapping is a scoring decision, not an empty field — §27 falls back to a
   * neutral 50 for a program with no linked careers, so the screen says what that means
   * rather than leaving a blank space the admin reads as "nothing to do here".
   */
  it('says what an unmapped program means, rather than showing nothing', async () => {
    renderMapping([]);

    expect(
      await screen.findByText(/cannot be matched to a student's RIASEC profile/i),
    ).toBeInTheDocument();
  });

  it('shows the Holland code alongside each linked career', async () => {
    renderMapping([SOFTWARE_ENGINEER, DATA_ANALYST]);

    expect(await screen.findByText('IEC')).toBeInTheDocument();
    expect(screen.getByText('ICE')).toBeInTheDocument();
  });

  /**
   * An archived career is not offered for linking. The server refuses it, and it would not
   * count toward the program's score even if it did (§8, §27) — a mapping row that is inert
   * on the day it is made is not something to put in a dropdown.
   */
  it('does not offer an archived career', async () => {
    const retired = career('c-3', 'Switchboard Operator', 'RCE');
    retired.status = 'archived';

    vi.mocked(catalogApi.listCareers).mockResolvedValue({
      items: [SOFTWARE_ENGINEER, retired],
      pagination: { current_page: 1, per_page: 100, total: 2, last_page: 1 },
    });

    renderMapping();

    await screen.findByLabelText(/link a career to bscs/i);

    expect(
      screen.getByRole('option', { name: /software engineer/i, hidden: true }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: /switchboard operator/i, hidden: true }),
    ).not.toBeInTheDocument();
  });

  /**
   * A career archived *after* it was linked keeps its link — but stops counting toward the
   * program's RIASEC average (§27). A chip that looks live while scoring nothing is worse
   * than no chip, so it says so.
   */
  it('marks a linked career that has since been archived as no longer counted', async () => {
    const retired = career('c-3', 'Switchboard Operator', 'RCE');
    retired.status = 'archived';

    renderMapping([SOFTWARE_ENGINEER, retired]);

    expect(await screen.findByText(/archived — not counted/i)).toBeInTheDocument();

    // Still linked — archiving does not silently unlink it.
    expect(
      screen.getByRole('button', { name: /unlink switchboard operator from bscs/i }),
    ).toBeInTheDocument();
  });
});

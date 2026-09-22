import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { CareerMapping } from '@/features/admin/components/CareerMapping';
import { catalogApi } from '@/services/catalogApi';
import type { Career, LinkedCareer, Program } from '@/types/catalog';

vi.mock('@/services/catalogApi');

const COLLEGE_ID = '11111111-1111-4111-8111-111111111111';
const PROGRAM_ID = '22222222-2222-4222-8222-222222222222';

function career(id: string, title: string, code: string | null): Career {
  return {
    id,
    title,
    description: null,
    salary_min: null,
    salary_max: null,
    employment_outlook_id: null,
    employment_outlook: null,
    typical_riasec_code: code,
    status: 'active',
    created_at: null,
    updated_at: null,
  };
}

const SOFTWARE_ENGINEER = career('c-1', 'Software Engineer', 'IEC');
const DATA_ANALYST = career('c-2', 'Data Analyst', 'ICE');

function page(items: Career[], total = items.length) {
  return {
    items,
    pagination: { current_page: 1, per_page: 20, total, last_page: Math.ceil(total / 20) || 1 },
  };
}

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
    program_catalog_id: null,
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

/** Open the picker and wait for its first result set. */
async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByLabelText(/link a career to bscs/i));

  return screen.findByLabelText(/search careers/i);
}

describe('CareerMapping', () => {
  beforeEach(() => {
    vi.mocked(catalogApi.listCareers).mockReset();
    vi.mocked(catalogApi.attachCareer).mockReset();
    vi.mocked(catalogApi.detachCareer).mockReset();

    vi.mocked(catalogApi.listCareers).mockResolvedValue(page([SOFTWARE_ENGINEER, DATA_ANALYST]));
  });

  /**
   * The picker is server-backed (audit F3), which makes *when* it fetches a real question: a
   * college page renders one `CareerMapping` per program, so a hook that fetched on mount would
   * fire one request per program before the admin had touched anything. Same guarantee, and same
   * assertion shape, as the counselor recommendations panel in P2-1.
   */
  it('fetches nothing until the picker is opened', async () => {
    const user = renderMapping();

    await screen.findByLabelText(/link a career to bscs/i);

    expect(catalogApi.listCareers).not.toHaveBeenCalled();

    await openPicker(user);

    await waitFor(() => expect(catalogApi.listCareers).toHaveBeenCalled());
  });

  /**
   * `status: 'active'` is sent to the **server**, not applied to the response. An archived career
   * cannot be linked (§8, §27), so filtering it out here would spend rows of a 20-row page on
   * options that can only fail — the page would look short for no visible reason.
   */
  it('asks the server for active careers only, one page at a time', async () => {
    const user = renderMapping();

    await openPicker(user);

    await waitFor(() =>
      expect(catalogApi.listCareers).toHaveBeenCalledWith({
        search: undefined,
        status: 'active',
        per_page: 20,
      }),
    );
  });

  /**
   * **The F3 fix, at the seam where it broke.** The picker used to load `per_page: 100` and filter
   * it in the browser, so a career past the hundredth was simply not in the list — no empty state,
   * no error, nothing to distinguish "no such career" from "past the page you were given". The
   * catalog is 68 careers after P0-1, so the margin was one expansion wide.
   *
   * Here the first page deliberately does **not** contain the target: it is reachable only because
   * the term reaches the server.
   */
  it('finds a career that is not on the first page, by typing', async () => {
    vi.mocked(catalogApi.listCareers).mockImplementation((query = {}) =>
      Promise.resolve(
        query.search === undefined
          ? page(
              Array.from({ length: 20 }, (_, index) =>
                career(`filler-${index}`, `Filler Career ${index}`, 'RIA'),
              ),
              150,
            )
          : page([career('c-150', 'Zythologist', 'IRE')], 1),
      ),
    );

    const user = renderMapping();
    const searchBox = await openPicker(user);

    expect(await screen.findByRole('option', { name: /filler career 0/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /zythologist/i })).not.toBeInTheDocument();

    await user.type(searchBox, 'zyth');

    await waitFor(() =>
      expect(catalogApi.listCareers).toHaveBeenCalledWith({
        search: 'zyth',
        status: 'active',
        per_page: 20,
      }),
    );

    expect(await screen.findByRole('option', { name: /zythologist/i })).toBeInTheDocument();
  });

  /**
   * The other half of F3: when the server holds more matches than one page shows, the picker
   * **says so**. Silently showing the first 20 of 150 is precisely the behaviour that made the
   * original defect invisible — the list looked complete because nothing said it was not.
   */
  it('says when there are more matches than it is showing', async () => {
    vi.mocked(catalogApi.listCareers).mockResolvedValue(
      page(
        Array.from({ length: 20 }, (_, index) =>
          career(`filler-${index}`, `Filler Career ${index}`, 'RIA'),
        ),
        150,
      ),
    );

    const user = renderMapping();

    await openPicker(user);

    expect(await screen.findByText(/showing 20 of 150/i)).toBeInTheDocument();
  });

  it('does not claim there are more when the page holds them all', async () => {
    const user = renderMapping();

    await openPicker(user);

    await screen.findByRole('option', { name: /software engineer/i });
    expect(screen.queryByText(/showing \d+ of/i)).not.toBeInTheDocument();
  });

  it('links the career chosen from the picker', async () => {
    vi.mocked(catalogApi.attachCareer).mockResolvedValue(program([SOFTWARE_ENGINEER]));

    const user = renderMapping();

    await openPicker(user);
    await user.click(await screen.findByRole('option', { name: /software engineer/i }));
    await user.click(screen.getByRole('button', { name: /^link$/i }));

    await waitFor(() => {
      expect(catalogApi.attachCareer).toHaveBeenCalledWith(
        PROGRAM_ID,
        SOFTWARE_ENGINEER.id,
        'direct',
      );
    });
  });

  /** Nothing is chosen yet, so there is nothing to link — the button says so rather than 422-ing. */
  it('cannot be submitted before a career is chosen', async () => {
    renderMapping();

    expect(await screen.findByRole('button', { name: /^link$/i })).toBeDisabled();
  });

  /**
   * The mapping is a set: re-attaching a career would give it two votes in §27's average and
   * quietly bend the program's score, so the server rejects it with a 422. This exclusion stays
   * client-side because it *has* to — "already linked to this program" is a fact about the program,
   * and the careers endpoint knows nothing about programs.
   */
  it('does not offer a career that is already linked', async () => {
    const user = renderMapping([SOFTWARE_ENGINEER]);

    await openPicker(user);

    expect(await screen.findByRole('option', { name: /data analyst/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /software engineer/i })).not.toBeInTheDocument();
  });

  it('distinguishes "no match for that term" from "no careers at all"', async () => {
    vi.mocked(catalogApi.listCareers).mockResolvedValue(page([], 0));

    const user = renderMapping();
    const searchBox = await openPicker(user);

    expect(await screen.findByText(/no careers in the catalog yet/i)).toBeInTheDocument();

    await user.type(searchBox, 'zzz');

    expect(await screen.findByText(/no active career matches “zzz”/i)).toBeInTheDocument();
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

/**
 * Inherited links (backend migration 0040). What a program leads to is linked once on its canonical
 * program and every offering inherits it; this screen may only add and remove this college's extras.
 */
describe('CareerMapping with inherited careers', () => {
  function renderInherited(linked: LinkedCareer[]) {
    render(
      <MemoryRouter>
        <QueryClientProvider client={createQueryClient()}>
          <CareerMapping
            collegeId={COLLEGE_ID}
            program={{
              ...program(linked),
              program_catalog_id: 'canonical-1',
              canonical: {
                id: 'canonical-1',
                code: 'BSCS',
                name: 'BS Computer Science',
                description: null,
                status: 'active',
                recommended_strand: 'Academic',
                created_at: null,
                updated_at: null,
              },
            }}
          />
        </QueryClientProvider>
      </MemoryRouter>,
    );

    return userEvent.setup();
  }

  beforeEach(() => {
    vi.mocked(catalogApi.listCareers).mockReset();
    vi.mocked(catalogApi.detachCareer).mockReset();
    vi.mocked(catalogApi.setCareerRelationship).mockReset();
    vi.mocked(catalogApi.listCareers).mockResolvedValue(page([SOFTWARE_ENGINEER, DATA_ANALYST]));
  });

  /** Removing it here would make this one campus score differently from its twins. */
  it('marks an inherited career with its source and offers no unlink for it', async () => {
    renderInherited([{ ...SOFTWARE_ENGINEER, inherited: true }]);

    // Scoped to the chips: the explanatory line above them names the source too.
    expect(within(await screen.findByRole('list')).getByText('from BSCS')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /unlink software engineer from bscs/i }),
    ).not.toBeInTheDocument();
  });

  it('still lets a college remove its own extra', async () => {
    vi.mocked(catalogApi.detachCareer).mockResolvedValue(program([]));

    const user = renderInherited([
      { ...SOFTWARE_ENGINEER, inherited: true },
      { ...DATA_ANALYST, inherited: false },
    ]);

    await user.click(screen.getByRole('button', { name: /unlink data analyst from bscs/i }));

    await waitFor(() => {
      expect(catalogApi.detachCareer).toHaveBeenCalledWith(PROGRAM_ID, DATA_ANALYST.id);
    });
  });

  it('points to the Canonical programs page for the inherited ones', async () => {
    renderInherited([{ ...SOFTWARE_ENGINEER, inherited: true }]);

    expect(await screen.findByRole('link', { name: /canonical programs/i })).toHaveAttribute(
      'href',
      '/admin/canonical-programs',
    );
  });

  /**
   * Re-grading (backend migration 0041). A chip is selected first and only then shows its pencil,
   * so thirty graded chips do not read as thirty open forms.
   */
  it('shows the pencil only on the selected chip', async () => {
    const user = renderInherited([
      { ...SOFTWARE_ENGINEER, inherited: true, relationship: 'direct' },
      { ...DATA_ANALYST, inherited: true, relationship: 'related' },
    ]);

    expect(screen.queryByRole('button', { name: /edit how strongly/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /software engineer/i, pressed: false }));

    expect(
      screen.getByRole('button', { name: /edit how strongly bscs leads to software engineer/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /edit how strongly bscs leads to data analyst/i }),
    ).not.toBeInTheDocument();
  });

  /**
   * An inherited link lives on the canonical program — the offering endpoint would 422 it — so the
   * grade is written there, and the picker says every college gets it before the admin saves.
   */
  it('re-grades an inherited career on its canonical program', async () => {
    vi.mocked(catalogApi.setCanonicalCareerRelationship).mockReset();
    vi.mocked(catalogApi.setCanonicalCareerRelationship).mockResolvedValue({
      id: 'canonical-1',
      code: 'BSCS',
      name: 'BS Computer Science',
      description: null,
      status: 'active',
      recommended_strand: 'Academic',
      created_at: null,
      updated_at: null,
    });

    const user = renderInherited([{ ...SOFTWARE_ENGINEER, inherited: true, relationship: 'direct' }]);

    await user.click(screen.getByRole('button', { name: /software engineer/i, pressed: false }));
    await user.click(
      screen.getByRole('button', { name: /edit how strongly bscs leads to software engineer/i }),
    );

    expect(screen.getByText(/applies to every college that offers it/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: /conditional/i }));
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(catalogApi.setCanonicalCareerRelationship).toHaveBeenCalledWith(
        'canonical-1',
        SOFTWARE_ENGINEER.id,
        'conditional',
      );
    });
    expect(catalogApi.setCareerRelationship).not.toHaveBeenCalled();
  });

  it('re-grades a college extra on the offering itself', async () => {
    vi.mocked(catalogApi.setCareerRelationship).mockReset();
    vi.mocked(catalogApi.setCareerRelationship).mockResolvedValue(program([]));

    const user = renderInherited([{ ...DATA_ANALYST, inherited: false, relationship: 'direct' }]);

    await user.click(screen.getByRole('button', { name: /data analyst/i, pressed: false }));
    await user.click(
      screen.getByRole('button', { name: /edit how strongly bscs leads to data analyst/i }),
    );

    expect(screen.queryByText(/applies to every college/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /related/i }));
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(catalogApi.setCareerRelationship).toHaveBeenCalledWith(
        PROGRAM_ID,
        DATA_ANALYST.id,
        'related',
      );
    });
  });

  it('does not offer an inherited career in the picker', async () => {
    const user = renderInherited([{ ...SOFTWARE_ENGINEER, inherited: true }]);

    await openPicker(user);

    expect(await screen.findByRole('option', { name: /data analyst/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /software engineer/i })).not.toBeInTheDocument();
  });
});

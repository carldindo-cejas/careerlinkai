import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { CanonicalProgramPage } from '@/features/admin/pages/CanonicalProgramPage';
import { catalogApi } from '@/services/catalogApi';
import type { CanonicalProgram, Career } from '@/types/catalog';

vi.mock('@/services/catalogApi');

/**
 * The canonical-programme merge target picker.
 *
 * Merge is the one control on this screen that changes what students are shown — it re-points every
 * college offering that named the absorbed entry and retires it. Its target picker used to be a
 * `<select>` over `entries.filter(…)`: **the rows on the current page**. So past one page of 50, an
 * entry could not be merged into a target that happened to sit on another page, and nothing said
 * so — the option simply was not there.
 *
 * Adding search to the page made that worse rather than better: an admin could now find the target,
 * scroll to its row, press Merge, and still not find it among the candidates.
 */

function canonical(id: string, code: string, name: string, offerings = 0): CanonicalProgram {
  return {
    id,
    code,
    name,
    description: null,
    status: 'active',
    recommended_strand: null,
    offerings_count: offerings,
    careers: [],
    created_at: null,
    updated_at: null,
  };
}

const SOURCE = canonical('p-1', 'BSCS', 'BS Computer Science', 3);
const ON_PAGE = canonical('p-2', 'BSIT', 'BS Information Technology', 1);
const OFF_PAGE = canonical('p-99', 'BSCOMSCI', 'BS Comp Sci (duplicate)', 7);

function listPage(items: CanonicalProgram[], total = items.length) {
  return {
    items,
    pagination: { current_page: 1, per_page: 50, total, last_page: Math.ceil(total / 50) || 1 },
  };
}

function renderPage() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <CanonicalProgramPage />
    </QueryClientProvider>,
  );

  return userEvent.setup();
}

/** Open the merge panel for the source entry, then open its target picker. */
async function openMergePicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /merge bscs/i }));
  await user.click(await screen.findByLabelText(/keep this entry/i));

  return screen.findByLabelText(/search by name or code/i);
}

describe('CanonicalProgramPage — merge target picker', () => {
  beforeEach(() => {
    vi.mocked(catalogApi.listCanonicalPrograms).mockReset();
    vi.mocked(catalogApi.canonicalProgramOptions).mockReset();
    vi.mocked(catalogApi.mergeCanonicalPrograms).mockReset();

    // Page one holds the source and one other entry — the whole world, as far as the old picker
    // was concerned.
    vi.mocked(catalogApi.listCanonicalPrograms).mockResolvedValue(listPage([SOURCE, ON_PAGE], 120));
    vi.mocked(catalogApi.canonicalProgramOptions).mockResolvedValue([SOURCE, ON_PAGE]);
  });

  it('fetches no candidates until a merge panel is opened', async () => {
    renderPage();

    await screen.findByText('BS Computer Science');

    expect(catalogApi.canonicalProgramOptions).not.toHaveBeenCalled();
  });

  /** **P4-16.** The target is not on the page being viewed, and is reachable anyway. */
  it('finds a merge target that is not on the current page', async () => {
    vi.mocked(catalogApi.canonicalProgramOptions).mockImplementation((search?: string) =>
      Promise.resolve(search === undefined ? [SOURCE, ON_PAGE] : [OFF_PAGE]),
    );

    const user = renderPage();
    const searchBox = await openMergePicker(user);

    expect(screen.queryByRole('option', { name: /bscomsci/i })).not.toBeInTheDocument();

    await user.type(searchBox, 'comsci');

    await waitFor(() =>
      expect(catalogApi.canonicalProgramOptions).toHaveBeenCalledWith('comsci'),
    );

    expect(await screen.findByRole('option', { name: /bscomsci/i })).toBeInTheDocument();
  });

  /**
   * Merging an entry into itself would retire the survivor. The source is filtered out here rather
   * than on the server because "not itself" is a fact about this panel, not about the catalog.
   */
  it('never offers the source as its own target', async () => {
    const user = renderPage();

    await openMergePicker(user);

    expect(await screen.findByRole('option', { name: /bsit/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /bscs ·/i })).not.toBeInTheDocument();
  });

  /**
   * The offerings count rides in the option label. This picker sits in front of a merge: "7
   * offerings" against a candidate is the difference between absorbing a stub and absorbing a live
   * entry, and it is the number that says which direction the merge should run.
   */
  it('shows how many offerings each candidate carries', async () => {
    const user = renderPage();

    await openMergePicker(user);

    expect(await screen.findByRole('option', { name: /1 offerings/i })).toBeInTheDocument();
  });

  /** The merge is confirmed, not immediate — it cannot be undone from this screen. */
  it('requires a review step before it will merge', async () => {
    vi.mocked(catalogApi.mergeCanonicalPrograms).mockResolvedValue({
      target: ON_PAGE,
      offerings_moved: 3,
    });

    const user = renderPage();

    await openMergePicker(user);
    await user.click(await screen.findByRole('option', { name: /bsit/i }));

    expect(catalogApi.mergeCanonicalPrograms).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /review this merge/i }));
    await user.click(screen.getByRole('button', { name: /yes, merge into bsit/i }));

    await waitFor(() =>
      expect(catalogApi.mergeCanonicalPrograms).toHaveBeenCalledWith(SOURCE.id, ON_PAGE.id),
    );
  });

  it('says when the candidate list is truncated', async () => {
    vi.mocked(catalogApi.canonicalProgramOptions).mockResolvedValue(
      Array.from({ length: 20 }, (_, index) =>
        canonical(`opt-${index}`, `CODE${index}`, `Programme ${index}`),
      ),
    );

    const user = renderPage();

    await openMergePicker(user);

    expect(await screen.findByText(/showing the first 20/i)).toBeInTheDocument();
  });
});

/**
 * What a canonical program leads to, and its default strand (backend migration 0040) — edited here
 * once for every college that offers the program.
 */
describe('CanonicalProgramPage — careers and strand', () => {
  const ANALYST: Career = {
    id: 'c-1',
    title: 'Data Analyst',
    description: null,
    salary_min: null,
    salary_max: null,
    employment_outlook_id: null,
    employment_outlook: null,
    typical_riasec_code: 'ICE',
    status: 'active',
    created_at: null,
    updated_at: null,
  };

  const MAPPED: CanonicalProgram = {
    ...canonical('p-1', 'BSCS', 'BS Computer Science', 3),
    recommended_strand: 'Academic',
    careers: [ANALYST],
  };

  beforeEach(() => {
    vi.mocked(catalogApi.listCanonicalPrograms).mockReset();
    vi.mocked(catalogApi.listCareers).mockReset();
    vi.mocked(catalogApi.attachCanonicalCareer).mockReset();
    vi.mocked(catalogApi.detachCanonicalCareer).mockReset();
    vi.mocked(catalogApi.updateCanonicalProgram).mockReset();

    vi.mocked(catalogApi.listCareers).mockResolvedValue({
      items: [ANALYST, { ...ANALYST, id: 'c-2', title: 'Web Developer', typical_riasec_code: 'IAR' }],
      pagination: { current_page: 1, per_page: 20, total: 2, last_page: 1 },
    });
  });

  /** An unmapped entry scores every one of its offerings at a flat neutral — findable by scanning. */
  it('flags an entry that leads to no career', async () => {
    vi.mocked(catalogApi.listCanonicalPrograms).mockResolvedValue(
      listPage([canonical('p-9', 'BSX', 'BS Unmapped', 2)]),
    );

    renderPage();

    expect(await screen.findByText(/no careers — not matched/i)).toBeInTheDocument();
  });

  it('shows how many careers an entry leads to, and its strand', async () => {
    vi.mocked(catalogApi.listCanonicalPrograms).mockResolvedValue(listPage([MAPPED]));

    renderPage();

    expect(await screen.findByText(/leads to 1 career · Academic/)).toBeInTheDocument();
    expect(screen.queryByText(/no careers — not matched/i)).not.toBeInTheDocument();
  });

  it('links a career to the canonical program', async () => {
    vi.mocked(catalogApi.listCanonicalPrograms).mockResolvedValue(listPage([MAPPED]));
    vi.mocked(catalogApi.attachCanonicalCareer).mockResolvedValue(MAPPED);

    const user = renderPage();

    await user.click(await screen.findByRole('button', { name: /edit careers bscs leads to/i }));
    expect(screen.getByText(/applies to all 3 college offerings/i)).toBeInTheDocument();

    await user.click(await screen.findByLabelText(/link a career to bscs/i));
    await user.click(await screen.findByRole('option', { name: /web developer/i }));
    await user.click(screen.getByRole('button', { name: /^link$/i }));

    await waitFor(() => {
      expect(catalogApi.attachCanonicalCareer).toHaveBeenCalledWith('p-1', 'c-2', 'direct');
    });
  });

  it('unlinks a career from the canonical program', async () => {
    vi.mocked(catalogApi.listCanonicalPrograms).mockResolvedValue(listPage([MAPPED]));
    vi.mocked(catalogApi.detachCanonicalCareer).mockResolvedValue({ ...MAPPED, careers: [] });

    const user = renderPage();

    await user.click(await screen.findByRole('button', { name: /edit careers bscs leads to/i }));
    await user.click(screen.getByRole('button', { name: /unlink data analyst from bscs/i }));

    await waitFor(() => {
      expect(catalogApi.detachCanonicalCareer).toHaveBeenCalledWith('p-1', 'c-1');
    });
  });

  /**
   * The server writes a changed strand to every offering, and a campus may deliberately differ — so
   * a rename must not resend the strand at all.
   */
  it('sends the strand only when it was changed', async () => {
    vi.mocked(catalogApi.listCanonicalPrograms).mockResolvedValue(listPage([MAPPED]));
    vi.mocked(catalogApi.updateCanonicalProgram).mockResolvedValue(MAPPED);

    const user = renderPage();

    await user.click(await screen.findByRole('button', { name: /^edit bscs$/i }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(catalogApi.updateCanonicalProgram).toHaveBeenCalledTimes(1));
    expect(vi.mocked(catalogApi.updateCanonicalProgram).mock.calls[0]![1]).not.toHaveProperty(
      'recommended_strand',
    );
  });

  it('warns that a changed strand applies to every offering, then sends it', async () => {
    vi.mocked(catalogApi.listCanonicalPrograms).mockResolvedValue(listPage([MAPPED]));
    vi.mocked(catalogApi.updateCanonicalProgram).mockResolvedValue(MAPPED);

    const user = renderPage();

    await user.click(await screen.findByRole('button', { name: /^edit bscs$/i }));
    await user.selectOptions(screen.getByLabelText(/recommended strand/i), 'Technical-Professional');

    expect(screen.getByText(/applies this strand to all 3 college offerings/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(catalogApi.updateCanonicalProgram).toHaveBeenCalledWith(
        'p-1',
        expect.objectContaining({ recommended_strand: 'Technical-Professional' }),
      );
    });
  });
});

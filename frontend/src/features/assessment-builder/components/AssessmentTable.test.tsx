import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AssessmentTable } from '@/features/assessment-builder/components/AssessmentTable';
import type { AssessmentRow } from '@/types/assessmentAdmin';
import type { Paginated } from '@/types/class';

/**
 * The assessment table's three new interactions (prompt §1, §5, §6).
 *
 * Two of them are the kind that break silently:
 *
 *   1. **The whole row opens the assessment, and the action buttons do not.** A clickable row whose
 *      Archive button also navigates is worse than no clickable row at all — the failure is a
 *      misfired destructive act, and it looks like a flaky click rather than a bug. The isolation
 *      lives on one container rather than on each control, and these tests are what say so.
 *   2. **`can_manage` / `can_copy` come from the server.** The page used to derive them from
 *      `ownership !== 'GLOBAL'`, which agreed with the server only by coincidence of what a
 *      counselor's list happens to contain. A row that says `can_manage: false` must render
 *      disabled controls whatever its ownership says.
 */

function row(overrides: Partial<AssessmentRow> = {}): AssessmentRow {
  return {
    id: 'aa000000-0000-4000-8000-000000000001',
    title: 'RIASEC Interest Inventory',
    description: null,
    category: 'RIASEC',
    ownership: 'GLOBAL',
    author: { id: 'u1', name: 'Ada Admin', role: 'admin' },
    source_template_id: null,
    presentation_mode: 'SEQUENTIAL',
    can_manage: true,
    can_copy: true,
    status: 'ACTIVE',
    is_published: true,
    is_archived: false,
    type: { id: 't1', code: 'INTEREST', name: 'Interest' },
    scorings: [{ id: 's1', code: 'LIKERT_SCALES', name: 'Likert Scales' }],
    versions: [{ id: 'v1', version_number: 1, status: 'PUBLISHED' }],
    published_version: { id: 'v1', version_number: 1, duration_minutes: 15, question_count: 60 },
    assignment: { scope: null, class_count: 0 },
    ai_generatable: false,
    can_delete: true,
    delete_blockers: [],
    delete_blocked_reason: null,
    response_count: 0,
    active_assignment_count: 0,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-02T00:00:00.000Z',
    published_at: '2026-07-02T00:00:00.000Z',
    first_published_at: '2026-07-02T00:00:00.000Z',
    ...overrides,
  };
}

function page(rows: AssessmentRow[]): Paginated<AssessmentRow> {
  return {
    items: rows,
    pagination: { current_page: 1, per_page: 20, total: rows.length, last_page: 1 },
  };
}

type Handlers = ReturnType<typeof handlers>;

function handlers() {
  return {
    onOpen: vi.fn(),
    onEdit: vi.fn(),
    onAssign: vi.fn(),
    onCopy: vi.fn(),
    onArchive: vi.fn(),
    onRestore: vi.fn(),
    onDelete: vi.fn(),
    onPresentationModeChange: vi.fn(),
  };
}

function renderTable(rows: AssessmentRow[], on: Handlers, showOwner = true) {
  render(
    <AssessmentTable
      data={page(rows)}
      isPending={false}
      isFetching={false}
      isError={false}
      search=""
      onSearchChange={vi.fn()}
      types={[]}
      typeFilter=""
      onTypeFilterChange={vi.fn()}
      statusFilter=""
      onStatusFilterChange={vi.fn()}
      assignmentFilter=""
      onAssignmentFilterChange={vi.fn()}
      dateField="published_at"
      onDateFieldChange={vi.fn()}
      dateFrom=""
      onDateFromChange={vi.fn()}
      dateTo=""
      onDateToChange={vi.fn()}
      sort="title"
      direction="asc"
      onSort={vi.fn()}
      page={1}
      onPageChange={vi.fn()}
      showOwner={showOwner}
      busyId={null}
      {...on}
    />,
  );

  return userEvent.setup();
}

/**
 * Both layouts render at once in jsdom — `lg:hidden` and `hidden lg:block` are media queries with
 * no viewport behind them — so every query here is scoped to one of the two. That is a property of
 * the test environment, not of the component, and scoping is the honest way to live with it.
 */
const tableRow = (title: string) =>
  within(screen.getByRole('table')).getByRole('row', { name: new RegExp(`Open ${title}`) });

const card = (title: string) =>
  screen.getByRole('button', { name: `Open ${title}`, hidden: false });

describe('opening an assessment', () => {
  it('opens it from a click anywhere on the row', async () => {
    const on = handlers();
    const user = renderTable([row()], on);

    await user.click(within(tableRow('RIASEC Interest Inventory')).getByText('Interest'));

    expect(on.onOpen).toHaveBeenCalledTimes(1);
    expect(on.onOpen.mock.calls[0]?.[0].title).toBe('RIASEC Interest Inventory');
  });

  it('opens it from Enter and from Space on the focused row', async () => {
    const on = handlers();
    const user = renderTable([row()], on);

    tableRow('RIASEC Interest Inventory').focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');

    expect(on.onOpen).toHaveBeenCalledTimes(2);
  });

  /** The card is the phone layout, and it carries the same act. */
  it('opens it from the card', async () => {
    const on = handlers();
    const user = renderTable([row()], on);

    await user.click(card('RIASEC Interest Inventory'));

    expect(on.onOpen).toHaveBeenCalledTimes(1);
  });

  /**
   * **The one that matters.** Every action sits in a container that cancels the row's click; if
   * that container ever loses its handler, Archive both archives *and* navigates.
   */
  it.each(['Assign', 'Copy', 'Archive', 'Delete', 'Edit'])(
    'does not navigate when %s is pressed',
    async (action) => {
      const on = handlers();
      const user = renderTable([row()], on);

      const button = within(tableRow('RIASEC Interest Inventory')).getByRole('button', {
        name: new RegExp(action, 'i'),
      });

      await user.click(button);

      expect(on.onOpen).not.toHaveBeenCalled();
    },
  );

  it('does not navigate when the delivery mode is changed', async () => {
    const on = handlers();
    const user = renderTable([row()], on);

    const select = within(tableRow('RIASEC Interest Inventory')).getByRole('combobox');

    await user.selectOptions(select, 'RANDOM');

    expect(on.onOpen).not.toHaveBeenCalled();
    expect(on.onPresentationModeChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: row().id }),
      'RANDOM',
    );
  });
});

describe('delivery mode', () => {
  it('shows the stored mode', () => {
    const on = handlers();

    renderTable([row({ presentation_mode: 'RANDOM' })], on);

    expect(within(tableRow('RIASEC Interest Inventory')).getByRole('combobox')).toHaveValue(
      'RANDOM',
    );
  });

  /** It is a write to the instrument, so a viewer who cannot author it cannot flip it either. */
  it('is disabled for a row the caller may not manage', () => {
    const on = handlers();

    renderTable([row({ can_manage: false })], on);

    expect(within(tableRow('RIASEC Interest Inventory')).getByRole('combobox')).toBeDisabled();
  });
});

describe('what the server says the caller may do', () => {
  it('disables the authoring controls on a row it may not manage, and leaves Copy and Assign', () => {
    const on = handlers();

    renderTable([row({ can_manage: false, can_copy: true })], on);

    const scope = within(tableRow('RIASEC Interest Inventory'));

    expect(scope.getByRole('button', { name: /archive/i })).toBeDisabled();
    expect(scope.getByRole('button', { name: /delete/i })).toBeDisabled();
    expect(scope.getByRole('button', { name: /edit/i })).toBeDisabled();

    // Assigning is authorized against the *class*, and copying only needs read access — so a
    // counselor keeps both on a curated instrument. That is the whole point of the split.
    expect(scope.getByRole('button', { name: /assign/i })).toBeEnabled();
    expect(scope.getByRole('button', { name: /make a copy/i })).toBeEnabled();
  });

  it('disables Copy when the server says the caller may not copy', () => {
    const on = handlers();

    renderTable([row({ can_copy: false })], on);

    expect(
      within(tableRow('RIASEC Interest Inventory')).getByRole('button', { name: /make a copy/i }),
    ).toBeDisabled();
  });

  it('calls onCopy with the row', async () => {
    const on = handlers();
    const user = renderTable([row()], on);

    await user.click(
      within(tableRow('RIASEC Interest Inventory')).getByRole('button', { name: /make a copy/i }),
    );

    expect(on.onCopy).toHaveBeenCalledWith(expect.objectContaining({ id: row().id }));
  });
});

describe('the owner column', () => {
  it('names the counselor behind a private instrument', () => {
    const on = handlers();

    renderTable(
      [
        row({
          ownership: 'COUNSELOR_PRIVATE',
          author: { id: 'u2', name: 'Maria Santos', role: 'counselor' },
        }),
      ],
      on,
    );

    expect(within(screen.getByRole('table')).getByText('Maria Santos')).toBeInTheDocument();
  });

  it('is omitted entirely when the caller is not an administrator', () => {
    const on = handlers();

    renderTable([row()], on, false);

    expect(
      within(screen.getByRole('table')).queryByRole('columnheader', { name: 'Owner' }),
    ).not.toBeInTheDocument();
  });
});

import { Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { AssessmentAssignDialog } from '@/features/assessment-builder/components/AssessmentAssignDialog';
import { AssessmentFormDialog } from '@/features/assessment-builder/components/AssessmentFormDialog';
import { AssessmentTable } from '@/features/assessment-builder/components/AssessmentTable';
import {
  useArchiveAssessment,
  useAssessments,
  useAssessmentTypes,
  useAssignAssessment,
  useCreateAssessment,
  useRestoreAssessment,
  useUpdateAssessment,
} from '@/features/assessment-builder/hooks/useAssessments';
import { toast } from '@/stores/toastStore';
import type { SortDirection } from '@/types/address';
import type {
  AssessmentAssignmentFilter,
  AssessmentListQuery,
  AssessmentRow,
  AssessmentSort,
  AssessmentStatusFilter,
} from '@/types/assessmentAdmin';

/**
 * Assessment management (backend migration 0014) — every instrument in one table, with the four acts
 * performed on them: create, edit, assign, archive.
 *
 * **Shared by the admin and counselor shells** (the base path differs, the content does not), as the
 * template list it replaces was. Scope is not a UI decision in either direction: the server returns
 * the global instruments plus the caller's own, and the assignment picker offers only classes the
 * caller may manage. A counselor therefore gets exactly the same screen doing exactly the right,
 * narrower thing — which is why there is one page here rather than two that would drift.
 *
 * **This page owns the query and the table renders it.** Search, filters, sort and page all live
 * here, travel to the server, and come back as one page of rows — so the table always shows the
 * whole filtered set's first N rows rather than a filtered view of one arbitrary page. The
 * `useEffect` resetting the page is the small consequence: page 4 of the unfiltered list rarely
 * exists in the filtered one, and a page past the end comes back empty.
 *
 * **View opens the builder** rather than a read-only mirror of it. Questions, dimensions, versions
 * and the §25 confirmation gate all live there already, and a second screen that showed the same
 * things without being able to act on them would be a page whose only purpose is to link to another.
 */

const PER_PAGE = 20;

export function AssessmentManagementPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const base = location.pathname.startsWith('/admin') ? '/admin' : '/counselor';

  const [searchInput, setSearchInput] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<AssessmentStatusFilter | ''>('');
  const [assignmentFilter, setAssignmentFilter] = useState<AssessmentAssignmentFilter | ''>('');
  const [sort, setSort] = useState<AssessmentSort>('title');
  const [direction, setDirection] = useState<SortDirection>('asc');
  const [page, setPage] = useState(1);

  const [formOpen, setFormOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<AssessmentRow | null>(null);
  const [assigningRow, setAssigningRow] = useState<AssessmentRow | null>(null);

  const search = useDebouncedValue(searchInput, 300);

  // Any change to what is being *filtered* returns to page one.
  useEffect(() => {
    setPage(1);
  }, [search, typeFilter, statusFilter, assignmentFilter]);

  const query: AssessmentListQuery = useMemo(
    () => ({
      search: search || undefined,
      assessment_type_id: typeFilter || undefined,
      status: statusFilter || undefined,
      assignment: assignmentFilter || undefined,
      page,
      per_page: PER_PAGE,
      sort,
      direction,
    }),
    [search, typeFilter, statusFilter, assignmentFilter, page, sort, direction],
  );

  const list = useAssessments(query);
  const types = useAssessmentTypes();

  const create = useCreateAssessment();
  const update = useUpdateAssessment();
  const archive = useArchiveAssessment();
  const restore = useRestoreAssessment();
  const assign = useAssignAssessment();

  function onSort(column: AssessmentSort) {
    if (column === sort) {
      setDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(column);
      setDirection('asc');
    }

    setPage(1);
  }

  /**
   * Archiving is confirmed, and the confirmation says the one thing that is easy to assume wrongly:
   * it does **not** end assignments already open. Closing an assignment expires every attempt still
   * in progress underneath it (§21), so an archive that did that silently would end the assessment a
   * class is sitting for this afternoon.
   */
  async function onArchive(row: AssessmentRow) {
    const assigned =
      row.assignment.scope !== null
        ? ' Classes it is already assigned to keep their access — close those assignments separately if you want them to end.'
        : '';

    if (
      !window.confirm(
        `Archive “${row.title}”? It will no longer appear as assignable.${assigned} You can restore it later.`,
      )
    ) {
      return;
    }

    try {
      await archive.mutateAsync(row.id);
      toast.success(`Archived ${row.title}.`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : `Could not archive ${row.title}.`,
      );
    }
  }

  async function onRestore(row: AssessmentRow) {
    try {
      await restore.mutateAsync(row.id);
      toast.success(`Restored ${row.title}.`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : `Could not restore ${row.title}.`,
      );
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Assessments</h1>
          <p className="text-sm text-muted-foreground">
            Every instrument you can reach — its type, scoring methods, versions, and who it reaches.
            Questions and versions are built in the builder; publishing is what makes a version
            assignable. RIASEC and SCCT are curated instruments and cannot be AI-edited.
          </p>
        </div>
        <Button
          onClick={() => {
            setEditingRow(null);
            setFormOpen(true);
          }}
        >
          <Plus className="size-4" aria-hidden="true" />
          New assessment
        </Button>
      </div>

      <AssessmentTable
        data={list.data}
        isPending={list.isPending}
        isFetching={list.isFetching}
        isError={list.isError}
        errorMessage={list.error?.message}
        search={searchInput}
        onSearchChange={setSearchInput}
        types={types.data ?? []}
        typeFilter={typeFilter}
        onTypeFilterChange={setTypeFilter}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        assignmentFilter={assignmentFilter}
        onAssignmentFilterChange={setAssignmentFilter}
        sort={sort}
        direction={direction}
        onSort={onSort}
        page={page}
        onPageChange={setPage}
        onView={(row) => navigate(`${base}/assessment-templates/${row.id}`)}
        onEdit={(row) => {
          setEditingRow(row);
          setFormOpen(true);
        }}
        onAssign={setAssigningRow}
        onArchive={onArchive}
        onRestore={onRestore}
        busyId={
          archive.isPending
            ? (archive.variables ?? null)
            : restore.isPending
              ? (restore.variables ?? null)
              : null
        }
      />

      <AssessmentFormDialog
        open={formOpen}
        row={editingRow}
        onClose={() => {
          setFormOpen(false);
          setEditingRow(null);
        }}
        onSave={(payload) =>
          editingRow === null
            ? create.mutateAsync(payload)
            : update.mutateAsync({ id: editingRow.id, payload })
        }
        isSaving={create.isPending || update.isPending}
      />

      <AssessmentAssignDialog
        row={assigningRow}
        onClose={() => setAssigningRow(null)}
        onAssign={(payload) => assign.mutateAsync({ id: assigningRow!.id, payload })}
        isAssigning={assign.isPending}
      />
    </div>
  );
}

/** Debounce the search box so it drives one request rather than one per keystroke. */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);

    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

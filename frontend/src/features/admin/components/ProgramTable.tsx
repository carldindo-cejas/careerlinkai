import { Archive, ArchiveRestore, Pencil } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import { useUpdateProgram } from '@/features/admin/hooks/useCatalog';
import { useClientPagination } from '@/hooks/useClientPagination';
import type { Program, ProgramStatus } from '@/types/catalog';

/**
 * A college's programs, as a table (2026-09-21).
 *
 * They were one card per program, each carrying its own career-mapping picker. That is a reasonable
 * shape for three programs and the wrong one for thirty: a college's offerings are a *list of the
 * same kind of thing*, compared column by column — which code, which strand, is it live — and a
 * stack of cards makes every one of those comparisons a scroll. The mapping moved into the editor
 * with the rest of the program's fields, which is where an admin was already going to change it.
 *
 * ## Archive, not delete
 *
 * The row action is **archive**, and it is not a softer word for the same act. Deleting a program
 * takes its `program_careers` links and every recommendation pointing at it with it, so a student
 * who was shown "BS Nursing at HNU" last week loses the row that says so. Archiving drops it out of
 * §27's ranking — `rankablePrograms()` only ever sees active rows — and leaves every historical
 * recommendation intact and readable. That is what "we stopped offering this" actually means, and
 * it is the same choice the college itself offers one level up.
 *
 * Restoring is the same button in reverse, because an archive an admin cannot undo is a delete with
 * better manners.
 */

/** Ten rows is about a screen at laptop height, and still a short scroll on a phone. */
const PER_PAGE = 10;

export interface ProgramTableProps {
  collegeId: string;
  programs: Program[];
  /** A row was chosen — the page opens the floating editor. */
  onEdit: (program: Program) => void;
}

export function ProgramTable({ collegeId, programs, onEdit }: ProgramTableProps) {
  const updateProgram = useUpdateProgram(collegeId);
  const { pageItems, pagination, setPage } = useClientPagination(programs, PER_PAGE);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="p-0">
          {/*
            The horizontal scroll lives on this wrapper rather than on the page: a table that
            overflows the viewport is the most common way an admin screen ends up scrolling
            sideways at 320px, and `scripts/responsive-audit.mjs` scores exactly that.
          */}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="px-4 py-3 font-medium">
                    Program
                  </th>
                  <th scope="col" className="hidden px-4 py-3 font-medium md:table-cell">
                    Strand
                  </th>
                  <th scope="col" className="hidden px-4 py-3 font-medium lg:table-cell">
                    Careers
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>

              <tbody>
                {pageItems.map((program) => {
                  const isArchived = program.status === 'archived';
                  const careers = program.careers ?? [];

                  return (
                    <tr
                      key={program.id}
                      // The whole row opens the editor for a pointer; the name below is the same
                      // act for a keyboard. Both fire on a click of the name, and opening one
                      // dialog twice is one dialog.
                      onClick={() => onEdit(program)}
                      className="cursor-pointer border-b border-border transition-colors last:border-b-0 hover:bg-secondary/60"
                    >
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => onEdit(program)}
                          className="text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="font-mono text-xs tracking-wide text-muted-foreground">
                            {program.code}
                          </span>
                          <span className="ml-2 font-medium text-foreground">{program.name}</span>
                        </button>

                        {/*
                          What the two hidden columns say, said again under the name below their
                          breakpoints. A column that simply vanishes on a phone has not been made
                          responsive — it has been made unavailable.
                        */}
                        <span className="mt-0.5 block text-xs text-muted-foreground md:hidden">
                          {program.recommended_strand ?? 'Open to any strand'}
                          {' · '}
                          {careers.length === 1 ? '1 career' : `${careers.length} careers`}
                        </span>

                        {program.department_name ? (
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {program.department_name}
                          </span>
                        ) : null}
                      </td>

                      <td className="hidden whitespace-nowrap px-4 py-3 text-muted-foreground md:table-cell">
                        {/* Null is a claim, not a gap: §27 scores a program with no strand
                            requirement as a full 100 for every student. */}
                        {program.recommended_strand ?? 'Open to any strand'}
                      </td>

                      <td className="hidden px-4 py-3 text-muted-foreground lg:table-cell">
                        {careers.length === 0 ? (
                          // An unmapped program is not an empty field — it is a scoring decision
                          // (§27 falls back to a neutral 50), so the table says so.
                          <span className="text-accent">none linked</span>
                        ) : (
                          careers.length
                        )}
                      </td>

                      <td className="px-4 py-3">
                        <Badge tone={programStatusTone(program.status)}>{program.status}</Badge>
                      </td>

                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Edit ${program.code}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              onEdit(program);
                            }}
                          >
                            <Pencil className="size-4" aria-hidden="true" />
                          </Button>

                          <Button
                            variant="ghost"
                            size="sm"
                            loading={
                              updateProgram.isPending && updateProgram.variables?.id === program.id
                            }
                            aria-label={`${isArchived ? 'Restore' : 'Archive'} ${program.code}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              updateProgram.mutate({
                                id: program.id,
                                payload: { status: isArchived ? 'active' : 'archived' },
                              });
                            }}
                          >
                            {isArchived ? (
                              <ArchiveRestore className="size-4" aria-hidden="true" />
                            ) : (
                              <Archive className="size-4" aria-hidden="true" />
                            )}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Pagination pagination={pagination} onPageChange={setPage} noun="programs" />
    </div>
  );
}

/**
 * Only an active program is ever recommended (§27) — status is the difference between a
 * program students can be matched to and one that merely exists.
 */
function programStatusTone(status: ProgramStatus): 'success' | 'warning' | 'neutral' {
  switch (status) {
    case 'active':
      return 'success';
    case 'draft':
      return 'warning';
    case 'archived':
      return 'neutral';
  }
}

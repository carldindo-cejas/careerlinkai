import { ChevronDown, Loader2, UserMinus } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/components/ui/cn';
import { Pagination } from '@/components/ui/pagination';
import { RosterStudentDetails } from '@/features/counselor/components/RosterStudentDetails';
import { useClassResults } from '@/features/counselor/hooks/useAssignments';
import { useRemoveStudent, useRoster } from '@/features/counselor/hooks/useRoster';
import { useClientPagination } from '@/hooks/useClientPagination';
import { ApiRequestError } from '@/types/api';
import type { AssessmentResult } from '@/types/assessment';
import { fullName, type RosterEntry } from '@/types/class';

/** A screenful of roster without pushing the assignment panel off the page. */
const PER_PAGE = 15;

/** The number of columns, for the expanded row's `colSpan`. */
const COLUMNS = 4;

/**
 * The current roster (FULLPLAN §13.2, §57) — and, one click into any row, that student's results
 * and recommendations.
 *
 * Removed students are not shown — the row survives as enrollment history, but they are no
 * longer in the class.
 *
 * The roster arrives whole (a class is tens of students, not thousands) and is paged here, so a
 * full class does not bury the panels below it under sixty rows.
 *
 * ## The dropdown replaced two panels
 *
 * Results and recommendations used to be two more cards under this one, each re-listing the same
 * students. The counselor's question is always about one student — "what did Ana get?" — so the
 * answer now opens under that student's name instead. The class results are fetched once here and
 * handed to each row; a student's recommendations are fetched only when their row opens, because
 * there is no bulk endpoint and a roster of forty would otherwise fire forty requests on page load.
 *
 * Only one row is open at a time. Two open rows is two ranked lists side by side, which invites
 * the cross-student comparison of match scores that §27 does not support — each score is computed
 * against that student's own profile.
 */
export interface RosterTableProps {
  classId: string;
}

export function RosterTable({ classId }: RosterTableProps) {
  const { data: roster, isPending, isError, error } = useRoster(classId);
  const { data: results, error: resultsError } = useClassResults(classId);
  const [openStudentId, setOpenStudentId] = useState<string | null>(null);

  const { pageItems, pagination, setPage } = useClientPagination(roster ?? [], PER_PAGE);

  /**
   * Student id → their scored attempts. The server orders class results `submitted_at DESC`, and
   * grouping preserves that, so the first RIASEC entry in a student's list is their latest.
   */
  const resultsByStudent = useMemo(() => {
    const grouped = new Map<string, AssessmentResult[]>();

    for (const result of results ?? []) {
      const studentId = result.student?.id;
      if (studentId == null) continue;

      const list = grouped.get(studentId);
      if (list) {
        list.push(result);
      } else {
        grouped.set(studentId, [result]);
      }
    }

    return grouped;
  }, [results]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Roster</CardTitle>
        <CardDescription>
          {roster
            ? `${roster.length} ${roster.length === 1 ? 'student' : 'students'} in this class. Open a student to see their Holland code, career confidence and top recommendations.`
            : 'Students provisioned for this class.'}
        </CardDescription>
      </CardHeader>

      <CardContent>
        {isPending ? (
          <div className="flex justify-center py-8" role="status">
            <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
            <span className="sr-only">Loading the roster…</span>
          </div>
        ) : null}

        {isError ? <Alert>{error.message}</Alert> : null}

        {roster && roster.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            Nobody yet. Use Add students to provision accounts.
          </p>
        ) : null}

        {roster && roster.length > 0 ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                    <th scope="col" className="pb-2 pr-4 font-medium">
                      Name
                    </th>
                    <th scope="col" className="pb-2 pr-4 font-medium">
                      Username
                    </th>
                    <th scope="col" className="pb-2 pr-4 font-medium">
                      Status
                    </th>
                    <th scope="col" className="pb-2 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {pageItems.map((entry) => (
                    <RosterRow
                      key={entry.id}
                      classId={classId}
                      entry={entry}
                      results={results ? (resultsByStudent.get(entry.student_id) ?? []) : undefined}
                      resultsError={resultsError}
                      open={openStudentId === entry.student_id}
                      onToggle={() =>
                        setOpenStudentId((current) =>
                          current === entry.student_id ? null : entry.student_id,
                        )
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4">
              <Pagination pagination={pagination} onPageChange={setPage} noun="students" />
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RosterRow({
  classId,
  entry,
  results,
  resultsError,
  open,
  onToggle,
}: {
  classId: string;
  entry: RosterEntry;
  /** This student's scored attempts; undefined while the class results are still loading. */
  results: AssessmentResult[] | undefined;
  resultsError: Error | null;
  open: boolean;
  onToggle: () => void;
}) {
  const [isConfirming, setIsConfirming] = useState(false);
  const removeStudent = useRemoveStudent(classId);

  const error = removeStudent.error instanceof ApiRequestError ? removeStudent.error : null;
  const name = fullName(entry) || entry.username;

  return (
    <>
      <tr className={cn('border-b border-border last:border-0', open && 'bg-muted/20')}>
        <td className="py-2.5 pr-4">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="inline-flex items-center gap-2 text-left font-medium text-foreground hover:underline focus-visible:underline focus-visible:outline-none"
          >
            <ChevronDown
              className={cn(
                'size-4 shrink-0 text-muted-foreground transition-transform duration-200',
                open && 'rotate-180',
              )}
              aria-hidden="true"
            />
            {name}
          </button>
        </td>
        <td className="py-2.5 pr-4 font-mono text-muted-foreground">{entry.username}</td>
        <td className="py-2.5 pr-4">
          <AssessmentStatus entry={entry} />
        </td>
        <td className="py-2.5 text-right">
          {error ? <p className="mb-1 text-sm text-destructive">{error.message}</p> : null}

          {isConfirming ? (
            <div className="flex items-center justify-end gap-2">
              {/* Removal signs them out on the spot (§38) — say so before it happens. */}
              <span className="text-sm text-muted-foreground">
                Remove {name}? This signs them out immediately.
              </span>
              <Button
                size="sm"
                loading={removeStudent.isPending}
                onClick={() =>
                  removeStudent.mutate(entry.student_id, { onSuccess: () => setIsConfirming(false) })
                }
              >
                Remove
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setIsConfirming(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsConfirming(true)}
              aria-label={`Remove ${name} from this class`}
            >
              <UserMinus className="size-4" aria-hidden="true" />
              Remove
            </Button>
          )}
        </td>
      </tr>

      {/* Mounted only while open — that is what keeps the recommendations fetch lazy. */}
      {open ? (
        <tr className="border-b border-border last:border-0">
          <td colSpan={COLUMNS} className="p-0">
            <RosterStudentDetails
              classId={classId}
              studentId={entry.student_id}
              name={name}
              results={results}
              resultsError={resultsError}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * How far this student has got through the class's assessments — "0/4 untouched", "1/4 pending",
 * "4/4 done".
 *
 * The denominator is the class's assignment count, so it moves for everyone the moment another
 * assessment is assigned; the assign, close and reset mutations invalidate this query for exactly
 * that reason. A student with nothing assigned to them yet gets an em dash rather than "0/0 done",
 * which would read as an accomplishment.
 */
function AssessmentStatus({ entry }: { entry: RosterEntry }) {
  const { assessments_assigned: total, assessments_completed: done } = entry;

  if (total === 0) {
    return (
      <span className="text-sm text-muted-foreground">
        <span aria-hidden="true">—</span>
        <span className="sr-only">No assessments assigned to this class yet</span>
      </span>
    );
  }

  const label =
    done === total
      ? 'done'
      : done > 0 || entry.assessments_in_progress > 0
        ? 'pending'
        : 'untouched';

  const tone = label === 'done' ? 'success' : label === 'pending' ? 'warning' : 'neutral';

  return (
    <span className="flex items-center gap-2">
      <span className="font-mono text-sm text-foreground">
        {done}/{total}
      </span>
      <Badge tone={tone}>{label}</Badge>
    </span>
  );
}

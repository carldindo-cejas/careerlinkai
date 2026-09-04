import { Loader2, UserMinus } from 'lucide-react';
import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import { useRemoveStudent, useRoster } from '@/features/counselor/hooks/useRoster';
import { useClientPagination } from '@/hooks/useClientPagination';
import { ApiRequestError } from '@/types/api';
import { fullName, type RosterEntry } from '@/types/class';

/** A screenful of roster without pushing the assignment and results panels off the page. */
const PER_PAGE = 15;

/**
 * The current roster (FULLPLAN §13.2, §57).
 *
 * Removed students are not shown — the row survives as enrollment history, but they are no
 * longer in the class.
 *
 * The roster arrives whole (a class is tens of students, not thousands) and is paged here, so a
 * full class does not bury the panels below it under sixty rows.
 */
export interface RosterTableProps {
  classId: string;
}

export function RosterTable({ classId }: RosterTableProps) {
  const { data: roster, isPending, isError, error } = useRoster(classId);

  const { pageItems, pagination, setPage } = useClientPagination(roster ?? [], PER_PAGE);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Roster</CardTitle>
        <CardDescription>
          {roster
            ? `${roster.length} ${roster.length === 1 ? 'student' : 'students'} in this class.`
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
            Nobody yet. Paste a name list above to provision accounts.
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
                    <RosterRow key={entry.id} classId={classId} entry={entry} />
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

function RosterRow({ classId, entry }: { classId: string; entry: RosterEntry }) {
  const [isConfirming, setIsConfirming] = useState(false);
  const removeStudent = useRemoveStudent(classId);

  const error = removeStudent.error instanceof ApiRequestError ? removeStudent.error : null;

  return (
    <tr className="border-b border-border last:border-0">
      <td className="py-2.5 pr-4 text-foreground">{fullName(entry)}</td>
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
              Remove {fullName(entry)}? This signs them out immediately.
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
            aria-label={`Remove ${fullName(entry)} from this class`}
          >
            <UserMinus className="size-4" aria-hidden="true" />
            Remove
          </Button>
        )}
      </td>
    </tr>
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


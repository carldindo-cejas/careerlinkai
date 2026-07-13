import { Loader2, UserMinus } from 'lucide-react';
import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useRemoveStudent, useRoster } from '@/features/counselor/hooks/useRoster';
import { ApiRequestError } from '@/types/api';
import { fullName, type RosterEntry } from '@/types/class';

/**
 * The current roster (FULLPLAN §13.2, §57).
 *
 * Removed students are not shown — the row survives as enrollment history, but they are no
 * longer in the class.
 */
export interface RosterTableProps {
  classId: string;
}

export function RosterTable({ classId }: RosterTableProps) {
  const { data: roster, isPending, isError, error } = useRoster(classId);

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
            <Loader2 className="size-5 animate-spin text-slate-400" aria-hidden="true" />
            <span className="sr-only">Loading the roster…</span>
          </div>
        ) : null}

        {isError ? <Alert>{error.message}</Alert> : null}

        {roster && roster.length === 0 ? (
          <p className="py-4 text-sm text-slate-500">
            Nobody yet. Paste a name list above to provision accounts.
          </p>
        ) : null}

        {roster && roster.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                  <th scope="col" className="pb-2 pr-4 font-medium">
                    Name
                  </th>
                  <th scope="col" className="pb-2 pr-4 font-medium">
                    Username
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>

              <tbody>
                {roster.map((entry) => (
                  <RosterRow key={entry.id} classId={classId} entry={entry} />
                ))}
              </tbody>
            </table>
          </div>
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
    <tr className="border-b border-slate-100 last:border-0">
      <td className="py-2.5 pr-4 text-slate-900">{fullName(entry)}</td>
      <td className="py-2.5 pr-4 font-mono text-slate-600">{entry.username}</td>
      <td className="py-2.5 text-right">
        {error ? <p className="mb-1 text-sm text-red-600">{error.message}</p> : null}

        {isConfirming ? (
          <div className="flex items-center justify-end gap-2">
            {/* Removal signs them out on the spot (§38) — say so before it happens. */}
            <span className="text-sm text-slate-600">
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

import { ArrowLeft, CheckCircle2, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { AssignmentPanel } from '@/features/counselor/components/AssignmentPanel';
import { JoinCodeCard } from '@/features/counselor/components/JoinCodeCard';
import { RosterBuilder } from '@/features/counselor/components/RosterBuilder';
import { RosterTable } from '@/features/counselor/components/RosterTable';
import { useClass } from '@/features/counselor/hooks/useClasses';
import { paths } from '@/routes/paths';

/**
 * One class: its code, its roster, and the roster builder (FULLPLAN §57, Phase 1A/1B).
 *
 * This screen is the counselor half of the §57 demo end to end — create, read the code
 * out, paste the names, review the usernames, confirm.
 */
export function ClassDetailPage() {
  const { classId = '' } = useParams<{ classId: string }>();
  const [enrolled, setEnrolled] = useState<number | null>(null);

  const { data: classRoom, isPending, isError, error } = useClass(classId);

  if (isPending) {
    return (
      <div className="flex justify-center py-16" role="status">
        <Loader2 className="size-6 animate-spin text-slate-400" aria-hidden="true" />
        <span className="sr-only">Loading the class…</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <Alert>{error.message}</Alert>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <BackLink />

        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-slate-900">{classRoom.name}</h1>
          <Badge tone={classRoom.status === 'active' ? 'success' : 'neutral'}>
            {classRoom.status}
          </Badge>
        </div>

        <p className="text-sm text-slate-500">
          {classRoom.academic_year}
          {classRoom.grade_level ? ` · ${classRoom.grade_level}` : null}
        </p>
      </div>

      {enrolled !== null ? (
        <div
          role="status"
          className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"
        >
          <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
          <span>
            Enrolled {enrolled} {enrolled === 1 ? 'student' : 'students'}. They can sign in with
            the class code and their username.
          </span>
        </div>
      ) : null}

      <JoinCodeCard classRoom={classRoom} />

      <RosterBuilder classId={classRoom.id} onConfirmed={setEnrolled} />

      <RosterTable classId={classRoom.id} />

      {/* Phase 3: assign an assessment to this class, and watch results arrive (§37). Placed
          below the roster deliberately — there is no point assigning an assessment to a class
          with nobody in it, and the page reads top to bottom in the order the counselor works. */}
      <AssignmentPanel classId={classRoom.id} />
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to={paths.counselorClasses}
      className="inline-flex w-fit items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      All classes
    </Link>
  );
}

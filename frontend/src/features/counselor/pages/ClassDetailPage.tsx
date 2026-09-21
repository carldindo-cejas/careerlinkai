import { Loader2, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { AssignmentPanel } from '@/features/counselor/components/AssignmentPanel';
import { JoinCodeCard } from '@/features/counselor/components/JoinCodeCard';
import { RosterBuilder } from '@/features/counselor/components/RosterBuilder';
import { RosterTable } from '@/features/counselor/components/RosterTable';
import { useClass } from '@/features/counselor/hooks/useClasses';

/**
 * One class: its code, its roster, and the roster builder (FULLPLAN §57, Phase 1A/1B).
 *
 * This screen is the counselor half of the §57 demo end to end — create, read the code
 * out, paste the names, review the usernames, confirm.
 */
export function ClassDetailPage() {
  const { classId = '' } = useParams<{ classId: string }>();
  const [enrolled, setEnrolled] = useState<number | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const { data: classRoom, isPending, isError, error } = useClass(classId);

  if (isPending) {
    return (
      <div className="flex justify-center py-16" role="status">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">Loading the class…</span>
      </div>
    );
  }

  if (isError) {
    return <Alert>{error.message}</Alert>;
  }

  return (
    <div className="flex flex-col gap-6">
      {/* "All classes" used to sit here and in the error branch above; the shell's back control
          (AppShell) now stands one step above every page, error state included. */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-foreground">{classRoom.name}</h1>
            <Badge tone={classRoom.status === 'active' ? 'success' : 'neutral'}>
              {classRoom.status}
            </Badge>
          </div>

          <p className="text-sm text-muted-foreground">
            {classRoom.academic_year}
            {classRoom.grade_level ? ` · ${classRoom.grade_level}` : null}
          </p>
        </div>

        {/* Adding students is an occasional errand, not something the counselor reads on every
            visit — so it is one button up here and a modal, rather than a permanent two-step
            panel standing between the class code and the roster. */}
        <Button onClick={() => setIsAdding(true)}>
          <UserPlus className="size-4" aria-hidden="true" />
          Add students
        </Button>
      </div>

      {enrolled !== null ? (
        // Alert tone="success" carries the same role="status" and check icon this block hand-rolled.
        <Alert tone="success">
          Enrolled {enrolled} {enrolled === 1 ? 'student' : 'students'}. They can sign in with the
          class code and their username.
        </Alert>
      ) : null}

      <JoinCodeCard classRoom={classRoom} />

      {/* Opening a class is nearly always "who is in this class?" — the roster sits directly under
          the code. Each student's results and recommendations open inside their own row, which is
          why the separate Results and Recommendations panels that used to follow are gone. */}
      <RosterTable classId={classRoom.id} />

      {/* Paste the names, review the generated usernames, confirm — all inside the modal, which
          closes on success. It is unmounted while shut, so each open starts on a clean step 1. */}
      <Dialog open={isAdding} onOpenChange={setIsAdding}>
        <DialogContent title="Add students">
          <RosterBuilder
            classId={classRoom.id}
            // The confirmation lands on the page behind, beside the roster it just changed.
            onConfirmed={(count) => {
              setEnrolled(count);
              setIsAdding(false);
            }}
          />
        </DialogContent>
      </Dialog>

      {/* Phase 3: assign an assessment to this class (§37). Placed below the roster deliberately —
          there is no point assigning an assessment to a class with nobody in it, and the page reads
          top to bottom in the order the counselor works. */}
      <AssignmentPanel classId={classRoom.id} />
    </div>
  );
}

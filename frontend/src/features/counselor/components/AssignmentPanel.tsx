import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  useAssessmentTemplates,
  useAssignAssessment,
  useClassAssignments,
  useCloseAssignment,
} from '@/features/counselor/hooks/useAssignments';
import type { AssessmentAssignment } from '@/types/assessment';

/**
 * Assign an assessment to a class, and watch the results come in (FULLPLAN §37).
 *
 * Two things this panel is careful about, both of which are consequences of the schema rather than
 * UI preference:
 *
 *   1. **What gets assigned is a version, not an instrument** (§13.4). A template with no published
 *      version cannot be assigned at all, and the picker says so rather than offering it and
 *      letting the server 422.
 *   2. **Closing an assignment expires the attempts still in progress underneath it** (§21). That
 *      is destructive to work a student is part-way through, so the button says what it does before
 *      it does it.
 */
export function AssignmentPanel({ classId }: { classId: string }) {
  const { data: templates } = useAssessmentTemplates();
  const { data: assignments, isLoading, isError, error } = useClassAssignments(classId);
  const assign = useAssignAssessment(classId);
  const close = useCloseAssignment(classId);

  const [versionId, setVersionId] = useState('');

  const assignable = (templates ?? []).filter((t) => t.assignable_version !== null);
  const alreadyAssigned = new Set(
    (assignments ?? []).map((a) => a.assessment.version_id),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Assessments</CardTitle>
        <CardDescription>
          Assign an assessment to this class. Every student on the roster will see it the next time
          they sign in.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-64 flex-1 flex-col gap-1.5">
            <Label htmlFor="assessment">Assessment</Label>
            <Select
              id="assessment"
              value={versionId}
              onChange={(e) => setVersionId(e.target.value)}
            >
              <option value="">Choose an assessment…</option>
              {assignable.map((template) => (
                <option
                  key={template.id}
                  value={template.assignable_version!.id}
                  disabled={alreadyAssigned.has(template.assignable_version!.id)}
                >
                  {template.title} ({template.assignable_version!.question_count} questions)
                  {alreadyAssigned.has(template.assignable_version!.id)
                    ? ' — already assigned'
                    : ''}
                </option>
              ))}
            </Select>
          </div>

          <Button
            disabled={!versionId || assign.isPending}
            onClick={() =>
              assign.mutate({ versionId }, { onSuccess: () => setVersionId('') })
            }
          >
            {assign.isPending ? 'Assigning…' : 'Assign'}
          </Button>
        </div>

        {assign.error ? (
          <Alert tone="danger">
            {assign.error instanceof Error ? assign.error.message : 'Could not assign.'}
          </Alert>
        ) : null}

        {isLoading ? <p className="text-sm text-slate-500">Loading assignments…</p> : null}

        {/*
          D11. "Nothing assigned yet" on a failed load is the counselor-side version of the same
          bug: it invites the counselor to assign an assessment that may already be assigned, and
          the duplicate is then rejected by the server for reasons the screen just told them were
          impossible.
        */}
        {isError ? <Alert tone="danger">{error.message}</Alert> : null}

        {assignments && assignments.length === 0 ? (
          <p className="text-sm text-slate-500">
            Nothing assigned yet. Students see an empty list until you assign something.
          </p>
        ) : null}

        <div className="flex flex-col gap-3">
          {(assignments ?? []).map((assignment) => (
            <AssignmentRow
              key={assignment.id}
              assignment={assignment}
              closing={close.isPending}
              onClose={() => close.mutate(assignment.id)}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function AssignmentRow({
  assignment,
  closing,
  onClose,
}: {
  assignment: AssessmentAssignment;
  closing: boolean;
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const open = assignment.status === 'ACTIVE';

  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 font-medium text-slate-900">
            {assignment.assessment.title}
            {open ? <Badge tone="success">Open</Badge> : <Badge>Closed</Badge>}
          </p>
          <p className="mt-0.5 text-sm text-slate-500">
            {assignment.assessment.question_count} questions
            {typeof assignment.submitted_count === 'number'
              ? ` · ${assignment.submitted_count} completed`
              : null}
          </p>
        </div>

        {open ? (
          confirming ? (
            <div className="flex items-center gap-2">
              <Button variant="danger" onClick={onClose} disabled={closing}>
                {closing ? 'Closing…' : 'Yes, close it'}
              </Button>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="secondary" onClick={() => setConfirming(true)}>
              Close
            </Button>
          )
        ) : null}
      </div>

      {/*
        The warning is the whole reason this is a two-step button. §21: an attempt still
        IN_PROGRESS when its assignment closes becomes EXPIRED — so closing does not merely stop
        *new* students starting, it ends the work of every student who is halfway through right
        now, and their answers stop counting. A counselor who closes an assignment expecting a
        tidy "no new starts" and discovers they voided nine half-finished attempts has been
        misled by the interface, not by the rule.
      */}
      {confirming ? (
        <Alert tone="warning" className="mt-3">
          Closing this assessment will <strong>end any attempt still in progress</strong>. Students
          who are part-way through will lose their place and their answers will not be scored.
          Students who have already submitted keep their results.
        </Alert>
      ) : null}
    </div>
  );
}

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAssessmentDeletability } from '@/features/assessment-builder/hooks/useAssessments';
import { toast } from '@/stores/toastStore';
import { ApiRequestError } from '@/types/api';
import type { AssessmentRow } from '@/types/assessmentAdmin';

/**
 * Deleting an assessment — the GitHub-style confirmation.
 *
 * **Typing the name is a speed bump, not a permission check**, and it is worth being precise about
 * what it buys: it makes the action impossible to perform *accidentally*. A `window.confirm` is
 * dismissed by the same reflex that opened it; retyping "Grade 11 Study Habits Survey" cannot be
 * done by muscle memory, so the person who finishes it has read which assessment they are removing.
 * The server does not require the string and must not — it is a URL parameter the caller already
 * sent, so enforcing it would add a contract without adding a check.
 *
 * Three things this dialog does that a plain confirm cannot:
 *
 *   * **It re-checks eligibility when it opens.** The row's `can_delete` is a snapshot from
 *     whenever the table was last fetched, and a class can start the assessment while the dialog is
 *     open. `useAssessmentDeletability` asks again, uncached, so the refusal arrives *before* the
 *     delete rather than as a 422 afterwards.
 *   * **It explains a refusal in the server's own words.** The reason string is computed server-side
 *     precisely so this dialog and the API's 422 cannot describe the same block differently.
 *   * **It says what "delete" actually means here.** It is a soft delete (§12), and an administrator
 *     deciding between Archive and Delete deserves to know the difference rather than infer it.
 */

interface AssessmentDeleteDialogProps {
  /** The assessment being deleted; the dialog is open exactly when this is non-null. */
  row: AssessmentRow | null;
  onClose: () => void;
  onDelete: () => Promise<unknown>;
  isDeleting: boolean;
}

export function AssessmentDeleteDialog({
  row,
  onClose,
  onDelete,
  isDeleting,
}: AssessmentDeleteDialogProps) {
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const eligibility = useAssessmentDeletability(row?.id ?? null);

  // A fresh dialog starts empty. Without this, closing and reopening on a different assessment
  // would arrive with the previous title already typed and the button already armed.
  useEffect(() => {
    setTyped('');
    setProblem(null);
  }, [row?.id]);

  if (row === null) {
    return null;
  }

  /**
   * The live answer where we have one, the row's snapshot until it arrives.
   *
   * Falling back to the row rather than to "allowed" matters: while the re-check is in flight the
   * dialog shows the *stricter* of what it knows, so the button is never briefly armed on an
   * assessment the table already said could not be deleted.
   */
  const canDelete = eligibility.data?.can_delete ?? row.can_delete;
  const blockedReason = eligibility.data?.reason ?? row.delete_blocked_reason;
  const responseCount = eligibility.data?.response_count ?? row.response_count;

  // Trimmed and case-sensitive: a title differing only in case is a different assessment, and a
  // trailing space from a copy-paste is not a different intention.
  const nameMatches = typed.trim() === row.title;
  const armed = canDelete && nameMatches && !isDeleting && !eligibility.isFetching;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    if (!armed) {
      return;
    }

    setProblem(null);

    try {
      await onDelete();
      toast.success(`Deleted “${row!.title}”.`);
      onClose();
    } catch (error) {
      // The server re-checks the guards inside the act, so this is the case the dialog's own
      // re-check raced: something started using the assessment between opening and confirming.
      if (error instanceof ApiRequestError) {
        setProblem(error.fieldError('assessment') ?? error.message);
        void eligibility.refetch();

        return;
      }

      toast.error(error instanceof Error ? error.message : 'Could not delete the assessment.');
    }
  }

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto border border-destructive/40 bg-background p-6 text-foreground shadow-lg outline-none"
          aria-describedby="delete-assessment-description"
        >
          <DialogPrimitive.Title className="flex items-center gap-2 text-lg font-semibold">
            <AlertTriangle className="size-5 text-destructive" aria-hidden="true" />
            Delete “{row.title}”?
          </DialogPrimitive.Title>

          <p id="delete-assessment-description" className="mt-2 text-sm text-muted-foreground">
            This removes the assessment from every list, along with its versions, questions and
            dimensions. It is recoverable by an administrator with database access, but there is no
            Restore button for it — <strong className="text-foreground">Archive</strong> is the
            reversible option if you only want to stop it being assigned.
          </p>

          {eligibility.isFetching ? (
            <p
              className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"
              role="status"
            >
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Checking whether this can be deleted…
            </p>
          ) : null}

          {!canDelete && blockedReason !== null ? (
            <div className="mt-4">
              <Alert>{blockedReason}</Alert>
            </div>
          ) : null}

          {/*
            Worth showing even when nothing blocks the delete: an assessment with responses cannot
            be deleted at all, so a zero here is the fact that makes the whole action safe.
          */}
          {canDelete ? (
            <p className="mt-4 text-sm text-muted-foreground">
              No student has responded to this assessment ({responseCount} responses) and it is not
              currently assigned, so nothing is lost by removing it.
            </p>
          ) : null}

          <form className="mt-5 flex flex-col gap-4" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="delete-confirm-name">
                To confirm, type{' '}
                <span className="font-mono font-semibold text-foreground">{row.title}</span> below
              </Label>
              <Input
                id="delete-confirm-name"
                value={typed}
                autoComplete="off"
                disabled={!canDelete}
                placeholder={row.title}
                onChange={(event) => setTyped(event.target.value)}
                aria-invalid={typed !== '' && !nameMatches}
              />
              {typed !== '' && !nameMatches ? (
                <p className="text-xs text-muted-foreground">
                  The name does not match yet — it must be typed exactly.
                </p>
              ) : null}
            </div>

            {problem !== null ? <Alert>{problem}</Alert> : null}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              {/* `danger` is reserved for the button that *carries out* a destructive act, never
                  the one that opens the confirmation — which is exactly this one. */}
              <Button type="submit" variant="danger" disabled={!armed} loading={isDeleting}>
                <Trash2 className="size-4" aria-hidden="true" />
                Delete this assessment
              </Button>
            </div>
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

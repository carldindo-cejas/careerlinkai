import { Dialog, DialogContent } from '@/components/ui/dialog';
import { CareerMapping } from '@/features/admin/components/CareerMapping';
import { ProgramForm } from '@/features/admin/components/ProgramForm';
import type { Program } from '@/types/catalog';

/**
 * The program editor, as a floating card over the table (2026-09-21).
 *
 * The form used to open *inside* the list — the row it belonged to turned into a form, and
 * everything below it moved down the page. With the programs now in a table that is the wrong
 * behaviour twice over: a form cannot live inside a `<tr>` without breaking the table's own
 * layout, and pushing twenty rows down the screen loses the reader's place in the list they were
 * working through. A modal changes nothing behind it.
 *
 * Radix supplies the focus trap, the escape key, the scroll lock and `aria-modal`; `DialogContent`
 * supplies the heading, which is why the form itself is rendered `bare`.
 *
 * ## The career mapping comes with it
 *
 * It was on every program card, which is how it stayed visible while the list was cards. In a table
 * it has nowhere to go — and it belongs here anyway: linking a program to the careers it leads to
 * is editing the program, and §27 reads those links as part of the program's own score.
 *
 * It appears only when editing. A program being created has no id yet, so there is nothing to link
 * a career *to*; the line under the form says so rather than showing a picker that would 404.
 */
export interface ProgramDialogProps {
  collegeId: string;
  /** The program being edited, or `null` while adding a new one. */
  program: Program | null;
  open: boolean;
  onClose: () => void;
}

export function ProgramDialog({ collegeId, program, open, onClose }: ProgramDialogProps) {
  const isEditing = program !== null;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent
        title={isEditing ? `Edit ${program.code}` : 'Add a program'}
        description="The recommended strand is a coarse eligibility gate — a student on the other track still sees the program, ranked lower, never excluded."
        className="max-w-3xl"
      >
        <div className="flex flex-col gap-6">
          <ProgramForm
            collegeId={collegeId}
            {...(program === null ? {} : { program })}
            onSaved={onClose}
            onCancel={onClose}
            bare
          />

          {isEditing ? (
            <CareerMapping collegeId={collegeId} program={program} />
          ) : (
            <p className="border-t border-border pt-3 text-sm text-muted-foreground">
              Careers can be linked once the program is saved — until it is linked to at least one,
              it cannot be matched to a student's RIASEC profile.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

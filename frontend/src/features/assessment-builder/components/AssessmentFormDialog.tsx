import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MultiCombobox } from '@/components/ui/multi-combobox';
import { Textarea } from '@/components/ui/textarea';
import {
  useAssessmentScorings,
  useAssessmentTypes,
} from '@/features/assessment-builder/hooks/useAssessments';
import { toast } from '@/stores/toastStore';
import { ApiRequestError } from '@/types/api';
import type { AssessmentFormPayload, AssessmentRow } from '@/types/assessmentAdmin';

/**
 * Create or edit an assessment — one dialog, because the two forms are the same four fields and a
 * second copy would be a second place for the validation rules to drift.
 *
 * **The scoring options depend on the chosen type**, and that dependency is the point of the screen:
 * `assessment_type_scorings` says an Intelligence test may report IQ Scores and a Learning Style
 * inventory may not, so the multi-select is narrowed to `type.allowed_scoring_ids` and re-narrows
 * the instant the type changes. Two consequences are deliberate:
 *
 *   * **It filters with no request.** The whole matrix arrives inside the type list, so changing the
 *     type is a local computation rather than a round trip in the middle of a form.
 *   * **Changing the type drops methods the new type does not allow**, silently but visibly — the
 *     chips for them disappear as the options do. Keeping them would leave the form holding a
 *     combination the server is about to refuse, and explaining that after a failed save is worse
 *     than showing it happening.
 *
 * The filter is *not* the rule. The same matrix is enforced server-side, so a stale client is
 * refused rather than obeyed; a 422 keyed on `scoring_ids` is rendered inline under that field.
 */

interface AssessmentFormDialogProps {
  open: boolean;
  /** The row being edited; `null` opens the dialog in create mode. */
  row: AssessmentRow | null;
  onClose: () => void;
  onSave: (payload: AssessmentFormPayload) => Promise<AssessmentRow>;
  isSaving: boolean;
}

export function AssessmentFormDialog({
  open,
  row,
  onClose,
  onSave,
  isSaving,
}: AssessmentFormDialogProps) {
  const types = useAssessmentTypes();
  const scorings = useAssessmentScorings();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [typeId, setTypeId] = useState<string | null>(null);
  const [scoringIds, setScoringIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const editing = row !== null;

  // Re-seed whenever a different row is opened — or cleared, for a fresh create.
  useEffect(() => {
    if (!open) return;

    setTitle(row?.title ?? '');
    setDescription(row?.description ?? '');
    setTypeId(row?.type?.id ?? null);
    setScoringIds(row?.scorings.map((scoring) => scoring.id) ?? []);
    setErrors({});
  }, [open, row]);

  const selectedType = useMemo(
    () => types.data?.find((type) => type.id === typeId) ?? null,
    [types.data, typeId],
  );

  /** The scoring methods this type permits, in the lookup's curated order. */
  const allowedScorings = useMemo(() => {
    if (selectedType === null || scorings.data === undefined) {
      return [];
    }

    const allowed = new Set(selectedType.allowed_scoring_ids);

    return scorings.data.filter((scoring) => allowed.has(scoring.id));
  }, [selectedType, scorings.data]);

  /**
   * Changing the type drops any method the new type does not allow. Run as an effect rather than
   * inside the type's `onChange` so it also corrects a *loaded* row whose stored set predates a
   * matrix change — the form should never hold a combination it knows to be illegal.
   */
  useEffect(() => {
    if (selectedType === null) return;

    const allowed = new Set(selectedType.allowed_scoring_ids);

    setScoringIds((current) => {
      const kept = current.filter((id) => allowed.has(id));

      return kept.length === current.length ? current : kept;
    });
  }, [selectedType]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const trimmed = title.trim();
    const found: Record<string, string> = {};

    if (trimmed.length === 0) found.title = 'A title is required.';
    if (typeId === null) found.assessment_type_id = 'Choose an assessment type.';
    if (scoringIds.length === 0) found.scoring_ids = 'Choose at least one scoring method.';

    setErrors(found);

    if (Object.keys(found).length > 0) {
      return;
    }

    try {
      await onSave({
        title: trimmed,
        description: description.trim() === '' ? null : description.trim(),
        assessment_type_id: typeId!,
        scoring_ids: scoringIds,
      });

      toast.success(editing ? `Updated ${trimmed}.` : `Created ${trimmed}.`);
      onClose();
    } catch (error) {
      // A duplicate title and an incompatible scoring method are the two expected failures, and
      // both are field problems — they belong under the field, not in a toast that vanishes.
      if (error instanceof ApiRequestError) {
        const fieldErrors: Record<string, string> = {};

        for (const field of ['title', 'assessment_type_id', 'scoring_ids'] as const) {
          const message = error.fieldError(field);

          if (message) fieldErrors[field] = message;
        }

        if (Object.keys(fieldErrors).length > 0) {
          setErrors(fieldErrors);

          return;
        }
      }

      toast.error(
        error instanceof Error ? error.message : 'Could not save the assessment.',
      );
    }
  }

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto border border-border bg-background p-6 text-foreground shadow-lg outline-none"
          aria-describedby={undefined}
        >
          <DialogPrimitive.Title className="text-lg font-semibold">
            {editing ? 'Edit assessment' : 'New assessment'}
          </DialogPrimitive.Title>
          <p className="mt-1 text-sm text-muted-foreground">
            {editing
              ? 'The title, type and scoring methods describe the assessment. Its questions and versions are edited in the builder.'
              : 'Name the instrument and classify it. Questions, dimensions and versions come next, in the builder.'}
          </p>

          <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4" noValidate>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="assessment-title">Title</Label>
              <Input
                id="assessment-title"
                autoFocus
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Study Habits Survey"
                aria-invalid={Boolean(errors.title)}
                maxLength={200}
              />
              {errors.title ? <p className="text-sm text-destructive">{errors.title}</p> : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="assessment-type">Assessment type</Label>
              <Combobox
                id="assessment-type"
                value={typeId}
                onChange={setTypeId}
                options={types.data ?? []}
                loading={types.isPending}
                placeholder="Select an assessment type…"
                searchPlaceholder="Search types…"
                emptyText="No matching type."
                invalid={Boolean(errors.assessment_type_id)}
              />
              {errors.assessment_type_id ? (
                <p className="text-sm text-destructive">{errors.assessment_type_id}</p>
              ) : null}
              {selectedType?.description ? (
                <p className="text-xs text-muted-foreground">{selectedType.description}</p>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="assessment-scorings">Type of scoring</Label>
              <MultiCombobox
                id="assessment-scorings"
                value={scoringIds}
                onChange={setScoringIds}
                options={allowedScorings}
                loading={scorings.isPending}
                disabledHint={typeId === null ? 'Choose an assessment type first' : undefined}
                placeholder="Select one or more scoring methods…"
                searchPlaceholder="Search scoring methods…"
                emptyText="No matching method for this type."
                invalid={Boolean(errors.scoring_ids)}
              />
              {errors.scoring_ids ? (
                <p className="text-sm text-destructive">{errors.scoring_ids}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {selectedType === null
                    ? 'The available methods depend on the assessment type.'
                    : `${allowedScorings.length} method${allowedScorings.length === 1 ? '' : 's'} are valid for ${selectedType.name}.`}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="assessment-description">Description (optional)</Label>
              <Textarea
                id="assessment-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What this instrument measures, and who it is for."
                maxLength={2000}
              />
            </div>

            {types.isError || scorings.isError ? (
              <Alert>
                We could not load the assessment types and scoring methods, so this form cannot be
                saved yet. Close it and try again.
              </Alert>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onClose} disabled={isSaving}>
                Cancel
              </Button>
              <Button type="submit" loading={isSaving}>
                {editing ? 'Save changes' : 'Create assessment'}
              </Button>
            </div>
          </form>

          <DialogPrimitive.Close
            aria-label="Close"
            className="absolute right-3 top-3 rounded-none p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" aria-hidden="true" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

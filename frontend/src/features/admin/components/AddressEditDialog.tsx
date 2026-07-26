import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/stores/toastStore';
import type { AddressRow, UpdateAddressPayload } from '@/types/address';
import { ApiRequestError } from '@/types/api';

/**
 * Edit one place — a centered confirmation dialog for renaming a region/province/town/barangay (or
 * correcting its PSGC code). On Radix Dialog, so it carries the accessibility contract (focus trap,
 * escape-to-close, `aria-modal`) for free, exactly like the Sheet.
 *
 * The parent cannot be changed here, by design — a place cannot be re-parented (§0011), so the form
 * offers only name and code. A duplicate name comes back as a 422 keyed on `name` and is shown inline
 * under the field; any other failure raises an error toast. Success raises a success toast and closes.
 */

interface AddressEditDialogProps {
  /** Singular noun for the level, e.g. "region" — used in the copy. */
  noun: string;
  /** The row being edited; the dialog is open exactly when this is non-null. */
  row: AddressRow | null;
  onClose: () => void;
  /** The level's update mutation (`mutateAsync`), resolving with the updated row. */
  onSave: (args: { id: string; payload: UpdateAddressPayload }) => Promise<AddressRow>;
  isSaving: boolean;
}

export function AddressEditDialog({ noun, row, onClose, onSave, isSaving }: AddressEditDialogProps) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);

  // Re-seed the fields whenever a different row is opened for editing.
  useEffect(() => {
    if (row) {
      setName(row.name);
      setCode(row.code ?? '');
      setNameError(null);
    }
  }, [row]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setNameError('A name is required.');

      return;
    }

    if (!row) return;

    setNameError(null);
    const trimmedCode = code.trim();

    try {
      await onSave({
        id: row.id,
        payload: { name: trimmedName, code: trimmedCode === '' ? null : trimmedCode },
      });
      toast.success(`Updated ${trimmedName}.`);
      onClose();
    } catch (error) {
      // A duplicate name is the expected failure — keep it inline on the field. Anything else is a
      // toast (the field is fine; the request isn't).
      if (error instanceof ApiRequestError) {
        const fieldMessage = error.fieldError('name');
        if (fieldMessage) {
          setNameError(fieldMessage);

          return;
        }
      }

      toast.error(error instanceof Error ? error.message : `Could not update the ${noun}.`);
    }
  }

  return (
    <DialogPrimitive.Root
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 border border-border bg-background p-6 text-foreground shadow-lg outline-none"
          aria-describedby={undefined}
        >
          <DialogPrimitive.Title className="text-lg font-semibold">
            Edit {noun}
          </DialogPrimitive.Title>
          <p className="mt-1 text-sm text-muted-foreground">
            Rename this {noun} or correct its code. Its place in the hierarchy is preserved.
          </p>

          <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4" noValidate>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-name">Name</Label>
              <Input
                id="edit-name"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                aria-invalid={Boolean(nameError)}
                maxLength={200}
              />
              {nameError ? <p className="text-sm text-destructive">{nameError}</p> : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-code">Code (optional)</Label>
              <Input
                id="edit-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="PSGC code, if any"
                maxLength={50}
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onClose} disabled={isSaving}>
                Cancel
              </Button>
              <Button type="submit" loading={isSaving}>
                Save changes
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

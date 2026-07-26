import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { Globe, Loader2, Search, Users, X } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { cn } from '@/components/ui/cn';
import { classApi } from '@/services/classApi';
import { toast } from '@/stores/toastStore';
import { ApiRequestError } from '@/types/api';
import type { AssessmentRow, AssignPayload, AssignResult } from '@/types/assessmentAdmin';

/**
 * Assign an assessment — globally, or to particular classes.
 *
 * **Global is not a different kind of assignment.** It writes one ordinary assignment per active
 * class in a single act, so every rule downstream (who may start an attempt, who may read one, who
 * gets the notification) keeps resolving through a real class. The copy says so rather than leaving
 * "Global" to be guessed at, because an administrator choosing between these two is choosing a
 * blast radius.
 *
 * It is safe to run twice: the server skips a class that already holds this version, so re-assigning
 * globally after new classes are created is a top-up rather than a pile of duplicates. The result
 * message reports both numbers.
 */

interface AssessmentAssignDialogProps {
  /** The assessment being assigned; the dialog is open exactly when this is non-null. */
  row: AssessmentRow | null;
  onClose: () => void;
  onAssign: (payload: AssignPayload) => Promise<AssignResult>;
  isAssigning: boolean;
}

export function AssessmentAssignDialog({
  row,
  onClose,
  onAssign,
  isAssigning,
}: AssessmentAssignDialogProps) {
  const [scope, setScope] = useState<'GLOBAL' | 'CLASS'>('GLOBAL');
  const [selected, setSelected] = useState<string[]>([]);
  const [versionId, setVersionId] = useState<string>('');
  const [deadline, setDeadline] = useState('');
  const [search, setSearch] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const classes = useQuery({
    queryKey: ['classes', 'all'],
    queryFn: () => classApi.listAll(),
    // Only fetched once the dialog is open — a class list is not needed to render a table row.
    enabled: row !== null,
  });

  const publishedVersions = useMemo(
    () => row?.versions.filter((version) => version.status === 'PUBLISHED') ?? [],
    [row],
  );

  useEffect(() => {
    if (row === null) return;

    setScope('GLOBAL');
    setSelected([]);
    setDeadline('');
    setSearch('');
    setProblem(null);
    // Defaults to the newest published version, which is what the server would have chosen anyway.
    setVersionId(row.published_version?.id ?? '');
  }, [row]);

  /** Only `active` classes can be assigned to — a draft accepts no joins, an archived one is done. */
  const assignable = useMemo(
    () => (classes.data ?? []).filter((classRoom) => classRoom.status === 'active'),
    [classes.data],
  );

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();

    return term.length === 0
      ? assignable
      : assignable.filter(
          (classRoom) =>
            classRoom.name.toLowerCase().includes(term) ||
            classRoom.academic_year.toLowerCase().includes(term),
        );
  }, [assignable, search]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    if (row === null) return;

    if (scope === 'CLASS' && selected.length === 0) {
      setProblem('Choose at least one class, or assign this globally.');

      return;
    }

    setProblem(null);

    // A date input gives `2026-08-01`; the API wants an offset-bearing ISO instant. End of day, so a
    // deadline of "the 1st" does not expire at midnight *starting* the 1st.
    const deadlineIso =
      deadline === '' ? null : new Date(`${deadline}T23:59:59`).toISOString();

    const base = {
      ...(versionId === '' ? {} : { assessment_version_id: versionId }),
      deadline: deadlineIso,
    };

    try {
      const result = await onAssign(
        scope === 'GLOBAL'
          ? { scope: 'GLOBAL', ...base }
          : { scope: 'CLASS', class_ids: selected, ...base },
      );

      if (result.assigned_classes === 0) {
        toast.info(
          scope === 'GLOBAL'
            ? 'Every active class already has this assessment.'
            : 'Those classes already have this assessment.',
        );
      } else {
        const plural = result.assigned_classes === 1 ? 'class' : 'classes';

        toast.success(
          result.skipped_classes === 0
            ? `Assigned to ${result.assigned_classes} ${plural}.`
            : `Assigned to ${result.assigned_classes} ${plural}; ${result.skipped_classes} already had it.`,
        );
      }

      onClose();
    } catch (error) {
      if (error instanceof ApiRequestError) {
        setProblem(
          error.fieldError('assessment_version_id') ??
            error.fieldError('class_ids') ??
            error.message,
        );

        return;
      }

      toast.error(error instanceof Error ? error.message : 'Could not assign the assessment.');
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
          className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto border border-border bg-background p-6 text-foreground shadow-lg outline-none"
          aria-describedby={undefined}
        >
          <DialogPrimitive.Title className="text-lg font-semibold">
            Assign {row?.title}
          </DialogPrimitive.Title>
          <p className="mt-1 text-sm text-muted-foreground">
            Students take a published version. Assigning again later tops up any class that does not
            have it yet.
          </p>

          <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4" noValidate>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">Who gets it</legend>

              <ScopeChoice
                checked={scope === 'GLOBAL'}
                onSelect={() => setScope('GLOBAL')}
                icon={<Globe className="size-4" aria-hidden="true" />}
                title="Globally"
                description={`Every active class — ${assignable.length} right now. Classes created later can be topped up by assigning again.`}
              />
              <ScopeChoice
                checked={scope === 'CLASS'}
                onSelect={() => setScope('CLASS')}
                icon={<Users className="size-4" aria-hidden="true" />}
                title="Specific classes"
                description="Only the classes you pick below."
              />
            </fieldset>

            {scope === 'CLASS' ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="assign-class-search">Classes</Label>
                  <span className="text-xs text-muted-foreground">
                    {selected.length} selected
                  </span>
                </div>

                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Input
                    id="assign-class-search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search classes…"
                    className="pl-9"
                  />
                </div>

                <div className="max-h-52 overflow-y-auto border border-border">
                  {classes.isPending ? (
                    <div className="flex justify-center py-6" role="status">
                      <Loader2
                        className="size-5 animate-spin text-muted-foreground"
                        aria-hidden="true"
                      />
                      <span className="sr-only">Loading classes…</span>
                    </div>
                  ) : filtered.length === 0 ? (
                    <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                      {assignable.length === 0
                        ? 'There are no active classes yet.'
                        : 'No classes match that search.'}
                    </p>
                  ) : (
                    <ul>
                      {filtered.map((classRoom) => (
                        <li key={classRoom.id} className="border-b border-border last:border-b-0">
                          <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-muted">
                            <input
                              type="checkbox"
                              checked={selected.includes(classRoom.id)}
                              onChange={(event) =>
                                setSelected((current) =>
                                  event.target.checked
                                    ? [...current, classRoom.id]
                                    : current.filter((id) => id !== classRoom.id),
                                )
                              }
                            />
                            <span className="flex-1 truncate">{classRoom.name}</span>
                            <span className="text-xs text-muted-foreground">
                              {classRoom.academic_year}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ) : null}

            {publishedVersions.length > 1 ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="assign-version">Version</Label>
                <Select
                  id="assign-version"
                  value={versionId}
                  onChange={(event) => setVersionId(event.target.value)}
                >
                  {publishedVersions.map((version) => (
                    <option key={version.id} value={version.id}>
                      v{version.version_number}
                      {version.id === row?.published_version?.id ? ' (latest)' : ''}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="assign-deadline">Deadline (optional)</Label>
              <Input
                id="assign-deadline"
                type="date"
                value={deadline}
                onChange={(event) => setDeadline(event.target.value)}
              />
            </div>

            {row !== null && row.published_version === null ? (
              <Alert>
                This assessment has no published version yet, so there is nothing students could
                take. Publish one in the builder first.
              </Alert>
            ) : null}

            {problem ? <Alert>{problem}</Alert> : null}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onClose} disabled={isAssigning}>
                Cancel
              </Button>
              <Button
                type="submit"
                loading={isAssigning}
                disabled={row?.published_version === null}
              >
                {scope === 'GLOBAL' ? 'Assign globally' : 'Assign to selected'}
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

/** One of the two scopes, as a radio the whole card selects — the choice is a decision, not a toggle. */
function ScopeChoice({
  checked,
  onSelect,
  icon,
  title,
  description,
}: {
  checked: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-3 border p-3 transition-colors',
        checked ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted',
      )}
    >
      <input
        type="radio"
        name="assign-scope"
        checked={checked}
        onChange={onSelect}
        className="mt-1"
      />
      <span className="flex flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          {icon}
          {title}
        </span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}

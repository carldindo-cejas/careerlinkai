import { ChevronDown, GitMerge, Loader2, MapPin, Pencil, Plus, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { toast } from '@/stores/toastStore';
import {
  useCanonicalProgramColleges,
  useCanonicalPrograms,
  useCreateCanonicalProgram,
  useMergeCanonicalPrograms,
  useUpdateCanonicalProgram,
} from '@/features/admin/hooks/useCatalog';
import { ApiRequestError } from '@/types/api';
import type { CanonicalProgram } from '@/types/catalog';

/**
 * The canonical program catalog (backend migration 0018).
 *
 * ## Why this screen exists
 *
 * `programs.college_id` is NOT NULL: a `programs` row *is* "this program, at this college". That is
 * the right model for the rest of the admin surface, but it leaves one student-facing question
 * unanswerable — **"which colleges offer BS Computer Science?"** — because UP Diliman's BSCS and
 * DLSU's BSCS share nothing but a string. `program_catalog` promotes that string to a row, so the
 * answer becomes a join.
 *
 * The 0018 migration backfilled one canonical entry per **normalized code**, which is a starting
 * point rather than an answer: where two colleges use one code for different programs, or two codes
 * for one, the grouping is wrong and a student sees the wrong list. This page is where that gets
 * fixed. Without it the FK would be a column nobody could correct — which is exactly why the
 * decision to add the table came with the decision to add this screen.
 *
 * ## Merge is the important control
 *
 * Editing a name is cosmetic. **Merge** re-points every college offering that named the absorbed
 * entry and retires it, which is the one operation that changes what students are shown. It
 * confirms first, and it is audited as its own action (`CANONICAL_PROGRAM_MERGED`) rather than as
 * an update, because the row it writes records how many offerings moved — the only trace of a
 * change nothing else logs.
 */
export function CanonicalProgramPage() {
  const [page, setPage] = useState(1);
  const [isAdding, setIsAdding] = useState(false);
  const [editing, setEditing] = useState<CanonicalProgram | null>(null);
  const [merging, setMerging] = useState<CanonicalProgram | null>(null);

  const { data, isPending, isError, error } = useCanonicalPrograms(page);

  const entries = data?.items ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h1 className="text-xl font-semibold text-foreground">Canonical programs</h1>
          <p className="text-sm text-muted-foreground">
            One entry per program as a thing in the world — &ldquo;BS Computer Science&rdquo; —
            of which each college&apos;s program is one offering. This is what makes{' '}
            <em>&ldquo;which colleges offer this?&rdquo;</em> answerable for a student.
          </p>
        </div>

        {!isAdding ? (
          <Button onClick={() => setIsAdding(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Add canonical program
          </Button>
        ) : null}
      </div>

      <Alert tone="info">
        Existing programs were grouped automatically by their code when this feature was added. That
        is a starting point, not a verdict — use <strong>Merge</strong> where two entries are really
        the same program.
      </Alert>

      {isAdding ? <CanonicalForm onDone={() => setIsAdding(false)} /> : null}
      {editing ? <CanonicalForm entry={editing} onDone={() => setEditing(null)} /> : null}
      {merging ? (
        <MergePanel
          source={merging}
          candidates={entries.filter((entry) => entry.id !== merging.id)}
          onDone={() => setMerging(null)}
        />
      ) : null}

      {isPending ? (
        <div className="flex justify-center py-12" role="status">
          <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
          <span className="sr-only">Loading canonical programs…</span>
        </div>
      ) : null}

      {isError ? <Alert>{error.message}</Alert> : null}

      {data && entries.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Nothing here yet</CardTitle>
            <CardDescription>
              Canonical entries are created automatically the first time a program uses a new code,
              so this fills itself as the catalog grows.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <div className="flex flex-col gap-3">
        {entries.map((entry) => (
          <CanonicalRow
            key={entry.id}
            entry={entry}
            onEdit={() => setEditing(entry)}
            onMerge={() => setMerging(entry)}
          />
        ))}
      </div>

      {data && data.pagination.last_page > 1 ? (
        <div className="flex items-center justify-between gap-3">
          <Button
            variant="secondary"
            disabled={page <= 1}
            onClick={() => setPage((current) => current - 1)}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {data.pagination.current_page} of {data.pagination.last_page}
          </span>
          <Button
            variant="secondary"
            disabled={page >= data.pagination.last_page}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function CanonicalRow({
  entry,
  onEdit,
  onMerge,
}: {
  entry: CanonicalProgram;
  onEdit: () => void;
  onMerge: () => void;
}) {
  const [showColleges, setShowColleges] = useState(false);
  const { data, isLoading } = useCanonicalProgramColleges(entry.id, showColleges);

  const count = entry.offerings_count ?? 0;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="flex flex-wrap items-center gap-2 font-medium text-foreground">
              {entry.name}
              <Badge>{entry.code}</Badge>
              {entry.status === 'archived' ? <Badge tone="warning">Archived</Badge> : null}
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {/*
                The count is the whole reason an admin scans this list: an entry with one offering
                where they expected four is a grouping that needs merging.
              */}
              {count === 0
                ? 'No college currently offers this'
                : `${count} college ${count === 1 ? 'offering' : 'offerings'}`}
              {entry.description ? ` · ${entry.description}` : null}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setShowColleges((c) => !c)}>
              <ChevronDown className="size-4" aria-hidden="true" />
              {showColleges ? 'Hide colleges' : 'View colleges'}
            </Button>
            <Button variant="secondary" size="sm" onClick={onEdit}>
              <Pencil className="size-4" aria-hidden="true" />
              Edit
            </Button>
            <Button variant="secondary" size="sm" onClick={onMerge}>
              <GitMerge className="size-4" aria-hidden="true" />
              Merge
            </Button>
          </div>
        </div>

        {showColleges ? (
          isLoading ? (
            <p className="text-sm text-muted-foreground">Loading colleges…</p>
          ) : (data?.offerings.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">
              No active college offers this program. If that is wrong, the offering is probably
              pointed at a different canonical entry — merge them.
            </p>
          ) : (
            <ul className="flex flex-col gap-2 border-l-2 border-border pl-4">
              {data!.offerings.map(({ college, program }) => (
                <li
                  key={program.id}
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                >
                  <span className="text-foreground">
                    {college.name}
                    <span className="ml-2 text-muted-foreground">
                      {program.code} · {program.name}
                    </span>
                  </span>
                  {college.map_link ? (
                    <a
                      href={college.map_link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs text-primary underline"
                    >
                      <MapPin className="size-3" aria-hidden="true" />
                      Map
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}

function CanonicalForm({ entry, onDone }: { entry?: CanonicalProgram; onDone: () => void }) {
  const create = useCreateCanonicalProgram();
  const update = useUpdateCanonicalProgram();
  const mutation = entry ? update : create;

  const [code, setCode] = useState(entry?.code ?? '');
  const [name, setName] = useState(entry?.name ?? '');
  const [description, setDescription] = useState(entry?.description ?? '');

  const serverError = mutation.error instanceof ApiRequestError ? mutation.error : null;

  function onSubmit(event: FormEvent) {
    event.preventDefault();

    if (mutation.isPending) return;

    const payload = {
      code: code.trim(),
      name: name.trim(),
      description: description.trim() === '' ? null : description.trim(),
    };

    if (entry) {
      update.mutate(
        { id: entry.id, payload },
        {
          onSuccess: (saved) => {
            toast.success(`Saved ${saved.name}.`);
            onDone();
          },
        },
      );
    } else {
      create.mutate(payload, {
        onSuccess: (saved) => {
          toast.success(`Created ${saved.name}.`);
          onDone();
        },
      });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{entry ? `Edit ${entry.name}` : 'New canonical program'}</CardTitle>
        <CardDescription>
          The code is normalised — case, spaces, hyphens and dots are stripped — so
          &ldquo;bs-cs&rdquo; and &ldquo;BSCS&rdquo; are the same entry.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {serverError && Object.keys(serverError.errors).length === 0 ? (
            <Alert>{serverError.message}</Alert>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="canonical-code">Code</Label>
              <Input
                id="canonical-code"
                value={code}
                placeholder="BSCS"
                aria-invalid={Boolean(serverError?.fieldError('code'))}
                onChange={(event) => setCode(event.target.value)}
              />
              {serverError?.fieldError('code') ? (
                <p className="text-sm text-destructive">{serverError.fieldError('code')}</p>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="canonical-name">Name</Label>
              <Input
                id="canonical-name"
                value={name}
                placeholder="BS Computer Science"
                aria-invalid={Boolean(serverError?.fieldError('name'))}
                onChange={(event) => setName(event.target.value)}
              />
              {serverError?.fieldError('name') ? (
                <p className="text-sm text-destructive">{serverError.fieldError('name')}</p>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5 sm:col-span-3">
              <Label htmlFor="canonical-description">Description (optional)</Label>
              <Input
                id="canonical-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
          </div>

          <div className="flex gap-2">
            <Button type="submit" loading={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : entry ? 'Save changes' : 'Create'}
            </Button>
            <Button type="button" variant="secondary" onClick={onDone}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Merge, behind a confirmation.
 *
 * It is the one control on this page that changes what a student sees, and it is not reversible
 * from the UI — so the panel states the consequence in the terms it will actually have ("N college
 * offerings will move") rather than asking "are you sure?".
 */
function MergePanel({
  source,
  candidates,
  onDone,
}: {
  source: CanonicalProgram;
  candidates: CanonicalProgram[];
  onDone: () => void;
}) {
  const merge = useMergeCanonicalPrograms();
  const [targetId, setTargetId] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  const target = candidates.find((entry) => entry.id === targetId) ?? null;
  const moving = source.offerings_count ?? 0;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Merge &ldquo;{source.name}&rdquo; into another entry</CardTitle>
          <CardDescription>
            Every college offering that currently points at {source.code} will point at the entry
            you choose, and {source.code} is retired. This cannot be undone here.
          </CardDescription>
        </div>
        <Button variant="ghost" size="sm" onClick={onDone} aria-label="Cancel the merge">
          <X className="size-4" aria-hidden="true" />
        </Button>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {merge.isError ? (
          <Alert>
            {merge.error instanceof Error ? merge.error.message : 'The merge could not be applied.'}
          </Alert>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="merge-target">Keep this entry</Label>
          <Select
            id="merge-target"
            value={targetId}
            onChange={(event) => {
              setTargetId(event.target.value);
              // A changed target invalidates the confirmation — the sentence they agreed to
              // named a different program.
              setConfirmed(false);
            }}
          >
            <option value="">Choose the entry that survives…</option>
            {candidates.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.code} · {entry.name} ({entry.offerings_count ?? 0} offerings)
              </option>
            ))}
          </Select>
        </div>

        {target ? (
          <Alert tone="warning">
            {moving === 0
              ? `${source.code} has no offerings to move. It will simply be retired.`
              : `${moving} college ${moving === 1 ? 'offering' : 'offerings'} will move from ${source.code} to ${target.code}, and ${source.code} will be retired.`}
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          {!confirmed ? (
            <Button variant="secondary" disabled={target === null} onClick={() => setConfirmed(true)}>
              Review this merge
            </Button>
          ) : (
            <Button
              variant="danger"
              loading={merge.isPending}
              disabled={merge.isPending || target === null}
              onClick={() =>
                merge.mutate(
                  { id: source.id, targetId: target!.id },
                  {
                    onSuccess: (result) => {
                      // The panel closes on success, so without this the only evidence the merge
                      // happened is a list that quietly reordered itself.
                      toast.success(
                        `Merged into ${result.target.name}. ${result.offerings_moved} college ${
                          result.offerings_moved === 1 ? 'offering' : 'offerings'
                        } moved.`,
                      );
                      onDone();
                    },
                  },
                )
              }
            >
              {merge.isPending ? 'Merging…' : `Yes, merge into ${target!.code}`}
            </Button>
          )}

          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

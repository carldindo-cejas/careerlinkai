import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  CANONICAL_OPTION_LIMIT,
  useCanonicalProgramOptions,
  useCreateProgram,
  useUpdateProgram,
} from '@/features/admin/hooks/useCatalog';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '@/hooks/useDebouncedValue';
import { ApiRequestError } from '@/types/api';
import { STRANDS, type CanonicalProgram, type Program, type Strand } from '@/types/catalog';

/**
 * Add or edit a program under a college (FULLPLAN §57, Phase 2).
 *
 * There is no college field, in either mode. A program is created *through* its college
 * (the id comes from the route) and can never be moved to another one — doing so would
 * silently rewrite the college that §27 derives for every recommendation already pointing
 * at this program. The server refuses it too; this form simply never offers it.
 *
 * ## Start from a program that already exists
 *
 * A program in this system is two things: the **canonical** entry — "BS Computer Science" as a
 * thing in the world (migration 0018) — and this college's offering of it. Until now the form only
 * ever collected the second, and the server inferred the first from the code: an unmatched code
 * *mints a new canonical entry*. That is a reasonable default and a poor only-option, because the
 * codes people type vary ("BSIT", "BS-IT", "BS Info Tech") in ways the normaliser deliberately
 * refuses to guess at, and every near-miss is a duplicate canonical row that has to be found and
 * merged later on a screen the admin has no reason to visit.
 *
 * So the form now opens with the picker: choose the entry that already exists, and its code and
 * name fill in and travel as `program_catalog_id`. The two fields stay editable underneath —
 * `code` is the *college's* code for the offering and is genuinely allowed to differ — and typing
 * a code for something nobody has recorded yet still works exactly as it did. The picker is an
 * offer, not a gate.
 */

const NO_STRAND = '__none__';

const programSchema = z.object({
  code: z.string().min(1, 'Give the program a code.').max(30),
  name: z.string().min(1, 'Give the program its full name.').max(200),
  department_name: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  // The sentinel keeps "no requirement" distinguishable from "not answered" in a native
  // select, whose value is always a string.
  recommended_strand: z.string(),
  status: z.enum(['draft', 'active', 'archived']),
});

type ProgramValues = z.infer<typeof programSchema>;

export interface ProgramFormProps {
  collegeId: string;
  /** Omitted when adding. Present when editing an existing program. */
  program?: Program;
  onSaved: () => void;
  onCancel: () => void;
}

export function ProgramForm({ collegeId, program, onSaved, onCancel }: ProgramFormProps) {
  const isEditing = Boolean(program);

  const createProgram = useCreateProgram(collegeId);
  const updateProgram = useUpdateProgram(collegeId);
  const mutation = isEditing ? updateProgram : createProgram;

  /**
   * The canonical entry this offering *is*.
   *
   * Seeded from the program on an edit, so the picker opens showing what the offering is already
   * matched to rather than looking unset — and `null` there is a real state ("nobody has decided
   * what this is") that the empty picker states rather than hides.
   */
  const [canonical, setCanonical] = useState<CanonicalProgram | null>(program?.canonical ?? null);
  /** Seeded from the same field, so "unchanged" is measured against what the picker actually showed. */
  const initialCanonicalId = program?.canonical?.id ?? null;
  const [search, setSearch] = useState('');
  const [isPickerOpen, setIsPickerOpen] = useState(false);

  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);

  /*
   * Server-searched and server-capped at 20, and `isPickerOpen` keeps it from firing until the
   * dropdown is actually opened — the same two rules the careers picker follows for the same
   * reason (audit F3): a client cannot correctly filter a list it does not have, and a form that
   * fetches a catalog nobody opened pays for it on every render.
   */
  const options = useCanonicalProgramOptions(debouncedSearch, isPickerOpen);
  const candidates = options.data ?? [];

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<ProgramValues>({
    resolver: zodResolver(programSchema),
    defaultValues: {
      code: program?.code ?? '',
      name: program?.name ?? '',
      department_name: program?.department_name ?? '',
      description: program?.description ?? '',
      recommended_strand: program?.recommended_strand ?? NO_STRAND,
      status: program?.status ?? 'active',
    },
  });

  const serverError = mutation.error instanceof ApiRequestError ? mutation.error : null;
  const generalError =
    serverError && Object.keys(serverError.errors).length === 0 ? serverError.message : null;

  const canonicalId = canonical?.id ?? null;

  /**
   * Choosing an entry fills the two fields it identifies.
   *
   * `shouldDirty` so react-hook-form treats them as touched, and the inputs stay editable after —
   * the picker says *which program this is*, not what this college calls it.
   */
  function pickCanonical(entry: CanonicalProgram | null) {
    setCanonical(entry);

    if (entry === null) return;

    setValue('code', entry.code, { shouldDirty: true, shouldValidate: true });
    setValue('name', entry.name, { shouldDirty: true, shouldValidate: true });
  }

  const onSubmit = handleSubmit((values) => {
    const payload = {
      code: values.code,
      name: values.name,
      department_name: values.department_name || undefined,
      description: values.description || undefined,
      // Explicitly null, never undefined: null is the "no strand requirement" claim, and
      // dropping the key would leave an existing requirement in place on an edit.
      recommended_strand:
        values.recommended_strand === NO_STRAND ? null : (values.recommended_strand as Strand),
      status: values.status,
      /*
        Three states, and they are genuinely three (see `CreateProgramPayload`):

          an id      the admin picked an existing entry — use it, do not mint anything;
          null       the admin *cleared* a link that was there — "we have not decided what this
                     is", a real state, and not the same as "leave it alone";
          omitted    the picker was not touched. On a create that is the pre-existing behaviour and
                     still the right default — the server matches the code and mints the canonical
                     entry if it is new. On an edit it leaves the link exactly as it was.

        The key is sent **only when the value changed**, measured against the same field the state
        was seeded from. That is what makes the omitted case safe: an endpoint that did not load
        `canonical` shows an empty picker, and an empty picker the admin never touched must not be
        read as a request to unlink the offering.
      */
      ...(canonicalId !== initialCanonicalId ? { program_catalog_id: canonicalId } : {}),
    };

    if (program) {
      updateProgram.mutate({ id: program.id, payload }, { onSuccess: onSaved });
    } else {
      createProgram.mutate(payload, { onSuccess: onSaved });
    }
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{isEditing ? `Edit ${program?.code}` : 'Add a program'}</CardTitle>
        <CardDescription>
          The recommended strand is a coarse eligibility gate — a student on the other track
          still sees the program, ranked lower, never excluded.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {generalError ? <Alert>{generalError}</Alert> : null}

          {/*
            The picker, above the two fields it fills, because choosing is the first thing to do
            and retyping a program the catalog already knows about is the thing this is here to
            stop. Clearable: "not yet decided" is a legitimate answer, and on an edit it is the way
            to unlink an offering that was matched to the wrong entry.
          */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="program-canonical">Program</Label>
            <Combobox
              id="program-canonical"
              value={canonical?.id ?? null}
              selectedLabel={canonical ? `${canonical.code} · ${canonical.name}` : null}
              onChange={(id) => pickCanonical(candidates.find((entry) => entry.id === id) ?? null)}
              options={candidates.map((entry) => ({
                id: entry.id,
                name: `${entry.code} · ${entry.name}`,
              }))}
              query={search}
              onQueryChange={setSearch}
              onOpenChange={setIsPickerOpen}
              loading={options.isFetching}
              clearable
              placeholder="Choose a program already in the catalog…"
              searchPlaceholder="Search by name or code…"
              emptyText={
                search.trim() === ''
                  ? 'No programs in the catalog yet — type the code and name below instead.'
                  : `Nothing matches “${search.trim()}”. Type the code and name below and it will be added.`
              }
              footer={
                candidates.length >= CANONICAL_OPTION_LIMIT
                  ? `Showing the first ${CANONICAL_OPTION_LIMIT} matches — refine your search to narrow this down.`
                  : null
              }
            />
            <p className="text-xs text-muted-foreground">
              {canonical
                ? 'This offering is matched to the shared catalog, so “which colleges offer this?” finds it.'
                : 'Optional. Pick an existing program to avoid a near-duplicate entry, or leave this and a new one is created from the code below.'}
            </p>
            <FieldError message={serverError?.fieldError('program_catalog_id')} />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="program-code">Code</Label>
              <Input
                id="program-code"
                autoFocus
                placeholder="BSCS"
                aria-invalid={Boolean(errors.code ?? serverError?.fieldError('code'))}
                {...register('code')}
              />
              {/* Codes are unique per college, not globally — "BSCS" at UP and at DLSU are
                  different programs, so this 422 only fires within one institution. */}
              <FieldError message={errors.code?.message ?? serverError?.fieldError('code')} />
            </div>

            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="program-name">Name</Label>
              <Input
                id="program-name"
                placeholder="BS Computer Science"
                aria-invalid={Boolean(errors.name ?? serverError?.fieldError('name'))}
                {...register('name')}
              />
              <FieldError message={errors.name?.message ?? serverError?.fieldError('name')} />
            </div>

            <div className="flex flex-col gap-1.5 sm:col-span-3">
              <Label htmlFor="program-department">Department</Label>
              <Input
                id="program-department"
                placeholder="College of Computer Studies"
                {...register('department_name')}
              />
              <FieldError message={serverError?.fieldError('department_name')} />
            </div>

            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="program-strand">Recommended strand</Label>
              <Select
                id="program-strand"
                aria-invalid={Boolean(serverError?.fieldError('recommended_strand'))}
                {...register('recommended_strand')}
              >
                <option value={NO_STRAND}>No strand requirement</option>
                {STRANDS.map((strand) => (
                  <option key={strand} value={strand}>
                    {strand}
                  </option>
                ))}
              </Select>
              <FieldError message={serverError?.fieldError('recommended_strand')} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="program-status">Status</Label>
              <Select id="program-status" {...register('status')}>
                <option value="active">Active</option>
                <option value="draft">Draft</option>
                <option value="archived">Archived</option>
              </Select>
              {/* Only an active program is ever recommended (§27) — so this is not a label,
                  it is the difference between a program students can be matched to and one
                  that exists only in the catalog. */}
              <p className="text-xs text-muted-foreground">Only active programs are recommended.</p>
            </div>

            <div className="flex flex-col gap-1.5 sm:col-span-3">
              <Label htmlFor="program-description">Description</Label>
              <Textarea id="program-description" rows={2} {...register('description')} />
              <FieldError message={serverError?.fieldError('description')} />
            </div>
          </div>

          <div className="flex gap-2">
            <Button type="submit" loading={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : isEditing ? 'Save program' : 'Add program'}
            </Button>
            <Button type="button" variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function FieldError({ message }: { message?: string | undefined }) {
  return message ? <p className="text-sm text-destructive">{message}</p> : null;
}

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useCreateProgram, useUpdateProgram } from '@/features/admin/hooks/useCatalog';
import { ApiRequestError } from '@/types/api';
import { STRANDS, type Program, type Strand } from '@/types/catalog';

/**
 * Add or edit a program under a college (FULLPLAN §57, Phase 2).
 *
 * There is no college field, in either mode. A program is created *through* its college
 * (the id comes from the route) and can never be moved to another one — doing so would
 * silently rewrite the college that §27 derives for every recommendation already pointing
 * at this program. The server refuses it too; this form simply never offers it.
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

  const {
    register,
    handleSubmit,
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
              <p className="text-xs text-slate-500">Only active programs are recommended.</p>
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
  return message ? <p className="text-sm text-red-600">{message}</p> : null;
}

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useClassOptions, useCreateClass } from '@/features/counselor/hooks/useClasses';
import { ApiRequestError } from '@/types/api';
import type { ClassRoom } from '@/types/class';

/**
 * Create a class (FULLPLAN §57, Phase 1A).
 *
 * There is no join-code field here, and there must never be one: the code is generated
 * server-side at creation and comes back on the response (§38). A client that could choose
 * its own code could choose a guessable one.
 */

/**
 * Grade level and strand are ids into the §13.1 lookups since migration 0017, not free text.
 *
 * They are also **the source of every enrolled student's own two fields** — which is why they
 * stopped being a text box. "Gr 12" typed here produced a profile value §27 could not read and the
 * student could not correct, and a student in a class the counselor put them in should not have to
 * re-type a fact the school already holds.
 *
 * Both optional: a counselor who has not decided yet gets a class whose students keep both fields
 * editable, which is the honest intermediate state. Refusing to create a class without a strand
 * would be gating class creation on something a class is not for.
 */
const createClassSchema = z.object({
  name: z.string().min(1, 'Give the class a name.').max(150),
  academic_year: z.string().min(1, 'Which academic year is this?').max(20),
  grade_level_id: z.string().optional(),
  shs_strand_id: z.string().optional(),
});

type CreateClassValues = z.infer<typeof createClassSchema>;

export interface CreateClassFormProps {
  onCreated: (created: ClassRoom) => void;
  onCancel: () => void;
}

export function CreateClassForm({ onCreated, onCancel }: CreateClassFormProps) {
  const createClass = useCreateClass();
  const { data: options } = useClassOptions();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CreateClassValues>({
    resolver: zodResolver(createClassSchema),
    defaultValues: { name: '', academic_year: '', grade_level_id: '', shs_strand_id: '' },
  });

  const serverError = createClass.error instanceof ApiRequestError ? createClass.error : null;
  const generalError =
    serverError && Object.keys(serverError.errors).length === 0 ? serverError.message : null;

  const onSubmit = handleSubmit((values) => {
    createClass.mutate(
      {
        name: values.name,
        academic_year: values.academic_year,
        // `null`, not `''` — "not selected" is a real value the server stores, and an empty
        // string is not a uuid.
        grade_level_id: values.grade_level_id || null,
        shs_strand_id: values.shs_strand_id || null,
      },
      { onSuccess: onCreated },
    );
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>New class</CardTitle>
        <CardDescription>
          The class code is generated when the class is created — you can read it out before
          anyone is on the roster.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {generalError ? <Alert>{generalError}</Alert> : null}

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5 sm:col-span-3">
              <Label htmlFor="name">Class name</Label>
              <Input
                id="name"
                autoFocus
                placeholder="Grade 12 STEM A"
                aria-invalid={Boolean(errors.name ?? serverError?.fieldError('name'))}
                {...register('name')}
              />
              <FieldError message={errors.name?.message ?? serverError?.fieldError('name')} />
            </div>

            <div className="flex flex-col gap-1.5 sm:col-span-3">
              <Label htmlFor="academic_year">Academic year</Label>
              <Input
                id="academic_year"
                placeholder="2026-2027"
                aria-invalid={Boolean(errors.academic_year ?? serverError?.fieldError('academic_year'))}
                {...register('academic_year')}
              />
              <FieldError
                message={errors.academic_year?.message ?? serverError?.fieldError('academic_year')}
              />
            </div>

            <div className="flex flex-col gap-1.5 sm:col-span-3">
              <p className="text-sm text-muted-foreground">
                Grade level and strand are applied to every student you enrol in this class, and
                they cannot change them themselves. Leave either blank if you are not sure yet.
              </p>
            </div>

            <div className="flex flex-col gap-1.5 sm:col-span-1">
              <Label htmlFor="grade_level_id">Grade level</Label>
              <Select
                id="grade_level_id"
                aria-invalid={Boolean(serverError?.fieldError('grade_level_id'))}
                {...register('grade_level_id')}
              >
                <option value="">Not set</option>
                {(options?.grade_levels ?? []).map((level) => (
                  <option key={level.id} value={level.id}>
                    {level.name}
                  </option>
                ))}
              </Select>
              <FieldError message={serverError?.fieldError('grade_level_id')} />
            </div>

            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="shs_strand_id">SHS strand</Label>
              <Select
                id="shs_strand_id"
                aria-invalid={Boolean(serverError?.fieldError('shs_strand_id'))}
                {...register('shs_strand_id')}
              >
                <option value="">Not set</option>
                {(options?.shs_strands ?? []).map((strand) => (
                  <option key={strand.id} value={strand.id}>
                    {strand.name}
                    {strand.description ? ` (${strand.description})` : null}
                  </option>
                ))}
              </Select>
              <FieldError message={serverError?.fieldError('shs_strand_id')} />
            </div>
          </div>

          <div className="flex gap-2">
            <Button type="submit" loading={createClass.isPending}>
              {createClass.isPending ? 'Creating…' : 'Create class'}
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

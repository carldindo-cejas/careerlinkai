import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCreateClass } from '@/features/counselor/hooks/useClasses';
import { ApiRequestError } from '@/types/api';
import type { ClassRoom } from '@/types/class';

/**
 * Create a class (FULLPLAN §57, Phase 1A).
 *
 * There is no join-code field here, and there must never be one: the code is generated
 * server-side at creation and comes back on the response (§38). A client that could choose
 * its own code could choose a guessable one.
 */

const createClassSchema = z.object({
  name: z.string().min(1, 'Give the class a name.').max(150),
  academic_year: z.string().min(1, 'Which academic year is this?').max(20),
  grade_level: z.string().max(20).optional(),
});

type CreateClassValues = z.infer<typeof createClassSchema>;

export interface CreateClassFormProps {
  onCreated: (created: ClassRoom) => void;
  onCancel: () => void;
}

export function CreateClassForm({ onCreated, onCancel }: CreateClassFormProps) {
  const createClass = useCreateClass();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CreateClassValues>({
    resolver: zodResolver(createClassSchema),
    defaultValues: { name: '', academic_year: '', grade_level: '' },
  });

  const serverError = createClass.error instanceof ApiRequestError ? createClass.error : null;
  const generalError =
    serverError && Object.keys(serverError.errors).length === 0 ? serverError.message : null;

  const onSubmit = handleSubmit((values) => {
    createClass.mutate(
      { ...values, grade_level: values.grade_level || undefined },
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

            <div className="flex flex-col gap-1.5 sm:col-span-2">
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

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="grade_level">Grade level</Label>
              <Input
                id="grade_level"
                placeholder="Grade 12"
                aria-invalid={Boolean(serverError?.fieldError('grade_level'))}
                {...register('grade_level')}
              />
              <FieldError message={serverError?.fieldError('grade_level')} />
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
  return message ? <p className="text-sm text-red-600">{message}</p> : null;
}

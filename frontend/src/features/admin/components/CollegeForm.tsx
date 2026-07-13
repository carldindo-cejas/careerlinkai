import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useCreateCollege } from '@/features/admin/hooks/useCatalog';
import { ApiRequestError } from '@/types/api';
import type { College } from '@/types/catalog';

/**
 * Add a college (FULLPLAN §57, Phase 2).
 *
 * No status field: a new college is always active, and archiving one is a separate,
 * deliberate act rather than something you pick while typing its name.
 */

const collegeSchema = z.object({
  name: z.string().min(1, 'Give the college its full name.').max(200),
  description: z.string().max(2000).optional(),
});

type CollegeValues = z.infer<typeof collegeSchema>;

export interface CollegeFormProps {
  onCreated: (created: College) => void;
  onCancel: () => void;
}

export function CollegeForm({ onCreated, onCancel }: CollegeFormProps) {
  const createCollege = useCreateCollege();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CollegeValues>({
    resolver: zodResolver(collegeSchema),
    defaultValues: { name: '', description: '' },
  });

  const serverError = createCollege.error instanceof ApiRequestError ? createCollege.error : null;
  const generalError =
    serverError && Object.keys(serverError.errors).length === 0 ? serverError.message : null;

  const onSubmit = handleSubmit((values) => {
    createCollege.mutate(
      { name: values.name, description: values.description || undefined },
      { onSuccess: onCreated },
    );
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a college</CardTitle>
        <CardDescription>
          A real institution students might apply to. Its programs are added on the college's
          own page.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {generalError ? <Alert>{generalError}</Alert> : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="college-name">Name</Label>
            <Input
              id="college-name"
              autoFocus
              placeholder="University of Santo Tomas"
              aria-invalid={Boolean(errors.name ?? serverError?.fieldError('name'))}
              {...register('name')}
            />
            {/*
              The duplicate-name 422 lands here. It is the whole reason colleges stopped
              being free text on `programs` (§13.3) — two spellings of one institution is
              exactly the drift the table exists to prevent.
            */}
            <FieldError message={errors.name?.message ?? serverError?.fieldError('name')} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="college-description">Description</Label>
            <Textarea
              id="college-description"
              rows={2}
              placeholder="Optional — a line about the institution."
              {...register('description')}
            />
            <FieldError message={serverError?.fieldError('description')} />
          </div>

          <div className="flex gap-2">
            <Button type="submit" loading={createCollege.isPending}>
              {createCollege.isPending ? 'Adding…' : 'Add college'}
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

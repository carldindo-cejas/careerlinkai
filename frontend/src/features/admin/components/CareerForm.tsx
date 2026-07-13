import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useCreateCareer, useUpdateCareer } from '@/features/admin/hooks/useCatalog';
import { ApiRequestError } from '@/types/api';
import { describeHollandCode, RIASEC_LETTERS, RIASEC_NAMES, type Career } from '@/types/catalog';

/**
 * Add or edit a career (FULLPLAN §57, Phase 2).
 *
 * The Holland code is the field that matters. §27 reads it positionally — the first letter
 * is weighted 0.5, the second 0.3, the third 0.2 — so the *order* is part of the data, not
 * a formatting choice, and the form says so.
 */

/**
 * The same three constraints the server's HollandCode rule enforces, checked here so the
 * admin finds out while typing rather than on submit. The server is still the authority:
 * this is a convenience, not the guarantee.
 */
const hollandCode = z
  .string()
  .trim()
  .toUpperCase()
  .max(3, 'At most 3 letters — the engine weights only the first three.')
  .regex(/^[RIASEC]*$/, 'Only the RIASEC letters R, I, A, S, E and C.')
  .refine(
    (code) => new Set(code).size === code.length,
    'A letter cannot appear twice — it would count double.',
  );

const careerSchema = z.object({
  title: z.string().min(1, 'Give the career a title.').max(150),
  description: z.string().max(2000).optional(),
  salary_range: z.string().max(100).optional(),
  employment_outlook: z.string().max(100).optional(),
  typical_riasec_code: hollandCode,
});

type CareerValues = z.infer<typeof careerSchema>;

export interface CareerFormProps {
  career?: Career;
  onSaved: () => void;
  onCancel: () => void;
}

export function CareerForm({ career, onSaved, onCancel }: CareerFormProps) {
  const isEditing = Boolean(career);

  const createCareer = useCreateCareer();
  const updateCareer = useUpdateCareer();
  const mutation = isEditing ? updateCareer : createCareer;

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<CareerValues>({
    resolver: zodResolver(careerSchema),
    defaultValues: {
      title: career?.title ?? '',
      description: career?.description ?? '',
      salary_range: career?.salary_range ?? '',
      employment_outlook: career?.employment_outlook ?? '',
      typical_riasec_code: career?.typical_riasec_code ?? '',
    },
  });

  const code = watch('typical_riasec_code');
  const codeMeaning = describeHollandCode((code ?? '').toUpperCase());

  const serverError = mutation.error instanceof ApiRequestError ? mutation.error : null;
  const generalError =
    serverError && Object.keys(serverError.errors).length === 0 ? serverError.message : null;

  const onSubmit = handleSubmit((values) => {
    const payload = {
      title: values.title,
      description: values.description || undefined,
      salary_range: values.salary_range || undefined,
      employment_outlook: values.employment_outlook || undefined,
      // An empty box means "no Holland code", which is a valid career — it just cannot be
      // RIASEC-matched. That is null, not "".
      typical_riasec_code: values.typical_riasec_code || null,
    };

    if (career) {
      updateCareer.mutate({ id: career.id, payload }, { onSuccess: onSaved });
    } else {
      createCareer.mutate(payload, { onSuccess: onSaved });
    }
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{isEditing ? `Edit ${career?.title}` : 'Add a career'}</CardTitle>
        <CardDescription>
          The RIASEC code is what lets a student be matched to this career. Order matters —
          the first letter counts for most.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {generalError ? <Alert>{generalError}</Alert> : null}

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="career-title">Title</Label>
              <Input
                id="career-title"
                autoFocus
                placeholder="Software Engineer"
                aria-invalid={Boolean(errors.title ?? serverError?.fieldError('title'))}
                {...register('title')}
              />
              <FieldError message={errors.title?.message ?? serverError?.fieldError('title')} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="career-riasec">RIASEC code</Label>
              <Input
                id="career-riasec"
                placeholder="IEC"
                maxLength={3}
                className="font-mono uppercase tracking-widest"
                aria-invalid={Boolean(
                  errors.typical_riasec_code ?? serverError?.fieldError('typical_riasec_code'),
                )}
                aria-describedby="career-riasec-help"
                {...register('typical_riasec_code')}
              />
              <FieldError
                message={
                  errors.typical_riasec_code?.message ??
                  serverError?.fieldError('typical_riasec_code')
                }
              />
              {/* Echo the code back in words. "IEC" is opaque; "Investigative · Enterprising
                  · Conventional" is checkable by someone who knows the career. */}
              <p id="career-riasec-help" className="text-xs text-slate-500">
                {codeMeaning ?? 'Optional — leave blank if the career has no Holland code.'}
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="career-salary">Salary range</Label>
              <Input
                id="career-salary"
                placeholder="PHP 40,000 - 120,000/mo"
                {...register('salary_range')}
              />
              <FieldError message={serverError?.fieldError('salary_range')} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="career-outlook">Employment outlook</Label>
              <Input id="career-outlook" placeholder="High demand" {...register('employment_outlook')} />
              <FieldError message={serverError?.fieldError('employment_outlook')} />
            </div>

            <div className="flex flex-col gap-1.5 sm:col-span-3">
              <Label htmlFor="career-description">Description</Label>
              <Textarea id="career-description" rows={2} {...register('description')} />
              <FieldError message={serverError?.fieldError('description')} />
            </div>
          </div>

          <RiasecLegend />

          <div className="flex gap-2">
            <Button type="submit" loading={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : isEditing ? 'Save career' : 'Add career'}
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

/** Nobody remembers all six letters. Showing them costs one line and saves a lookup. */
function RiasecLegend() {
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
      {RIASEC_LETTERS.map((letter) => (
        <div key={letter} className="flex gap-1">
          <dt className="font-mono font-semibold text-slate-800">{letter}</dt>
          <dd>{RIASEC_NAMES[letter]}</dd>
        </div>
      ))}
    </dl>
  );
}

function FieldError({ message }: { message?: string | undefined }) {
  return message ? <p className="text-sm text-red-600">{message}</p> : null;
}

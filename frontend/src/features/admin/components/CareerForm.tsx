import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useCreateCareer, useEmploymentOutlooks, useUpdateCareer } from '@/features/admin/hooks/useCatalog';
import { ApiRequestError } from '@/types/api';
import {
  describeHollandCode,
  formatThousands,
  RIASEC_LETTERS,
  RIASEC_NAMES,
  type Career,
} from '@/types/catalog';

/**
 * Add or edit a career (FULLPLAN §57, Phase 2; numeric salary + outlook FK, backend migration 0013).
 *
 * The Holland code is the field that matters for matching. §27 reads it positionally — the first
 * letter is weighted 0.5, the second 0.3, the third 0.2 — so the *order* is part of the data.
 *
 * Salary is two raw numbers, formatted with thousands separators as the admin types (`40000` shows
 * as `40,000`) but sent as plain integers; the employment outlook is a dropdown backed by the
 * seeded lookup, not free text.
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
  typical_riasec_code: hollandCode,
});

type CareerValues = z.infer<typeof careerSchema>;

/** `"40,000"` / `"40000"` → `40000`; an empty or all-separator string → null. */
function parseAmount(display: string): number | null {
  const digits = display.replace(/[^\d]/g, '');

  return digits.length === 0 ? null : Number(digits);
}

/** Re-format a raw entry with thousands separators, preserving an empty box as empty. */
function formatAmount(display: string): string {
  const amount = parseAmount(display);

  return amount === null ? '' : formatThousands(amount);
}

export interface CareerFormProps {
  career?: Career;
  onSaved: () => void;
  onCancel: () => void;
}

export function CareerForm({ career, onSaved, onCancel }: CareerFormProps) {
  const isEditing = Boolean(career);

  const createCareer = useCreateCareer();
  const updateCareer = useUpdateCareer();
  const outlooks = useEmploymentOutlooks();
  const mutation = isEditing ? updateCareer : createCareer;

  const [salaryMin, setSalaryMin] = useState(
    career?.salary_min != null ? formatThousands(career.salary_min) : '',
  );
  const [salaryMax, setSalaryMax] = useState(
    career?.salary_max != null ? formatThousands(career.salary_max) : '',
  );
  const [outlookId, setOutlookId] = useState(career?.employment_outlook_id ?? '');

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
      typical_riasec_code: career?.typical_riasec_code ?? '',
    },
  });

  const code = watch('typical_riasec_code');
  const codeMeaning = describeHollandCode((code ?? '').toUpperCase());

  const minValue = parseAmount(salaryMin);
  const maxValue = parseAmount(salaryMax);

  // The same two rules the server enforces (§17), checked here so the admin sees them while typing.
  const salaryError =
    (minValue === null) !== (maxValue === null)
      ? 'Enter both a minimum and a maximum salary, or leave both blank.'
      : minValue !== null && maxValue !== null && minValue >= maxValue
        ? 'Maximum salary must be greater than the minimum.'
        : null;

  const serverError = mutation.error instanceof ApiRequestError ? mutation.error : null;
  const generalError =
    serverError && Object.keys(serverError.errors).length === 0 ? serverError.message : null;

  const onSubmit = handleSubmit((values) => {
    if (salaryError) return;

    const payload = {
      title: values.title,
      description: values.description || undefined,
      salary_min: minValue,
      salary_max: maxValue,
      employment_outlook_id: outlookId === '' ? null : outlookId,
      // An empty box means "no Holland code" — a valid career that just cannot be RIASEC-matched.
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
              <p id="career-riasec-help" className="text-xs text-muted-foreground">
                {codeMeaning ?? 'Optional — leave blank if the career has no Holland code.'}
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="career-salary-min">Minimum salary (₱ / mo)</Label>
              <Input
                id="career-salary-min"
                inputMode="numeric"
                placeholder="40,000"
                value={salaryMin}
                onChange={(event) => setSalaryMin(formatAmount(event.target.value))}
                aria-invalid={Boolean(salaryError ?? serverError?.fieldError('salary_min'))}
              />
              <FieldError message={serverError?.fieldError('salary_min')} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="career-salary-max">Maximum salary (₱ / mo)</Label>
              <Input
                id="career-salary-max"
                inputMode="numeric"
                placeholder="120,000"
                value={salaryMax}
                onChange={(event) => setSalaryMax(formatAmount(event.target.value))}
                aria-invalid={Boolean(salaryError ?? serverError?.fieldError('salary_max'))}
              />
              <FieldError message={serverError?.fieldError('salary_max')} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="career-outlook">Employment outlook</Label>
              <Select
                id="career-outlook"
                value={outlookId}
                disabled={outlooks.isPending}
                onChange={(event) => setOutlookId(event.target.value)}
                aria-invalid={Boolean(serverError?.fieldError('employment_outlook_id'))}
              >
                <option value="">
                  {outlooks.isPending ? 'Loading…' : 'No outlook'}
                </option>
                {(outlooks.data ?? []).map((outlook) => (
                  <option key={outlook.id} value={outlook.id}>
                    {outlook.name}
                  </option>
                ))}
              </Select>
              <FieldError message={serverError?.fieldError('employment_outlook_id')} />
            </div>

            {salaryError ? (
              <p className="text-sm text-destructive sm:col-span-3">{salaryError}</p>
            ) : null}

            <div className="flex flex-col gap-1.5 sm:col-span-3">
              <Label htmlFor="career-description">Description</Label>
              <Textarea id="career-description" rows={2} {...register('description')} />
              <FieldError message={serverError?.fieldError('description')} />
            </div>
          </div>

          <RiasecLegend />

          <div className="flex gap-2">
            <Button type="submit" loading={mutation.isPending} disabled={Boolean(salaryError)}>
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
    <dl className="flex flex-wrap gap-x-4 gap-y-1 rounded-none bg-muted px-3 py-2 text-xs text-muted-foreground">
      {RIASEC_LETTERS.map((letter) => (
        <div key={letter} className="flex gap-1">
          <dt className="font-mono font-semibold text-foreground">{letter}</dt>
          <dd>{RIASEC_NAMES[letter]}</dd>
        </div>
      ))}
    </dl>
  );
}

function FieldError({ message }: { message?: string | undefined }) {
  return message ? <p className="text-sm text-destructive">{message}</p> : null;
}

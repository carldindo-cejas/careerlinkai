import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { AddressCascade, emptyAddress, type AddressValue } from '@/features/admin/components/AddressCascade';
import { useCreateCollege } from '@/features/admin/hooks/useCatalog';
import { isGoogleMapsUrl } from '@/lib/googleMaps';
import { ApiRequestError } from '@/types/api';
import type { College } from '@/types/catalog';

/**
 * Add a college (FULLPLAN §57, Phase 2; school address + map link, backend migrations 0012).
 *
 * No status field: a new college is always active, and archiving one is a separate,
 * deliberate act rather than something you pick while typing its name.
 */

const collegeSchema = z.object({
  name: z.string().min(1, 'Give the college its full name.').max(200),
  description: z.string().max(2000).optional(),
  // Checked here for a quick "that isn't a maps link" while typing; the server is the authority.
  map_link: z
    .string()
    .trim()
    .max(2000)
    .refine((value) => value.length === 0 || isGoogleMapsUrl(value), {
      message: 'Enter a valid Google Maps link (e.g. https://maps.app.goo.gl/…).',
    })
    .optional(),
});

type CollegeValues = z.infer<typeof collegeSchema>;

export interface CollegeFormProps {
  onCreated: (created: College) => void;
  onCancel: () => void;
}

export function CollegeForm({ onCreated, onCancel }: CollegeFormProps) {
  const createCollege = useCreateCollege();
  const [address, setAddress] = useState<AddressValue>(emptyAddress);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CollegeValues>({
    resolver: zodResolver(collegeSchema),
    defaultValues: { name: '', description: '', map_link: '' },
  });

  const serverError = createCollege.error instanceof ApiRequestError ? createCollege.error : null;
  const generalError =
    serverError && Object.keys(serverError.errors).length === 0 ? serverError.message : null;

  const addressErrors = {
    region_id: serverError?.fieldError('region_id'),
    province_id: serverError?.fieldError('province_id'),
    town_id: serverError?.fieldError('town_id'),
    barangay_id: serverError?.fieldError('barangay_id'),
  };

  const onSubmit = handleSubmit((values) => {
    createCollege.mutate(
      {
        name: values.name,
        description: values.description || undefined,
        map_link: values.map_link ? values.map_link : null,
        region_id: address.region_id,
        province_id: address.province_id,
        town_id: address.town_id,
        barangay_id: address.barangay_id,
      },
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

          <fieldset className="flex flex-col gap-3 border-t border-border pt-4">
            <legend className="text-sm font-medium text-foreground">School address</legend>
            <p className="-mt-1 text-xs text-muted-foreground">
              Optional, but the four levels cascade — pick a region to unlock its provinces, and so
              on down to the barangay.
            </p>
            <AddressCascade value={address} onChange={setAddress} errors={addressErrors} />
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="college-map">School map link</Label>
            <Input
              id="college-map"
              placeholder="https://maps.app.goo.gl/…"
              aria-invalid={Boolean(errors.map_link ?? serverError?.fieldError('map_link'))}
              {...register('map_link')}
            />
            <p className="text-xs text-muted-foreground">
              Paste a Google Maps link for the campus — students see a “View on Google Maps” button
              on the college page.
            </p>
            <FieldError message={errors.map_link?.message ?? serverError?.fieldError('map_link')} />
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
  return message ? <p className="text-sm text-destructive">{message}</p> : null;
}

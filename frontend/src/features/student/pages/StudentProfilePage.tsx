import { type FormEvent, useEffect, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useProfile, useUpdateProfile } from '@/features/student/hooks/useAssessment';
import type { UpdateProfilePayload } from '@/types/assessment';
import type { Strand } from '@/types/catalog';

/**
 * Profile completion (FULLPLAN §37: *"grade, GWA, subject grades, strand — 2-option selector"*).
 *
 * **This is not a settings screen. It is an input form for the recommendation engine.**
 *
 * §57 moved it into Phase 3 for exactly that reason — *"Phase 4's engine consumes these fields and
 * no phase previously owned them."* §27 reads `strand` and `gwa` to compute strand alignment and
 * academic fit, so a blank field here is not an incomplete profile, it is a missing input. The
 * copy on this page says so, because a student who understands why they are being asked is a
 * student who answers accurately.
 */
export function StudentProfilePage() {
  const { data: profile, isLoading, isError, error } = useProfile();
  const update = useUpdateProfile();

  const [form, setForm] = useState<UpdateProfilePayload>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!profile) return;

    setForm({
      grade_level: profile.grade_level,
      strand: profile.strand,
      gwa: profile.gwa === null ? null : Number(profile.gwa),
      math_grade: profile.math_grade === null ? null : Number(profile.math_grade),
      science_grade: profile.science_grade === null ? null : Number(profile.science_grade),
      english_grade: profile.english_grade === null ? null : Number(profile.english_grade),
    });
  }, [profile]);

  if (isLoading) return <p className="text-sm text-slate-500">Loading your profile…</p>;

  /*
    D11. Rendering the form with empty fields when the profile failed to load is worse here than on
    the other screens: the student would not merely be misinformed, they would fill it in again and
    submit — and a form that silently discards what it could not read is a data-loss bug wearing a
    UI. Refuse to show the form at all rather than show an empty one.
  */
  if (isError) {
    return (
      <Alert>
        We could not load your profile. {error.message} Refresh to try again — do not re-enter it
        here, in case what you already saved is still there.
      </Alert>
    );
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    update.mutate(form, { onSuccess: () => setSaved(true) });
  }

  // The server's field-level 422s, rendered against the field that caused them. A GWA of "9.2" is
  // the single most likely mistake on this form (it is how grades are written in other countries),
  // and it must not be silently accepted — §27 would *score* it rather than reject it.
  const errors = (update.error as { response?: { data?: { errors?: Record<string, string[]> } } })
    ?.response?.data?.errors;

  return (
    <form className="flex max-w-2xl flex-col gap-6" onSubmit={onSubmit}>
      <div>
        <h1 className="text-xl font-semibold text-slate-900">My profile</h1>
        <p className="text-sm text-slate-500">
          Your assessment results do not depend on any of this. Your{' '}
          <span className="font-medium">program recommendations do</span> — we match programs
          against your strand and your grades, so a blank field here means a recommendation we
          cannot make.
        </p>
      </div>

      {saved ? <Alert tone="success">Profile saved.</Alert> : null}

      <Card>
        <CardHeader>
          <CardTitle>Academic track</CardTitle>
          <CardDescription>
            Your strand is the single most important field on this page — it decides which programs
            are a fit for you at all.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="strand">Strand</Label>
            {/*
              Exactly two options (§13.1, v1.2). "STEM", "HUMSS" and "ABM" are *tracks* within the
              Academic strand and are deliberately not offered: the plan collapsed strand to a
              strict two-value enum, and §27 is built on exactly two branches. Offering four here
              and mapping them down would be a lie about what the engine can tell apart.
            */}
            <Select
              id="strand"
              value={form.strand ?? ''}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  // `null`, never `undefined`. Under `exactOptionalPropertyTypes` the two are
                  // genuinely different here, and so they are on the wire: NULL clears the strand,
                  // while an absent key leaves it alone (the endpoint is a PATCH). "Not selected"
                  // has to mean the former.
                  strand: e.target.value === '' ? null : (e.target.value as Strand),
                }))
              }
            >
              <option value="">Not selected</option>
              <option value="Academic">Academic (STEM, HUMSS, ABM, GAS)</option>
              <option value="Technical-Professional">
                Technical-Professional (TVL, Sports, Arts &amp; Design)
              </option>
            </Select>
            {errors?.strand ? <p className="text-sm text-red-600">{errors.strand[0]}</p> : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="grade_level">Grade level</Label>
            <Select
              id="grade_level"
              value={form.grade_level ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, grade_level: e.target.value || null }))}
            >
              <option value="">Not selected</option>
              <option value="Grade 11">Grade 11</option>
              <option value="Grade 12">Grade 12</option>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Grades</CardTitle>
          <CardDescription>
            Philippine senior-high grades, from 60 to 100. Leave a field blank if you are not sure —
            a guess is worse than a gap.
          </CardDescription>
        </CardHeader>

        <CardContent className="grid gap-4 sm:grid-cols-2">
          <GradeField
            id="gwa"
            label="General weighted average"
            value={form.gwa}
            error={errors?.gwa?.[0]}
            onChange={(v) => setForm((f) => ({ ...f, gwa: v }))}
          />
          <GradeField
            id="math_grade"
            label="Mathematics"
            value={form.math_grade}
            error={errors?.math_grade?.[0]}
            onChange={(v) => setForm((f) => ({ ...f, math_grade: v }))}
          />
          <GradeField
            id="science_grade"
            label="Science"
            value={form.science_grade}
            error={errors?.science_grade?.[0]}
            onChange={(v) => setForm((f) => ({ ...f, science_grade: v }))}
          />
          <GradeField
            id="english_grade"
            label="English"
            value={form.english_grade}
            error={errors?.english_grade?.[0]}
            onChange={(v) => setForm((f) => ({ ...f, english_grade: v }))}
          />
        </CardContent>
      </Card>

      <div>
        <Button type="submit" disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save profile'}
        </Button>
      </div>
    </form>
  );
}

function GradeField({
  id,
  label,
  value,
  error,
  onChange,
}: {
  id: string;
  label: string;
  value: number | null | undefined;
  error: string | undefined;
  onChange: (value: number | null) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={60}
        max={100}
        step="0.01"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </div>
  );
}

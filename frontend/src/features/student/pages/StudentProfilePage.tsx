import { Info, Lock } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  useProfile,
  useProfileOptions,
  useUpdateProfile,
} from '@/features/student/hooks/useAssessment';
import { toast } from '@/stores/toastStore';
import type { StudentProfile, UpdateProfilePayload } from '@/types/assessment';

/**
 * Profile completion (FULLPLAN §37: *"grade, subject grades, strand — 2-option selector"*).
 *
 * **This is not a settings screen. It is an input form for the recommendation engine.**
 *
 * §57 moved it into Phase 3 for exactly that reason — *"Phase 4's engine consumes these fields and
 * no phase previously owned them."* §27 reads `strand` and the subject-grade average to compute
 * strand alignment and academic fit, so a blank field here is not an incomplete profile, it is a
 * missing input. The copy on this page says so, because a student who understands why they are
 * being asked is a student who answers accurately.
 *
 * ## Two changes on 2026-07-27
 *
 * **The GWA field is gone.** §27's academic components now read the mean of whichever of Maths,
 * Science and English the student filled in. That is one fewer number to ask for, and a more
 * honest one: a student always knows their subject grades, and the GWA they typed was often a
 * remembered approximation of a figure the school already holds.
 *
 * **Grade level and strand are no longer typed.** They are lookups (migration 0017) derived from
 * the class the counselor enrolled the student in. Where a class supplies one, the select is
 * read-only and names the class — because the server refuses the edit with a 422, and a form that
 * offered the control anyway would be offering a button whose submission always fails.
 *
 * ## The name became editable on 2026-09-20 (prompt-driven)
 *
 * It was read-only, on the grounds that the roster owned it. But the roster is where a name is
 * first *typed*, by a counselor working down a class list — which is exactly where a misspelling,
 * a maiden name or a nickname enters the system, and the student is the only person who can say
 * it is wrong. It matters more than a settings field usually would because this name is printed
 * onto the exported result report, which ends up in a guidance file.
 *
 * Two things the card has to say out loud, because both are the first question a student asks:
 *
 *   * **Their username does not change.** It is what they sign in with, the counselor identifies
 *     them by it, and the server never touches it.
 *   * **Their counselor is told.** This is not a change a student makes privately — the roster a
 *     counselor works from changes underneath them, so they get a notification naming the old
 *     name, the new one and the unchanged username. Saying so here is the difference between a
 *     student correcting a misspelling and a student discovering later that somebody was told.
 */
export function StudentProfilePage() {
  const { data: profile, isLoading, isError, error } = useProfile();
  const { data: options } = useProfileOptions();
  const update = useUpdateProfile();

  const [form, setForm] = useState<UpdateProfilePayload>({});

  useEffect(() => {
    if (!profile) return;

    setForm({
      first_name: profile.first_name,
      last_name: profile.last_name,
      grade_level_id: profile.grade_level_id,
      shs_strand_id: profile.shs_strand_id,
      math_grade: profile.math_grade === null ? null : Number(profile.math_grade),
      science_grade: profile.science_grade === null ? null : Number(profile.science_grade),
      english_grade: profile.english_grade === null ? null : Number(profile.english_grade),
    });
  }, [profile]);

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading your profile…</p>;

  /*
    D11. Rendering the form with empty fields when the profile failed to load is worse here than on
    the other screens: the student would not merely be misinformed, they would fill it in again and
    submit — and a form that silently discards what it could not read is a data-loss bug wearing a
    UI. Refuse to show the form at all rather than show an empty one.
  */
  if (isError || !profile) {
    return (
      <Alert>
        We could not load your profile. {error?.message} Refresh to try again — do not re-enter it
        here, in case what you already saved is still there.
      </Alert>
    );
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();

    /*
      A derived field is never sent, even though the server would refuse it anyway. Sending a value
      the server is going to reject would turn every save on a locked profile into a 422 the
      student cannot act on — the field is not theirs to change, so it is not theirs to submit.
    */
    const payload: UpdateProfilePayload = { ...form };

    if (profile?.derived.grade_level) delete payload.grade_level_id;
    if (profile?.derived.shs_strand) delete payload.shs_strand_id;

    /*
      The name is dropped from the payload unless it actually moved.

      The server already refuses to treat an unchanged name as a rename — it compares before
      deciding — so this is not what makes the notification correct. It is here because the form
      posts every field it renders, and sending a name on every grade edit would make the request
      claim something it does not mean. The one place that costs anything real is the audit log,
      which should record renames rather than saves.
    */
    if (profile && !nameChanged(profile, form)) {
      delete payload.first_name;
      delete payload.last_name;
    }

    /*
      A toast rather than the inline banner this screen used to show. The banner was permanent —
      it stayed on screen for the rest of the session, so a student who saved once could not tell
      a fresh save from the previous one. A field-level 422 still renders inline, next to the field
      that caused it, because that is where it has to be acted on.
    */
    update.mutate(payload, {
      onSuccess: () => toast.success('Profile saved.'),
      onError: (cause) =>
        toast.error(cause instanceof Error ? cause.message : 'Your profile could not be saved.'),
    });
  }

  // The server's field-level 422s, rendered against the field that caused them. A grade of "9.2"
  // is the single most likely mistake on this form (it is how grades are written in other
  // countries), and it must not be silently accepted — §27 would *score* it rather than reject it.
  const errors = (update.error as { response?: { data?: { errors?: Record<string, string[]> } } })
    ?.response?.data?.errors;

  const className = profile.derived.class_name;

  return (
    <form data-tour="profile-form" className="flex max-w-2xl flex-col gap-6" onSubmit={onSubmit}>
      <div>
        <h1 className="text-xl font-semibold text-foreground">My profile</h1>
        <p className="text-sm text-muted-foreground">
          Your assessment results do not depend on any of this. Your{' '}
          <span className="font-medium">program recommendations do</span> — we match programs
          against your strand and your grades, so a blank field here means a recommendation we
          cannot make.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Your name</CardTitle>
          <CardDescription>
            This is the name printed on your results when you export or print them. If it is
            spelled wrong, or it is not what you go by, change it here.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="first_name">First name</Label>
              <Input
                id="first_name"
                autoComplete="given-name"
                value={form.first_name ?? ''}
                aria-invalid={Boolean(errors?.first_name)}
                onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))}
              />
              {errors?.first_name ? (
                <p className="text-sm text-destructive">{errors.first_name[0]}</p>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="last_name">Last name</Label>
              <Input
                id="last_name"
                autoComplete="family-name"
                value={form.last_name ?? ''}
                aria-invalid={Boolean(errors?.last_name)}
                // `null`, not `''`, so clearing the field means "I have one name" on the wire
                // rather than "my last name is the empty string" (§13.1).
                onChange={(e) =>
                  setForm((f) => ({ ...f, last_name: e.target.value === '' ? null : e.target.value }))
                }
              />
              <p className="text-xs text-muted-foreground">
                Leave this blank if you go by one name.
              </p>
              {errors?.last_name ? (
                <p className="text-sm text-destructive">{errors.last_name[0]}</p>
              ) : null}
            </div>
          </div>

          {/*
            Both consequences, stated before the save rather than discovered after it. The
            username one prevents a student locking themselves out in their own head; the
            counselor one is the thing a student is entitled to know before they act.
          */}
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>
              Your username stays the same — you will still sign in the way you always have. Your
              guidance counselor is told when you change your name, so their class list matches
              yours.
            </span>
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Academic track</CardTitle>
          <CardDescription>
            Your strand is the single most important field on this page — it decides which programs
            are a fit for you at all.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          <div data-tour="profile-strand" className="flex flex-col gap-1.5">
            <Label htmlFor="strand">Strand</Label>
            {/*
              Exactly two options (§13.1, v1.2), now served from `shs_strands` rather than
              hard-coded here. "STEM", "HUMSS" and "ABM" are *tracks* within the Academic strand and
              are deliberately not offered: the plan collapsed strand to a strict two-value enum,
              and §27 is built on exactly two branches. Offering four here and mapping them down
              would be a lie about what the engine can tell apart.
            */}
            <Select
              id="strand"
              value={form.shs_strand_id ?? ''}
              disabled={profile.derived.shs_strand}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  // `null`, never `undefined`. Under `exactOptionalPropertyTypes` the two are
                  // genuinely different here, and so they are on the wire: NULL clears the strand,
                  // while an absent key leaves it alone (the endpoint is a PATCH). "Not selected"
                  // has to mean the former.
                  shs_strand_id: e.target.value === '' ? null : e.target.value,
                }))
              }
            >
              <option value="">Not selected</option>
              {(options?.shs_strands ?? []).map((strand) => (
                <option key={strand.id} value={strand.id}>
                  {strand.name}
                  {strand.description ? ` (${strand.description})` : null}
                </option>
              ))}
            </Select>
            <DerivedNote locked={profile.derived.shs_strand} className={className} />
            {errors?.shs_strand_id ? (
              <p className="text-sm text-destructive">{errors.shs_strand_id[0]}</p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="grade_level">Grade level</Label>
            <Select
              id="grade_level"
              value={form.grade_level_id ?? ''}
              disabled={profile.derived.grade_level}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  grade_level_id: e.target.value === '' ? null : e.target.value,
                }))
              }
            >
              <option value="">Not selected</option>
              {(options?.grade_levels ?? []).map((level) => (
                <option key={level.id} value={level.id}>
                  {level.name}
                </option>
              ))}
            </Select>
            <DerivedNote locked={profile.derived.grade_level} className={className} />
            {errors?.grade_level_id ? (
              <p className="text-sm text-destructive">{errors.grade_level_id[0]}</p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Grades</CardTitle>
          <CardDescription>
            Philippine senior-high grades, from 60 to 100. Leave a field blank if you are not sure —
            a guess is worse than a gap, and we average only the subjects you actually fill in.
          </CardDescription>
        </CardHeader>

        <CardContent data-tour="profile-grades" className="grid gap-4 sm:grid-cols-2">
          {/*
            The general weighted average was removed on 2026-07-27. §27's academic fit is computed
            from the mean of whichever of these three are present, so filling in even one is enough
            for the engine to have a real signal instead of a neutral. (The separate eligibility
            tier that also read this average was dropped from the program composite on 2026-09-18.)
          */}
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

      {update.isError && errors === undefined ? (
        <Alert tone="danger">
          {update.error instanceof Error ? update.error.message : 'Your profile could not be saved.'}
        </Alert>
      ) : null}

      <div>
        <Button type="submit" disabled={update.isPending} loading={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save profile'}
        </Button>
      </div>
    </form>
  );
}

/**
 * Whether what is in the form is a different name from what is on the profile.
 *
 * Both sides are trimmed, and a blank last name is compared as `null`, because that is what the
 * server stores: a student who adds a trailing space to their surname and saves has not renamed
 * themselves, and the notification their counselor would get says otherwise.
 */
function nameChanged(profile: StudentProfile, form: UpdateProfilePayload): boolean {
  const last = form.last_name?.trim() ? form.last_name.trim() : null;

  return (form.first_name ?? '').trim() !== profile.first_name || last !== profile.last_name;
}

/**
 * Why a field is read-only, in the student's terms and naming the person who can change it.
 *
 * A disabled control with no explanation reads as a bug. This is the difference between "the app
 * won't let me" and "my counselor set this, and I should tell them if it's wrong".
 */
function DerivedNote({ locked, className }: { locked: boolean; className: string | null }) {
  if (!locked) return null;

  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <Lock className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
      <span>
        Set by your class{className ? ` (${className})` : null}. Ask your guidance counselor if this
        is wrong.
      </span>
    </p>
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
        aria-invalid={Boolean(error)}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

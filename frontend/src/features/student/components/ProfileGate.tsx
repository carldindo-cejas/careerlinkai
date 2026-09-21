import { Lock } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  useProfile,
  useProfileOptions,
  useUpdateProfile,
} from '@/features/student/hooks/useAssessment';
import type { UpdateProfilePayload } from '@/types/assessment';

/**
 * The profile gate — a modal a student cannot walk around (prompt-driven, 2026-09-20).
 *
 * **It replaces the `ProfilingBanner` strip that used to sit under the top bar**, and the swap is
 * the point rather than a restyling. The banner stated the consequence honestly and was ignored
 * honestly: it rendered above the content column on every route, students scrolled past it, and
 * arrived at the end of both instruments with no strand and no grades on file — which is the one
 * state §27 cannot recommend a program out of. A warning that is easy not to act on, sitting on
 * the exact input the engine cannot run without, is a warning that has already failed.
 *
 * So the ask moved from the edge of the screen into the middle of it, over a blurred page, with
 * the fields themselves inside. Three properties, and each is a decision:
 *
 *   * **The fields are here, not one navigation away.** A gate whose only control is "go to my
 *     profile" is a banner with extra steps. The student answers the question where they were
 *     asked it, and the modal disappears on the save.
 *   * **It asks only for what is missing.** The server decides what that is
 *     (`profiling.missing`), so this cannot drift from the rule; a student who already has a
 *     strand is asked for grades alone.
 *   * **There is no way out — unless the way out is not the student's to take.** No close button,
 *     no Escape, no click-away. The single exception is a field the student's *class* supplies
 *     (`derived`): the server answers a student's edit to one of those with a 422, so gating on
 *     it would be an unanswerable question. When one of those is what is missing, the gate names
 *     who to ask and lets them past.
 *
 * It is not rendered over the assessment player. A student already answering questions with an
 * incomplete profile predates this gate, and locking them out of an attempt in progress would
 * cost them the attempt in order to collect a field their results do not depend on.
 */
export function ProfileGate() {
  const { data: profile } = useProfile();
  const { data: options } = useProfileOptions();
  const update = useUpdateProfile();
  const { pathname } = useLocation();

  const [form, setForm] = useState<UpdateProfilePayload>({});
  const [invalid, setInvalid] = useState<string | null>(null);
  /** Only reachable on a profile whose missing field belongs to the counselor — see the header. */
  const [waived, setWaived] = useState(false);

  useEffect(() => {
    if (!profile) return;

    setForm({
      grade_level_id: profile.grade_level_id,
      shs_strand_id: profile.shs_strand_id,
      math_grade: profile.math_grade === null ? null : Number(profile.math_grade),
      science_grade: profile.science_grade === null ? null : Number(profile.science_grade),
      english_grade: profile.english_grade === null ? null : Number(profile.english_grade),
    });
  }, [profile]);

  /*
    Nothing while the profile is unknown, and nothing when it failed to load — `data` is undefined
    in both cases. A gate raised on a dropped request would lock a student out of the entire app
    over a network blip, which is exactly why `StudentProfilePage` refuses to render its form in
    that state rather than rendering an empty one (D11).
  */
  if (profile === undefined || profile.profiling.is_complete || waived) return null;

  // Mid-attempt is the one place this must not appear.
  if (pathname.startsWith('/student/attempts/')) return null;

  const missing = new Set(profile.profiling.missing.map((field) => field.field));
  const needsStrand = missing.has('shs_strand_id') && !profile.derived.shs_strand;
  const needsGradeLevel = missing.has('grade_level_id') && !profile.derived.grade_level;
  const needsGrades = missing.has('subject_grades');

  // Missing *and* locked: the student cannot supply it, so they are not held for it.
  const strandLocked = missing.has('shs_strand_id') && profile.derived.shs_strand;
  const lockedOut =
    strandLocked || (missing.has('grade_level_id') && profile.derived.grade_level);

  const serverErrors = fieldErrors(update.error);

  function onSubmit(event: FormEvent) {
    event.preventDefault();

    const payload: UpdateProfilePayload = {};

    if (needsStrand) payload.shs_strand_id = form.shs_strand_id ?? null;
    if (needsGradeLevel) payload.grade_level_id = form.grade_level_id ?? null;

    if (needsGrades) {
      payload.math_grade = form.math_grade ?? null;
      payload.science_grade = form.science_grade ?? null;
      payload.english_grade = form.english_grade ?? null;
    }

    /*
      Checked here rather than left to the server, because the server's answer to "you sent
      nothing" is a 200: a PATCH of three nulls is a valid request that changes nothing, and the
      gate would simply still be there with no account of why the save did not count.
    */
    const problem = firstProblem({ payload, needsStrand, needsGradeLevel, needsGrades });

    if (problem) {
      setInvalid(problem);
      return;
    }

    setInvalid(null);
    update.mutate(payload);
  }

  return (
    <Dialog open>
      <DialogContent
        data-testid="profile-gate"
        title="Before you start"
        description={
          needsGrades
            ? 'We need your grades before we can match you with a program. This takes a minute.'
            : 'One thing is still missing from your profile. This takes a minute.'
        }
        hideClose={!lockedOut}
        // The page behind stays visible but plainly out of reach — the student can see the app
        // they are being held out of, which is the difference between a gate and a dead end.
        overlayClassName="bg-background/70 backdrop-blur-sm"
        // Escape and click-away are refused for the same reason the "X" is gone. Radix fires both
        // *before* it closes anything, so preventing the event is what keeps the modal open.
        {...(lockedOut
          ? {}
          : {
              onEscapeKeyDown: (event: Event) => event.preventDefault(),
              onInteractOutside: (event: Event) => event.preventDefault(),
            })}
        // 320px is the floor this has to work at, and the body already scrolls inside
        // `DialogContent` — so the modal never grows past the viewport no matter how many fields
        // turn out to be missing.
        className="max-w-md"
      >
        <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
          <p className="text-sm text-muted-foreground">
            None of this changes your assessment results. It is what we match{' '}
            <span className="font-medium text-foreground">programs</span> against — without it we
            cannot recommend one.
          </p>

          {lockedOut ? (
            <Alert tone="info">
              <span className="flex items-start gap-1.5">
                <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>
                  Your {strandLocked ? 'strand' : 'grade level'} is set by your class
                  {profile.derived.class_name ? ` (${profile.derived.class_name})` : null}, so only
                  your guidance counselor can fill it in. Ask them when you next see them.
                </span>
              </span>
            </Alert>
          ) : null}

          {needsStrand ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gate-strand">Strand</Label>
              <Select
                id="gate-strand"
                autoFocus
                value={form.shs_strand_id ?? ''}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    shs_strand_id: event.target.value === '' ? null : event.target.value,
                  }))
                }
              >
                <option value="">Choose your strand</option>
                {(options?.shs_strands ?? []).map((strand) => (
                  <option key={strand.id} value={strand.id}>
                    {strand.name}
                    {strand.description ? ` (${strand.description})` : null}
                  </option>
                ))}
              </Select>
              {serverErrors?.shs_strand_id ? (
                <p className="text-sm text-destructive">{serverErrors.shs_strand_id[0]}</p>
              ) : null}
            </div>
          ) : null}

          {needsGradeLevel ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gate-grade-level">Grade level</Label>
              <Select
                id="gate-grade-level"
                autoFocus={!needsStrand}
                value={form.grade_level_id ?? ''}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    grade_level_id: event.target.value === '' ? null : event.target.value,
                  }))
                }
              >
                <option value="">Choose your grade level</option>
                {(options?.grade_levels ?? []).map((level) => (
                  <option key={level.id} value={level.id}>
                    {level.name}
                  </option>
                ))}
              </Select>
              {serverErrors?.grade_level_id ? (
                <p className="text-sm text-destructive">{serverErrors.grade_level_id[0]}</p>
              ) : null}
            </div>
          ) : null}

          {needsGrades ? (
            <fieldset className="flex flex-col gap-3">
              <legend className="text-sm font-medium text-foreground">Your grades</legend>
              <p className="-mt-1 text-xs text-muted-foreground">
                From 60 to 100. Fill in the ones you know — we average only those, and a guess is
                worse than a gap.
              </p>
              {/*
                Two across from 380px, one column below it. Three number fields side by side at
                320px leaves each about 80px wide, which wraps every label onto two lines and puts
                the spinner arrows over the digits.
              */}
              <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2">
                <GateGrade
                  id="gate-math"
                  label="Mathematics"
                  value={form.math_grade}
                  error={serverErrors?.math_grade?.[0]}
                  autoFocus={!needsStrand && !needsGradeLevel}
                  onChange={(value) => setForm((current) => ({ ...current, math_grade: value }))}
                />
                <GateGrade
                  id="gate-science"
                  label="Science"
                  value={form.science_grade}
                  error={serverErrors?.science_grade?.[0]}
                  onChange={(value) => setForm((current) => ({ ...current, science_grade: value }))}
                />
                <GateGrade
                  id="gate-english"
                  label="English"
                  value={form.english_grade}
                  error={serverErrors?.english_grade?.[0]}
                  onChange={(value) => setForm((current) => ({ ...current, english_grade: value }))}
                />
              </div>
            </fieldset>
          ) : null}

          {invalid ? <Alert tone="warning">{invalid}</Alert> : null}

          {update.isError && serverErrors === undefined ? (
            <Alert>
              {update.error instanceof Error
                ? update.error.message
                : 'That could not be saved. Try again.'}
            </Alert>
          ) : null}

          {/*
            Column-reversed under `sm`, so the primary action is the one under the thumb and the
            escape hatch — when there is one at all — sits below it rather than beside it.
          */}
          <div className="flex flex-col-reverse gap-2 sm:flex-row-reverse sm:items-center">
            <Button type="submit" className="sm:flex-1" loading={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save and continue'}
            </Button>
            {lockedOut ? (
              <Button type="button" variant="secondary" onClick={() => setWaived(true)}>
                Continue without it
              </Button>
            ) : null}
          </div>

          <p className="text-xs text-muted-foreground">
            You can change any of this later on{' '}
            <span className="font-medium text-foreground">My profile</span>.
          </p>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The first reason this save would not clear the gate, in the student's words — or null.
 *
 * Range is checked as well as presence: `9.2` is how a grade is written in other countries and is
 * the likeliest mistake on this form. The server rejects it with a 422, but a student who has to
 * submit to find that out has been told off rather than helped.
 */
function firstProblem({
  payload,
  needsStrand,
  needsGradeLevel,
  needsGrades,
}: {
  payload: UpdateProfilePayload;
  needsStrand: boolean;
  needsGradeLevel: boolean;
  needsGrades: boolean;
}): string | null {
  if (needsStrand && !payload.shs_strand_id) return 'Choose your strand to continue.';
  if (needsGradeLevel && !payload.grade_level_id) return 'Choose your grade level to continue.';

  if (needsGrades) {
    const grades = [payload.math_grade, payload.science_grade, payload.english_grade];

    if (grades.every((grade) => grade === null || grade === undefined)) {
      return 'Fill in at least one grade to continue.';
    }

    if (grades.some((grade) => typeof grade === 'number' && (grade < 60 || grade > 100))) {
      return 'Grades run from 60 to 100 — check what you typed.';
    }
  }

  return null;
}

/** The server's field-level 422s, or undefined when the failure was not one. */
function fieldErrors(error: unknown): Record<string, string[]> | undefined {
  return (error as { response?: { data?: { errors?: Record<string, string[]> } } } | null)?.response
    ?.data?.errors;
}

function GateGrade({
  id,
  label,
  value,
  error,
  autoFocus,
  onChange,
}: {
  id: string;
  label: string;
  value: number | null | undefined;
  error: string | undefined;
  autoFocus?: boolean | undefined;
  onChange: (value: number | null) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        // `decimal` rather than `numeric`: a Philippine SHS grade is written 88.5, and the numeric
        // keypad on iOS has no decimal point.
        inputMode="decimal"
        min={60}
        max={100}
        step="0.01"
        autoFocus={autoFocus ?? false}
        value={value ?? ''}
        aria-invalid={Boolean(error)}
        onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}
      />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

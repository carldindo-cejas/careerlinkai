import { Loader2, RotateCcw, Scale } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/components/ui/cn';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  useResetScoringFormula,
  useSaveScoringFormula,
  useScoringFormula,
} from '@/features/admin/hooks/usePlatformAdmin';
import { ApiRequestError } from '@/types/api';
import type { ScoringFormula, ScoringFormulaResponse } from '@/types/formula';

/**
 * **The match formula** (2026-09-21) — how a student's results become a ranked list of careers and
 * college programs.
 *
 * Every number on this screen used to be a constant in the Worker, changeable only by an engineer
 * with a deploy. "How much should SCCT confidence count against RIASEC interests?" is not an
 * engineering question, though — it is a guidance question, and the people qualified to answer it
 * had no way to.
 *
 * ## What the screen is careful about
 *
 * **The weights in a composite are a share of one score, so they must add to 100%.** A set that
 * sums to 90 does not make matches gentler; it rescales every score in the system against a
 * "out of 100" label that is now a lie. So the total is shown for every set, the Save button will
 * not fire while one is wrong, and "Balance to 100%" rescales a set proportionally rather than
 * leaving an administrator to do arithmetic in their head.
 *
 * **A change is not retroactive, and the screen says so with a number.** Saving re-weights every
 * score computed from then on; the students who already have a set keep the scores they were given
 * until somebody rebuilds them. The header states how many students that currently is, because the
 * alternative is finding out from a counselor whose two students' scores are not comparable.
 *
 * **What shipped is always visible.** The defaults arrive with every read rather than being copied
 * into this app, and each field that differs from them is marked, so "what did we change?" is a
 * glance rather than an archaeology exercise through the audit log.
 */
export function ScoringFormulaPage() {
  const query = useScoringFormula();

  if (query.isPending) {
    return (
      <div className="flex justify-center py-12" role="status">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">Loading the formula…</span>
      </div>
    );
  }

  if (query.isError) {
    return <Alert>{query.error.message}</Alert>;
  }

  /*
    Keyed on the server's own provenance, so a formula changed in another tab — or by the save and
    reset below — re-seeds the editor instead of leaving a stale draft on screen that a later Save
    would write back over the change.
  */
  return <FormulaEditor key={query.data.updated_at ?? 'default'} data={query.data} />;
}

function FormulaEditor({ data }: { data: ScoringFormulaResponse }) {
  const save = useSaveScoringFormula();
  const reset = useResetScoringFormula();

  const [draft, setDraft] = useState<ScoringFormula>(data.formula);
  /*
    Bumped whenever the draft is replaced wholesale rather than edited field by field — a discard,
    or a "Balance to 100%". The number is part of every field's `key`, so those fields re-seed their
    own text from the new value. Without it a field showing "45" that the balance button just turned
    into 42.9 would go on showing "45" until it was next focused.
  */
  const [revision, setRevision] = useState(0);
  const [confirming, setConfirming] = useState<'save' | 'reset' | null>(null);

  const problems = useMemo(() => validate(draft), [draft]);
  const changed = JSON.stringify(draft) !== JSON.stringify(data.formula);
  const activeMutation = confirming === 'reset' ? reset : save;

  function openConfirm(action: 'save' | 'reset') {
    save.reset();
    reset.reset();
    setConfirming(action);
  }

  function closeConfirm() {
    setConfirming(null);
    save.reset();
    reset.reset();
  }

  // Every card's button saves the whole formula — the server only accepts it complete.
  const saveAction = (
    <Button
      size="sm"
      disabled={problems.length > 0 || !changed}
      onClick={() => openConfirm('save')}
      className="w-full sm:w-auto"
    >
      Save formula
    </Button>
  );

  function onConfirm(currentPassword: string) {
    const onSuccess = () => setConfirming(null);

    if (confirming === 'reset') {
      reset.mutate(currentPassword, { onSuccess });
    } else {
      save.mutate({ formula: draft, currentPassword }, { onSuccess });
    }
  }

  function replace(next: ScoringFormula) {
    setDraft(next);
    setRevision((current) => current + 1);
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-foreground">Recommendation formula</h1>
          <Badge tone={data.is_default ? 'neutral' : 'accent'}>
            {data.is_default ? 'Shipped defaults' : 'Customised'}
          </Badge>
        </div>

        <p className="max-w-3xl text-sm text-muted-foreground">
          How a student's RIASEC and SCCT results turn into a score for every career and every
          college program. Each score is arithmetic over the components below — the same answers
          always produce the same ranking — so these weights decide what the whole platform
          recommends.
        </p>

        {!data.is_default && data.updated_by_name ? (
          <p className="text-sm text-muted-foreground">
            Last changed by {data.updated_by_name}
            {data.updated_at ? ` on ${new Date(data.updated_at).toLocaleDateString()}` : null}.
          </p>
        ) : null}

        {/*
          The honest caveat, stated before anything is changed rather than after. Saving does not
          rewrite scores that already exist — see the file header.
        */}
        <Alert>
          A saved formula applies to every recommendation generated from now on. It does not rewrite
          scores students already have:{' '}
          <strong>
            {data.students_with_recommendations === 1
              ? '1 student is'
              : `${data.students_with_recommendations} students are`}
          </strong>{' '}
          currently holding a set computed under the weights in force when they finished their
          assessments. Those catch up when their recommendations are rebuilt — from the student's own
          results page, or from the counselor's view of that student.
        </Alert>
      </header>

      <WeightSection
        title="Career match"
        description="What a career's score is made of. The three shares add up to the whole score."
        fields={CAREER_FIELDS}
        values={draft.career}
        defaults={data.defaults.career}
        revision={revision}
        onChange={(career) => setDraft({ ...draft, career })}
        onBalance={(career) => replace({ ...draft, career })}
        action={saveAction}
      />

      <WeightSection
        title="Program match"
        description="What a college program's score is made of. The first two are the careers a program leads to — seen in breadth, then in depth — and the last three are the student."
        fields={PROGRAM_FIELDS}
        values={draft.program}
        defaults={data.defaults.program}
        revision={revision}
        onChange={(program) => setDraft({ ...draft, program })}
        onBalance={(program) => replace({ ...draft, program })}
        action={saveAction}
      />

      {/*
        The Holland position weights, the career-alignment depth and the missing-signal neutrals are
        not edited here: they still travel in the draft, so a save writes back what is stored.
      */}
      <Card>
        <CardHeader>
          <CardTitle as="h2" className="text-base">
            Academic band, and how many matches to keep
          </CardTitle>
          <CardDescription>
            Academic fit is a straight line between two grades: at the floor it scores 0, at the
            ceiling 100. The defaults are the Philippine senior high school passing minimum and a
            practical high-end anchor.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col divide-y divide-border">
          <PointRow
            label="Floor grade"
            help="A grade at or below this scores 0 for academic fit."
            value={draft.academic.floor}
            shipped={data.defaults.academic.floor}
            onChange={(floor) => setDraft({ ...draft, academic: { ...draft.academic, floor } })}
            key={`${revision}:floor`}
          />
          <PointRow
            label="Ceiling grade"
            help="A grade at or above this scores 100."
            value={draft.academic.ceiling}
            shipped={data.defaults.academic.ceiling}
            onChange={(ceiling) => setDraft({ ...draft, academic: { ...draft.academic, ceiling } })}
            key={`${revision}:ceiling`}
          />
          <PointRow
            label="Matches kept per student"
            help="How many careers and how many programs are stored for each student. The whole catalog is scored either way; this is how much of the ranking is kept."
            value={draft.topN}
            shipped={data.defaults.topN}
            suffix="each"
            onChange={(topN) => setDraft({ ...draft, topN })}
            key={`${revision}:topN`}
          />
        </CardContent>
        <CardContent>
          <div className="flex justify-end border-t border-border pt-3">{saveAction}</div>
        </CardContent>
      </Card>

      {/*
        How much each kind of program → career link counts (backend migration 0041). Shown as a
        percentage of a direct link, which is fixed at 100%: a direct link is the program's own
        destination and is what "counts fully" means.
      */}
      <Card>
        <CardHeader>
          <CardTitle as="h2" className="text-base">
            How much each kind of link counts
          </CardTitle>
          <CardDescription>
            On Canonical programs, each career a program leads to is marked Direct, Related or
            Conditional. A direct link always counts in full. A lighter link pulls that career&apos;s
            part of the program&apos;s score toward neutral — weaker evidence, never a penalty.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col divide-y divide-border">
          <PointRow
            label="Related link"
            help="A common path for the program's graduates, but not its natural destination."
            value={Math.round(draft.linkWeights.related * 100)}
            shipped={Math.round(data.defaults.linkWeights.related * 100)}
            suffix="%"
            onChange={(percent) =>
              setDraft({ ...draft, linkWeights: { ...draft.linkWeights, related: percent / 100 } })
            }
            key={`${revision}:related`}
          />
          <PointRow
            label="Conditional link"
            help="Reachable only with an extra credential or licence on top of the degree."
            value={Math.round(draft.linkWeights.conditional * 100)}
            shipped={Math.round(data.defaults.linkWeights.conditional * 100)}
            suffix="%"
            onChange={(percent) =>
              setDraft({
                ...draft,
                linkWeights: { ...draft.linkWeights, conditional: percent / 100 },
              })
            }
            key={`${revision}:conditional`}
          />
        </CardContent>
        <CardContent>
          <div className="flex justify-end border-t border-border pt-3">{saveAction}</div>
        </CardContent>
      </Card>

      {problems.length > 0 ? (
        <Alert>
          <span className="font-medium">This formula cannot be saved yet.</span>
          <ul className="mt-1 list-disc pl-5">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {/*
        The actions, at the end of the thing they act on. `flex-wrap` rather than a horizontal row:
        three buttons and a status line do not fit across a 320px phone, and a toolbar that scrolls
        sideways is a toolbar with a hidden button.
      */}
      <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          {changed
            ? 'Unsaved changes.'
            : data.is_default
              ? 'Running the shipped formula.'
              : 'Saved.'}
        </p>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            disabled={!changed}
            onClick={() => replace(data.formula)}
          >
            Discard changes
          </Button>

          <Button
            variant="secondary"
            disabled={data.is_default}
            onClick={() => openConfirm('reset')}
          >
            <RotateCcw className="size-4" aria-hidden="true" />
            Restore defaults
          </Button>

          <Button
            disabled={problems.length > 0 || !changed}
            onClick={() => openConfirm('save')}
          >
            Save formula
          </Button>
        </div>
      </div>

      <Dialog open={confirming !== null} onOpenChange={(open) => (open ? undefined : closeConfirm())}>
        {/* Mounted only while open, so the password box is empty every time it is asked for. */}
        {confirming !== null ? (
          <ConfirmPasswordDialog
            action={confirming}
            pending={activeMutation.isPending}
            error={activeMutation.error instanceof ApiRequestError ? activeMutation.error : null}
            onConfirm={onConfirm}
            onCancel={closeConfirm}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

/** Re-authentication before a change that re-scores every recommendation generated afterwards. */
function ConfirmPasswordDialog({
  action,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  action: 'save' | 'reset';
  pending: boolean;
  error: ApiRequestError | null;
  onConfirm: (currentPassword: string) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const [missing, setMissing] = useState(false);
  const fieldError = missing
    ? 'Your password is required.'
    : (error?.fieldError('current_password') ?? null);
  const otherError = error && !error.fieldError('current_password') ? error.message : null;

  return (
    <DialogContent
      title="Confirm your password"
      description={
        action === 'reset'
          ? 'Restore the formula this release ships with? Every weight goes back to its original value for all recommendations generated from now on.'
          : 'Saving changes how every recommendation generated from now on is scored.'
      }
      className="max-w-md"
    >
      <form
        className="flex flex-col gap-4"
        noValidate
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();

          if (password === '') {
            setMissing(true);
            return;
          }

          onConfirm(password);
        }}
      >
        {otherError ? <Alert>{otherError}</Alert> : null}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="formula_current_password">Your password</Label>
          <Input
            id="formula_current_password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            aria-invalid={fieldError !== null}
            aria-describedby={fieldError ? 'formula_current_password_error' : undefined}
            onChange={(event) => {
              setPassword(event.target.value);
              setMissing(false);
            }}
          />
          {fieldError ? (
            <p id="formula_current_password_error" className="text-sm text-destructive">
              {fieldError}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="secondary"
            onClick={onCancel}
            disabled={pending}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button type="submit" loading={pending} className="w-full sm:w-auto">
            {action === 'reset' ? 'Restore defaults' : 'Save formula'}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

// --- the weight sections --------------------------------------------------------------------

interface WeightField<TKey extends string> {
  key: TKey;
  label: string;
  help: string;
}

const CAREER_FIELDS = [
  {
    key: 'riasecCompatibility',
    label: 'RIASEC interest fit',
    help: "How well the student's interest profile matches the career's typical Holland code.",
  },
  {
    key: 'careerConfidence',
    label: 'SCCT career confidence',
    help: "The student's Career Confidence Index, recomputed from their SCCT result.",
  },
  {
    key: 'studentPreference',
    label: 'Student preference',
    help: 'A fixed term, identical for every career, until a real preference input exists. Being a constant it shifts every career score equally and changes no ranking — it is here to keep the composite on a 0–100 scale.',
  },
] as const satisfies readonly WeightField<'riasecCompatibility' | 'careerConfidence' | 'studentPreference'>[];

const PROGRAM_FIELDS = [
  {
    key: 'riasecCompatibility',
    label: 'RIASEC fit, across all its careers',
    help: 'The breadth signal: the average interest fit over every career the program leads to. A program with nothing linked scores the neutral value below.',
  },
  {
    key: 'careerAlignment',
    label: 'Career alignment',
    help: "The depth signal: the best careers the program leads to, scored on the student's own career scale. This is what makes a degree that leads to their top career rank near it.",
  },
  {
    key: 'careerConfidence',
    label: 'SCCT career confidence',
    help: 'The same Career Confidence Index the career score uses.',
  },
  {
    key: 'academicFit',
    label: 'Academic fit',
    help: 'Where the average of the Math, Science and English grades the student filled in sits within the academic band. It is the same for every program a given student is scored against, so it moves all their scores together rather than ranking one above another.',
  },
  {
    key: 'strandAlignment',
    label: 'Strand alignment',
    help: "Whether the program's recommended senior high school strand is the one the student is on.",
  },
] as const satisfies readonly WeightField<keyof ScoringFormula['program']>[];

/**
 * One set of weights: a row per component, a total, and a way back to 100%.
 *
 * Generic over the key set because the sections are the same control with different labels, and
 * each copy of a percentage input that has to agree with a sum check is another chance for one of
 * them to disagree.
 */
function WeightSection<TKey extends string>({
  title,
  description,
  fields,
  values,
  defaults,
  revision,
  onChange,
  onBalance,
  action,
}: {
  title: string;
  description: string;
  fields: readonly WeightField<TKey>[];
  values: Record<TKey, number>;
  defaults: Record<TKey, number>;
  revision: number;
  onChange: (values: Record<TKey, number>) => void;
  /** A wholesale replacement, which also re-seeds the inputs — see `revision`. */
  onBalance: (values: Record<TKey, number>) => void;
  action: ReactNode;
}) {
  const total = fields.reduce((sum, field) => sum + toPercent(values[field.key]), 0);
  const balanced = Math.abs(total - 100) < 0.05;

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="text-base">
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col">
        <div className="flex flex-col divide-y divide-border">
          {fields.map((field) => (
            <WeightRow
              key={`${revision}:${field.key}`}
              label={field.label}
              help={field.help}
              percent={toPercent(values[field.key])}
              shippedPercent={toPercent(defaults[field.key])}
              onChange={(percent) =>
                onChange({ ...values, [field.key]: fromPercent(percent) } as Record<TKey, number>)
              }
            />
          ))}
        </div>

        <div className="mt-4 flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className={cn('text-sm', balanced ? 'text-muted-foreground' : 'text-destructive')}>
            Total {formatPercent(total)}%{balanced ? null : ' — these must add up to 100%'}
          </p>

          <div className="flex flex-col gap-2 sm:flex-row">
            {balanced ? null : (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onBalance(balance(values, fields))}
                className="w-full sm:w-auto"
              >
                <Scale className="size-4" aria-hidden="true" />
                Balance to 100%
              </Button>
            )}
            {action}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** One weight, as a percentage, with a bar and a note when it differs from what shipped. */
function WeightRow({
  label,
  help,
  percent,
  shippedPercent,
  onChange,
}: {
  label: string;
  help: string;
  percent: number;
  shippedPercent: number;
  onChange: (percent: number) => void;
}) {
  const [text, setText] = useState(() => formatPercent(percent));
  const id = useFieldId(label);

  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0 sm:flex-1">
        <Label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
        </Label>
        {help ? <p className="mt-0.5 text-xs text-muted-foreground">{help}</p> : null}

        {/* The proportional bar. Decorative — the number beside it is the fact. */}
        <div className="mt-2 h-1.5 w-full max-w-sm bg-secondary" aria-hidden="true">
          <div
            className="h-full bg-primary transition-[width]"
            style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
          />
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
        <div className="flex items-center gap-2">
          <Input
            id={id}
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            step={0.1}
            className="w-24 text-right"
            value={text}
            onChange={(event) => {
              setText(event.target.value);

              const parsed = Number(event.target.value);

              // An empty or half-typed field ("1.") is left alone rather than pushed up as a 0 —
              // the draft keeps its last good value until there is a new one to take.
              if (event.target.value !== '' && Number.isFinite(parsed)) {
                onChange(parsed);
              }
            }}
          />
          <span className="text-sm text-muted-foreground">%</span>
        </div>

        {Math.abs(percent - shippedPercent) > 0.05 ? (
          <span className="text-xs text-accent">was {formatPercent(shippedPercent)}%</span>
        ) : null}
      </div>
    </div>
  );
}

/** A 0–100 value that is not a share of anything: a neutral, an anchor, a count. */
function PointRow({
  label,
  help,
  value,
  shipped,
  suffix,
  onChange,
}: {
  label: string;
  help: string;
  value: number;
  shipped: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(() => String(value));
  const id = useFieldId(label);

  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0 sm:flex-1">
        <Label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
        </Label>
        {help ? <p className="mt-0.5 text-xs text-muted-foreground">{help}</p> : null}
      </div>

      <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
        <div className="flex items-center gap-2">
          <Input
            id={id}
            type="number"
            inputMode="decimal"
            className="w-24 text-right"
            value={text}
            onChange={(event) => {
              setText(event.target.value);

              const parsed = Number(event.target.value);

              if (event.target.value !== '' && Number.isFinite(parsed)) {
                onChange(parsed);
              }
            }}
          />
          {suffix ? <span className="text-sm text-muted-foreground">{suffix}</span> : null}
        </div>

        {value !== shipped ? (
          <span className="text-xs text-accent">was {shipped}</span>
        ) : null}
      </div>
    </div>
  );
}

// --- arithmetic and validation ---------------------------------------------------------------

/** A stored fraction as the percentage the screen edits: `0.35` → `35`. */
function toPercent(fraction: number): number {
  return Math.round(fraction * 1000) / 10;
}

function fromPercent(percent: number): number {
  return percent / 100;
}

/** `60` reads `60`, `16.67` reads `16.7`. One decimal, because that is the precision offered. */
function formatPercent(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** Scale a set of weights so they sum to 1, keeping the ratios the administrator chose. */
function balance<TKey extends string>(
  values: Record<TKey, number>,
  fields: readonly WeightField<TKey>[],
): Record<TKey, number> {
  const total = fields.reduce((sum, field) => sum + values[field.key], 0);

  if (total <= 0) {
    // Nothing to keep the ratio of. An even split is the only answer that is not arbitrary.
    return Object.fromEntries(
      fields.map((field) => [field.key, 1 / fields.length]),
    ) as Record<TKey, number>;
  }

  return Object.fromEntries(
    fields.map((field) => [field.key, values[field.key] / total]),
  ) as Record<TKey, number>;
}

/**
 * Everything the server would refuse, checked here first.
 *
 * Not *instead of* the server — the API validates the same rules and is the only thing that can be
 * trusted — but an administrator who has just retyped five weights deserves to be told which one is
 * wrong beside the field, not by a 422 after a round trip.
 */
function validate(formula: ScoringFormula): string[] {
  const problems: string[] = [];
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const near = (total: number) => Math.abs(total - 1) < 0.0005;

  if (!near(sum(Object.values(formula.career)))) {
    problems.push('The career match weights must add up to 100%.');
  }

  if (!near(sum(Object.values(formula.program)))) {
    problems.push('The program match weights must add up to 100%.');
  }

  if ([formula.academic.floor, formula.academic.ceiling].some((value) => value < 0 || value > 100)) {
    problems.push('The academic band must be between 0 and 100.');
  }

  if (formula.academic.ceiling <= formula.academic.floor) {
    problems.push('The ceiling grade must be above the floor grade.');
  }

  if (!Number.isInteger(formula.topN) || formula.topN < 3 || formula.topN > 20) {
    problems.push('Keep between 3 and 20 matches of each kind.');
  }

  const { related, conditional } = formula.linkWeights;

  if ([related, conditional].some((value) => value <= 0 || value > 1)) {
    problems.push('Related and conditional links must count for more than 0% and at most 100%.');
  }

  if (related < conditional) {
    problems.push('A related link cannot count for less than a conditional one.');
  }

  return problems;
}

/** A stable id from a label, so every input has a label that points at it. */
function useFieldId(label: string): string {
  return `formula-${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`;
}

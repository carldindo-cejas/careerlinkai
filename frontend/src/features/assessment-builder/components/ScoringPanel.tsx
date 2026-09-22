import { Plus, Scale, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/components/ui/cn';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useUpdateScoringConfig } from '@/features/assessment-builder/hooks/useBuilder';
import {
  balancePercents,
  bandFor,
  bandProblems,
  isBalanced,
  percentTotal,
  sampleComposite,
  toFractions,
  toPercent,
} from '@/features/assessment-builder/utils/compositeWeights';
import type { BuilderDimension, CompositeRange, VersionReview } from '@/types/builder';

/**
 * A made-up student for the worked example: strong on the first dimension, weaker after. Uneven on
 * purpose, so a change of weight visibly moves the result.
 */
const SAMPLE_SCORES = [80, 60, 50];

/**
 * **The Scoring panel** — a weighted-composite version's weights and the bands that name its result.
 *
 * This is *how the career-confidence number is built*. It is not the Formula page's "career
 * confidence" weight, which decides how much that number counts in a match; the description says so
 * because the two sit one word apart.
 *
 * Editable only on a draft the caller may manage. A published version shows its weights read-only:
 * its students were scored under them, and every score is recomputed from them.
 */
export function ScoringPanel({
  review,
  dimensions,
  editable,
}: {
  review: VersionReview;
  dimensions: BuilderDimension[];
  editable: boolean;
}) {
  const saved = review.composite_weights ?? {};
  const codes = dimensions.map((dimension) => dimension.code);

  const [percents, setPercents] = useState<Record<string, number>>(() =>
    Object.fromEntries(codes.map((code) => [code, toPercent(saved[code] ?? 0)])),
  );
  const [ranges, setRanges] = useState<CompositeRange[]>(() => review.composite_ranges ?? []);
  // Bumped by "Balance to 100%" so the inputs re-seed from the new values.
  const [revision, setRevision] = useState(0);
  const update = useUpdateScoringConfig(review.id);

  const total = percentTotal(percents);
  const balanced = isBalanced(percents);
  const problems = bandProblems(ranges);
  const unweighted = Object.keys(saved).length === 0;

  const sample = Object.fromEntries(codes.map((code, i) => [code, SAMPLE_SCORES[i] ?? 60]));
  const sampleScore = sampleComposite(sample, percents);
  const sampleBand = sampleScore === null ? null : bandFor(ranges, sampleScore);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Scoring</CardTitle>
        <CardDescription>
          How much each dimension counts toward this version's overall score, and what each score
          range is called. This builds the career-confidence number itself; how much that number
          counts in a match is set separately on the Formula page.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        {editable ? null : (
          <p className="text-sm text-muted-foreground">
            v{review.version_number} is {review.status.toLowerCase()}, so its weights are fixed.
            Duplicate this version to change its weights.
          </p>
        )}

        {review.scored_student_count ? (
          <p className="text-sm text-muted-foreground" data-testid="scored-count">
            {review.scored_student_count}{' '}
            {review.scored_student_count === 1 ? 'student was' : 'students were'} scored under
            v{review.version_number}'s weights. Their scores do not change if a later version is
            re-weighted.
          </p>
        ) : null}

        {unweighted && editable ? (
          <p className="text-sm text-muted-foreground">
            No weights are set, so this version is scored as a plain average of its dimensions.
          </p>
        ) : null}

        <section className="flex flex-col gap-2" aria-label="Dimension weights">
          {dimensions.map((dimension) => {
            const id = `weight-${review.id}-${dimension.code}`;

            return (
              <div key={`${revision}:${dimension.code}`} className="flex items-center gap-3">
                <Label htmlFor={id} className="min-w-0 flex-1 text-sm">
                  {dimension.name} <span className="text-muted-foreground">({dimension.code})</span>
                </Label>
                <Input
                  id={id}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={100}
                  step={0.1}
                  className="w-24 text-right"
                  disabled={!editable}
                  defaultValue={String(percents[dimension.code] ?? 0)}
                  onChange={(event) => {
                    const parsed = Number(event.target.value);

                    if (event.target.value !== '' && Number.isFinite(parsed)) {
                      setPercents((current) => ({ ...current, [dimension.code]: parsed }));
                    }
                  }}
                />
                <span className="text-sm text-muted-foreground">%</span>
              </div>
            );
          })}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
            <p className={cn('text-sm', balanced ? 'text-muted-foreground' : 'text-destructive')}>
              Total {total}%{balanced ? null : ' — these must add up to 100%'}
            </p>
            {editable && !balanced ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setPercents(balancePercents(percents, codes));
                  setRevision((value) => value + 1);
                }}
              >
                <Scale className="size-4" aria-hidden="true" />
                Balance to 100%
              </Button>
            ) : null}
          </div>
        </section>

        <section className="flex flex-col gap-2" aria-label="Score bands">
          <p className="text-sm font-medium">Bands</p>
          {ranges.map((range, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <Input
                aria-label={`Band ${index + 1} from`}
                type="number"
                min={0}
                max={100}
                className="w-20"
                disabled={!editable}
                value={range.min}
                onChange={(event) => setRanges(replaceAt(ranges, index, { min: Number(event.target.value) }))}
              />
              <span className="text-sm text-muted-foreground">to</span>
              <Input
                aria-label={`Band ${index + 1} to`}
                type="number"
                min={0}
                max={100}
                className="w-20"
                disabled={!editable}
                value={range.max}
                onChange={(event) => setRanges(replaceAt(ranges, index, { max: Number(event.target.value) }))}
              />
              <Input
                aria-label={`Band ${index + 1} label`}
                className="min-w-40 flex-1"
                disabled={!editable}
                value={range.label}
                onChange={(event) => setRanges(replaceAt(ranges, index, { label: event.target.value }))}
              />
              {editable ? (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove band ${index + 1}`}
                  onClick={() => setRanges(ranges.filter((_, i) => i !== index))}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              ) : null}
            </div>
          ))}
          {editable ? (
            <Button
              variant="secondary"
              size="sm"
              className="self-start"
              onClick={() => setRanges([...ranges, { min: 0, max: 100, label: '' }])}
            >
              <Plus className="size-4" aria-hidden="true" />
              Add band
            </Button>
          ) : null}
          {editable && problems.length > 0 ? (
            <ul className="text-sm text-destructive">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          ) : null}
        </section>

        {sampleScore === null ? null : (
          <p className="text-sm text-muted-foreground" data-testid="scoring-example">
            Example: a student scoring{' '}
            {codes.map((code) => `${code} ${sample[code]}`).join(', ')} gets{' '}
            <span className="font-medium text-foreground">{sampleScore}</span>
            {sampleBand === null ? '' : ` (${sampleBand})`}.
          </p>
        )}

        {editable ? (
          <div className="flex flex-col gap-2">
            <Button
              className="self-start"
              disabled={!balanced || problems.length > 0 || update.isPending}
              onClick={() =>
                update.mutate({
                  composite_weights: Object.fromEntries(
                    Object.entries(toFractions(percents)).filter(([, weight]) => weight > 0),
                  ),
                  composite_ranges: ranges,
                })
              }
            >
              {update.isPending ? 'Saving…' : 'Save weights'}
            </Button>
            {update.isError ? <Alert>{update.error.message}</Alert> : null}
            {update.isSuccess ? (
              <p className="text-sm text-muted-foreground">
                Saved. Students who already took an earlier version keep their scores; only this
                version, once published, uses these weights.
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function replaceAt(
  ranges: CompositeRange[],
  index: number,
  patch: Partial<CompositeRange>,
): CompositeRange[] {
  return ranges.map((range, i) => (i === index ? { ...range, ...patch } : range));
}

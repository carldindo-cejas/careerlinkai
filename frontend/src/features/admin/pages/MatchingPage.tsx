import { CheckCircle2, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  usePreviewMatches,
  useRecomputeStale,
  useRecommendationFreshness,
} from '@/features/admin/hooks/useMatching';
import { toast } from '@/stores/toastStore';
import { ApiRequestError } from '@/types/api';
import { RIASEC_LETTERS, RIASEC_NAMES, STRANDS, type Strand } from '@/types/catalog';
import type { PreviewResult, RiasecScores } from '@/types/matching';

/**
 * Matching (2026-09-22) — keeping students' recommendations in step with the catalog and formula.
 *
 * A student's recommendations are computed once and saved. Since administrators can change what a
 * program leads to (Canonical programs), a career's Holland code (Careers) and the weights
 * (Formula), a saved set can describe a configuration that no longer exists. This page answers the
 * two questions that follow: **how many students are holding results from before the last change,
 * and what would a student be shown today?**
 */
export function MatchingPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="max-w-2xl">
        <h1 className="text-xl font-semibold text-foreground">Matching</h1>
        <p className="text-sm text-muted-foreground">
          Students&apos; recommendations are computed when they finish their assessments and then
          saved. After you change the catalog or the formula, recompute them here — and preview what
          a student with given results would be shown, before any real student sees it.
        </p>
      </div>

      <FreshnessCard />
      <PreviewCard />
    </div>
  );
}

function FreshnessCard() {
  const { data, isPending, isError, error } = useRecommendationFreshness();
  const recompute = useRecomputeStale();

  const stale = data?.stale_sets ?? 0;
  const total = data?.students_with_sets ?? 0;
  const progress = recompute.progress;

  function run() {
    recompute.mutate(undefined, {
      onSuccess: (result) => {
        if (result.failed > 0) {
          toast.error(
            `Recomputed ${result.regenerated}. ${result.failed} could not be recomputed and still show their older results.`,
          );
        } else {
          toast.success(`Recomputed ${result.regenerated} students' recommendations.`);
        }
      },
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Saved recommendations</CardTitle>
        <CardDescription>
          {data?.inputs_changed_at
            ? `The catalog or formula last changed ${new Date(data.inputs_changed_at).toLocaleString()}.`
            : 'Nothing that affects matching has changed since recommendations were first computed.'}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Checking…
          </p>
        ) : null}

        {isError ? <Alert>{error.message}</Alert> : null}

        {recompute.isError ? (
          <Alert>
            {recompute.error instanceof Error
              ? `Recomputing stopped: ${recompute.error.message}. Run it again to continue from where it stopped.`
              : 'Recomputing stopped. Run it again to continue from where it stopped.'}
          </Alert>
        ) : null}

        {data && stale === 0 ? (
          <p className="flex items-center gap-2 text-sm text-foreground">
            <CheckCircle2 className="size-4 text-primary" aria-hidden="true" />
            {total === 0
              ? 'No student has recommendations yet.'
              : `All ${total} ${total === 1 ? "student's results are" : "students' results are"} current.`}
          </p>
        ) : null}

        {data && stale > 0 ? (
          <>
            <Alert tone="warning">
              {stale} of {total} {total === 1 ? "student's" : "students'"} recommendations were
              computed before the last change. They still see those older results — and so do their
              counselors — until they are recomputed.
            </Alert>

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={run} loading={recompute.isPending} disabled={recompute.isPending}>
                <RefreshCw className="size-4" aria-hidden="true" />
                {recompute.isPending ? 'Recomputing…' : `Recompute ${stale}`}
              </Button>

              {recompute.isPending && progress ? (
                <span className="text-sm text-muted-foreground" role="status">
                  Recomputed {progress.regenerated}
                  {progress.remaining > 0 ? `, ${progress.remaining} to go` : ''}… Keep this page
                  open.
                </span>
              ) : null}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Starting points, so a preview is one click rather than six numbers. */
const PRESETS: { label: string; riasec: RiasecScores }[] = [
  { label: 'Investigative', riasec: { R: 30, I: 90, A: 25, S: 20, E: 25, C: 45 } },
  { label: 'Artistic', riasec: { R: 15, I: 35, A: 92, S: 50, E: 40, C: 10 } },
  { label: 'Social', riasec: { R: 10, I: 30, A: 40, S: 90, E: 55, C: 35 } },
  { label: 'Enterprising', riasec: { R: 20, I: 25, A: 30, S: 55, E: 90, C: 50 } },
  { label: 'Realistic', riasec: { R: 90, I: 60, A: 15, S: 20, E: 30, C: 45 } },
  { label: 'Conventional', riasec: { R: 30, I: 40, A: 10, S: 25, E: 45, C: 90 } },
];

const NO_STRAND = '__none__';

function PreviewCard() {
  const preview = usePreviewMatches();

  const [riasec, setRiasec] = useState<RiasecScores>(PRESETS[0]!.riasec);
  const [confidence, setConfidence] = useState('75');
  const [average, setAverage] = useState('');
  const [strand, setStrand] = useState<string>(NO_STRAND);

  const serverError = preview.error instanceof ApiRequestError ? preview.error : null;

  function onSubmit(event: FormEvent) {
    event.preventDefault();

    preview.mutate({
      riasec,
      career_confidence: clampScore(confidence),
      academic_average: average.trim() === '' ? null : Number(average),
      strand: strand === NO_STRAND ? null : (strand as Strand),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Preview a student</CardTitle>
        <CardDescription>
          Enter results as a student would have them, and see the careers and programs they would be
          recommended with today&apos;s catalog and formula. Nothing is saved.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Start from
            </span>
            {PRESETS.map((preset) => (
              <Button
                key={preset.label}
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setRiasec(preset.riasec)}
              >
                {preset.label}
              </Button>
            ))}
          </div>

          <fieldset className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <legend className="sr-only">RIASEC interest scores, 0 to 100</legend>
            {RIASEC_LETTERS.map((letter) => (
              <div key={letter} className="flex flex-col gap-1.5">
                <Label htmlFor={`preview-${letter}`}>
                  {RIASEC_NAMES[letter]} ({letter})
                </Label>
                <Input
                  id={`preview-${letter}`}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={100}
                  value={riasec[letter]}
                  onChange={(event) =>
                    setRiasec((current) => ({
                      ...current,
                      [letter]: clampScore(event.target.value),
                    }))
                  }
                />
              </div>
            ))}
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="preview-confidence">Career confidence (SCCT, 0–100)</Label>
              <Input
                id="preview-confidence"
                type="number"
                inputMode="numeric"
                min={0}
                max={100}
                value={confidence}
                onChange={(event) => setConfidence(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="preview-average">Subject average (optional)</Label>
              <Input
                id="preview-average"
                type="number"
                inputMode="decimal"
                min={60}
                max={100}
                placeholder="e.g. 88"
                value={average}
                onChange={(event) => setAverage(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="preview-strand">Strand</Label>
              <Select
                id="preview-strand"
                value={strand}
                onChange={(event) => setStrand(event.target.value)}
              >
                <option value={NO_STRAND}>Not given</option>
                {STRANDS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {serverError ? <Alert>{serverError.message}</Alert> : null}

          <div>
            <Button type="submit" loading={preview.isPending}>
              <Sparkles className="size-4" aria-hidden="true" />
              Preview recommendations
            </Button>
          </div>
        </form>

        {preview.data ? <PreviewResults result={preview.data} /> : null}
      </CardContent>
    </Card>
  );
}

function PreviewResults({ result }: { result: PreviewResult }) {
  return (
    <div className="grid gap-6 border-t border-border pt-5 lg:grid-cols-2">
      <section aria-labelledby="preview-careers">
        <h2 id="preview-careers" className="mb-2 text-sm font-semibold text-foreground">
          Top careers
        </h2>
        <ol className="flex flex-col gap-2">
          {result.careers.map((career, index) => (
            <li key={career.id} className="border border-border p-3">
              <div className="flex items-start justify-between gap-3">
                <span className="text-sm font-medium text-foreground">
                  {index + 1}. {career.title}
                  {career.typical_riasec_code ? (
                    <span className="ml-1.5 font-mono text-xs text-muted-foreground">
                      {career.typical_riasec_code}
                    </span>
                  ) : null}
                </span>
                <Badge>{career.match_score}</Badge>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="preview-programs">
        <h2 id="preview-programs" className="mb-2 text-sm font-semibold text-foreground">
          Top programs
        </h2>
        {result.programs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No program is offered by an active college.</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {result.programs.map((program, index) => (
              <li key={program.id} className="border border-border p-3">
                <div className="flex items-start justify-between gap-3">
                  <span className="text-sm font-medium text-foreground">
                    {index + 1}. {program.name}
                    <span className="block text-xs font-normal text-muted-foreground">
                      {program.college_name}
                    </span>
                  </span>
                  <Badge>{program.match_score}</Badge>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function clampScore(value: string): number {
  const number = Number(value);

  if (!Number.isFinite(number)) return 0;

  return Math.min(100, Math.max(0, Math.round(number)));
}

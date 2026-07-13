import { useParams } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useResult } from '@/features/student/hooks/useAssessment';
import type { AssessmentResult, DimensionScore } from '@/types/assessment';

/**
 * "My result" (FULLPLAN §37: *"dimension breakdown, Holland Code / SCCT confidence"*).
 *
 * The breakdown **is** the result; the Holland Code is only its headline. "IAS" tells a Grade 12
 * student nothing on its own — the three letters mean something only once they can see that
 * Investigative came out at 84 and Realistic at 30, and read what those words mean.
 *
 * The result is deterministic and contains **no AI whatsoever** (§29). The AI paragraph arrives in
 * Phase 5a and lives on the *recommendation*, not here — a different screen, off a different
 * table, so that a computed fact and a generated sentence can never be mistaken for one another.
 */
export function ResultPage() {
  const { attemptId = '' } = useParams();
  const { data: result, isLoading, error } = useResult(attemptId);

  if (isLoading) return <p className="text-sm text-slate-500">Loading your result…</p>;
  if (error || !result) return <Alert tone="danger">This result could not be loaded.</Alert>;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{result.assessment?.title}</h1>
        <p className="text-sm text-slate-500">
          Completed{' '}
          {result.submitted_at ? new Date(result.submitted_at).toLocaleDateString() : 'recently'}
        </p>
      </div>

      <Headline result={result} />

      <Card>
        <CardHeader>
          <CardTitle>Your breakdown</CardTitle>
          <CardDescription>
            Each score is out of 100 and shows how strongly this came through in your answers — not
            how well you did. There is no pass mark.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {result.dimensions.map((dimension) => (
            <DimensionBar key={dimension.code} dimension={dimension} />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * RIASEC gets a code; SCCT gets a sentence (§22, §23). Exactly one of the two is present, and
 * which one is a property of the instrument rather than of this component.
 */
function Headline({ result }: { result: AssessmentResult }) {
  const code = result.result?.result_code;
  const summary = result.result?.overall_summary;

  if (code) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-8">
          <p className="text-sm font-medium uppercase tracking-wide text-slate-500">
            Your Holland Code
          </p>
          <p className="font-mono text-5xl font-semibold tracking-[0.2em] text-slate-900">{code}</p>
          <p className="max-w-md text-center text-sm text-slate-500">
            Your three strongest interest areas, in order:{' '}
            {result.dimensions
              .slice()
              .sort((a, b) => Number(b.normalized_score) - Number(a.normalized_score))
              .slice(0, 3)
              .map((d) => d.name)
              .join(' · ')}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (summary) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-8">
          <p className="text-sm font-medium uppercase tracking-wide text-slate-500">
            Your career confidence
          </p>
          {/*
            Rendered as the string the server sent, and never parsed for the number inside it
            (§23, v1.2 — the plan names this as "a bug waiting to happen"). If a screen ever needs
            the composite as a number, it comes from the dimension scores below, recomputed, the
            way Part VII will do it.
          */}
          <p className="text-center text-2xl font-semibold text-slate-900">{summary}</p>
        </CardContent>
      </Card>
    );
  }

  return null;
}

function DimensionBar({ dimension }: { dimension: DimensionScore }) {
  const score = Number(dimension.normalized_score);

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-4">
        <span className="text-sm font-medium text-slate-800">
          <span className="mr-2 font-mono text-slate-400">{dimension.code}</span>
          {dimension.name}
        </span>
        <span className="whitespace-nowrap text-sm text-slate-500">
          {score.toFixed(0)}
          {dimension.interpretation ? ` · ${dimension.interpretation}` : null}
        </span>
      </div>

      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full bg-slate-800" style={{ width: `${score}%` }} />
      </div>

      {dimension.description ? (
        <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{dimension.description}</p>
      ) : null}
    </div>
  );
}

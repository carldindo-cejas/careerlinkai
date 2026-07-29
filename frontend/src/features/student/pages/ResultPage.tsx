import { useLocation, useNavigate, useParams } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useResult } from '@/features/student/hooks/useAssessment';
import { paths, type ResultPageState } from '@/routes/paths';
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
  const navigate = useNavigate();

  /**
   * Where the student came from, if the sending screen said so (see `ResultPageState`).
   *
   * Deliberately **not** `navigate(-1)`. The player replaces itself in the history stack when it
   * submits, so "one entry back" from a freshly finished assessment is whatever preceded the
   * player — which is usually right but occasionally is the login screen or nothing at all. A
   * named destination cannot land somewhere meaningless, and it lets the button say where it goes.
   */
  const returnTo = (useLocation().state ?? null) as ResultPageState | null;
  const showReturn = returnTo !== null && returnTo.from !== paths.studentAssessments;

  if (isLoading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading your result…
      </p>
    );
  }

  if (error || !result) return <Alert tone="danger">This result could not be loaded.</Alert>;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{result.assessment?.title}</h1>
        <p className="text-sm text-muted-foreground">
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
        <CardContent>
          {/*
            A real list, so a screen reader says "list, 6 items" before reading them. RIASEC has
            six dimensions and SCCT has four; knowing how many are coming is the difference
            between a breakdown and an open-ended recital of numbers.
          */}
          <ul className="flex flex-col gap-5">
            {result.dimensions.map((dimension) => (
              <DimensionBar key={dimension.code} dimension={dimension} />
            ))}
          </ul>
        </CardContent>
      </Card>

      {/*
        The way out. "Back to assessments" is always offered because it is always a valid
        destination; the "Return to…" button appears only when another screen told us it sent the
        student here, and names that screen rather than saying "back".
      */}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => navigate(paths.studentAssessments)}>Back to assessments</Button>

        {showReturn ? (
          <Button variant="secondary" onClick={() => navigate(returnTo.from)}>
            Return to {returnTo.fromLabel.toLowerCase()}
          </Button>
        ) : null}

        <Button variant="ghost" onClick={() => navigate(paths.studentRecommendations)}>
          See my recommendations
        </Button>
      </div>
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
          <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Your Holland Code
          </p>
          {/*
            Spelled out for the screen reader, drawn as three letters for everyone else. A Holland
            code is an initialism, and "RIA" or "SEC" is read as a word by most engines — "sek" is
            not the student's result, and the one line on this page they are most likely to repeat
            to a counselor is the one they would get wrong.
          */}
          <p className="font-mono text-5xl font-semibold tracking-[0.2em] text-foreground">
            <span aria-hidden="true">{code}</span>
            <span className="sr-only">{code.split('').join(' ')}</span>
          </p>
          <p className="max-w-md text-center text-sm text-muted-foreground">
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
          <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Your career confidence
          </p>
          {/*
            Rendered as the string the server sent, and never parsed for the number inside it
            (§23, v1.2 — the plan names this as "a bug waiting to happen"). If a screen ever needs
            the composite as a number, it comes from the dimension scores below, recomputed, the
            way Part VII will do it.
          */}
          <p className="text-center text-2xl font-semibold text-foreground">{summary}</p>
        </CardContent>
      </Card>
    );
  }

  return null;
}

function DimensionBar({ dimension }: { dimension: DimensionScore }) {
  const score = Number(dimension.normalized_score);

  return (
    <li>
      <div className="mb-1 flex items-baseline justify-between gap-4">
        <span className="text-sm font-medium text-foreground">
          <span className="mr-2 font-mono text-muted-foreground">{dimension.code}</span>
          {dimension.name}
        </span>
        <span className="whitespace-nowrap text-sm text-muted-foreground">
          {score.toFixed(0)}
          {/*
            The card's description says "each score is out of 100" once, at the top. Read aloud
            one dimension at a time that context is four items away, and "Investigative, 84" is
            not a number a student can place — 84 out of what? The scale travels with the score.
          */}
          <span className="sr-only"> out of 100</span>
          {dimension.interpretation ? ` · ${dimension.interpretation}` : null}
        </span>
      </div>

      {/* The bar is a redraw of the number beside it, so it is hidden rather than given
          progressbar semantics that would read the same score a second time. */}
      <div
        aria-hidden="true"
        className="h-2 w-full overflow-hidden border border-border bg-secondary"
      >
        <div className="h-full bg-primary" style={{ width: `${score}%` }} />
      </div>

      {dimension.description ? (
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{dimension.description}</p>
      ) : null}
    </li>
  );
}

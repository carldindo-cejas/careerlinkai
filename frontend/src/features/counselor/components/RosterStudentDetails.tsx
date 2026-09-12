import { Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { StudentRecommendationLists } from '@/components/recommendations/StudentRecommendationLists';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useResetAttempt } from '@/features/counselor/hooks/useAssignments';
import {
  useRegenerateStudentRecommendations,
  useStudentRecommendations,
} from '@/features/student/hooks/useRecommendations';
import { toast } from '@/stores/toastStore';
import type { AssessmentResult, DimensionScore } from '@/types/assessment';

/**
 * One student, opened from the roster: their Holland code, their SCCT confidence, their top
 * recommendations, and the §21 retake for each scored attempt.
 *
 * This is what the class page's former Results and Recommendations panels showed, regrouped by
 * student. The results arrive from the parent, which fetched the whole class's once; the
 * recommendations are fetched here, which is why this component is mounted only while its row is
 * open (see `RosterTable`).
 */
export interface RosterStudentDetailsProps {
  classId: string;
  studentId: string;
  name: string;
  /** This student's scored attempts, newest first — undefined while the class results load. */
  results: AssessmentResult[] | undefined;
  resultsError: Error | null;
}

export function RosterStudentDetails({
  classId,
  studentId,
  name,
  results,
  resultsError,
}: RosterStudentDetailsProps) {
  // Newest first (server order), so `find` picks each instrument's latest attempt.
  const riasec = results?.find((result) => result.assessment?.category === 'RIASEC');
  const scct = results?.find((result) => result.assessment?.category === 'SCCT');

  /** What a result section says while there is no answer yet — never "no result" before we know. */
  function pendingOr(content: ReactNode): ReactNode {
    if (results) return content;
    if (resultsError) return <p className="text-sm text-muted-foreground">Unavailable.</p>;

    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Loading results…
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6 bg-muted/20 p-4">
      {/* D11's rule: a failed load is never an empty state. */}
      {resultsError ? (
        <Alert>We could not load {name}’s results. {resultsError.message}</Alert>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2">
        <Section title="Holland code">{pendingOr(<HollandCode result={riasec} />)}</Section>
        <Section title="SCCT confidence">{pendingOr(<ScctConfidence result={scct} />)}</Section>
      </div>

      <Recommendations studentId={studentId} name={name} />

      {results && results.length > 0 ? (
        <Section title="Assessment results">
          <ul className="flex flex-col gap-2">
            {results.map((result) => (
              <ResultRow key={result.attempt_id} classId={classId} name={name} result={result} />
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** The latest RIASEC code, with the three interest areas it spells out. */
function HollandCode({ result }: { result: AssessmentResult | undefined }) {
  const code = result?.result?.result_code;

  if (!result || !code) {
    // A blank here could be read as an empty code, so the row says why there is nothing.
    return <p className="text-sm text-muted-foreground">No RIASEC result yet</p>;
  }

  const strongest = result.dimensions
    .slice()
    .sort((a, b) => Number(b.normalized_score) - Number(a.normalized_score))
    .slice(0, 3)
    .map((dimension) => dimension.name);

  return (
    <div className="flex flex-col gap-1">
      {/* Spelled out for the screen reader — "IAS" is read as a word otherwise (see ResultPage). */}
      <p className="font-mono text-2xl font-semibold tracking-[0.2em] text-foreground">
        <span aria-hidden="true">{code}</span>
        <span className="sr-only">{code.split('').join(' ')}</span>
      </p>
      {strongest.length > 0 ? (
        <p className="text-sm text-muted-foreground">{strongest.join(' · ')}</p>
      ) : null}
    </div>
  );
}

/**
 * The latest SCCT result: the summary sentence the server wrote (rendered, never parsed — §23),
 * and each dimension on the 5-tier confidence band the instruments score against (migration 0035).
 */
function ScctConfidence({ result }: { result: AssessmentResult | undefined }) {
  if (!result) {
    return <p className="text-sm text-muted-foreground">No SCCT result yet</p>;
  }

  const summary = result.result?.overall_summary;

  return (
    <div className="flex flex-col gap-3">
      {summary ? <p className="text-sm font-medium text-foreground">{summary}</p> : null}

      {result.dimensions.length > 0 ? (
        <ul className="flex flex-col gap-2.5">
          {result.dimensions.map((dimension) => (
            <ConfidenceBar key={dimension.code} dimension={dimension} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ConfidenceBar({ dimension }: { dimension: DimensionScore }) {
  const score = Number(dimension.normalized_score);

  return (
    <li>
      <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
        <span className="text-foreground">{dimension.name}</span>
        <span className="whitespace-nowrap text-muted-foreground">
          {score.toFixed(0)}
          <span className="sr-only"> out of 100</span>
          {dimension.interpretation ? ` · ${dimension.interpretation}` : null}
        </span>
      </div>

      {/* A redraw of the number beside it, so hidden rather than read a second time. */}
      <div aria-hidden="true" className="h-1.5 w-full overflow-hidden border border-border bg-secondary">
        <div
          className="h-full bg-primary"
          style={{ width: `${Math.min(Math.max(score, 0), 100)}%` }}
        />
      </div>
    </li>
  );
}

function Recommendations({ studentId, name }: { studentId: string; name: string }) {
  const { data: set, isLoading, isError, error } = useStudentRecommendations(studentId, true);
  const regenerate = useRegenerateStudentRecommendations(studentId);

  /**
   * Rebuild, and say which of the two non-error outcomes happened.
   *
   * `null` is **not** a failure — it means this student has not finished both instruments — and
   * reporting it as one would send a counselor chasing a bug in a system behaving exactly as
   * designed. The empty state below raises the possibility that generation broke; this is where
   * that possibility gets settled one way or the other.
   */
  async function onRegenerate() {
    try {
      const rebuilt = await regenerate.mutateAsync();

      if (rebuilt === null) {
        toast.info(`${name} has not finished both RIASEC and SCCT — there is nothing to build yet.`);
      } else {
        toast.success(`Rebuilt ${name}’s recommendations from their latest results.`);
      }
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : `${name}’s recommendations could not be rebuilt.`,
      );
    }
  }

  if (isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Loading {name}’s recommendations…
      </p>
    );
  }

  if (isError) {
    return <Alert>We could not load {name}’s recommendations. {error.message}</Alert>;
  }

  return (
    <div className="flex flex-col gap-4">
      {/*
        `!set` rather than `set === null`: TanStack types `data` as `T | undefined` on top of the
        API's own `null`, and both mean "nothing to show" here — the isLoading branch above has
        already ruled out "the query has not resolved".
      */}
      {!set ? (
        <p className="text-sm text-muted-foreground">
          No recommendations yet. They are generated once <strong>both</strong> RIASEC and SCCT are
          scored. <strong>Already finished both?</strong> Generation can fail silently — rebuild to
          find out.
        </p>
      ) : (
        <StudentRecommendationLists careers={set.careers} programs={set.programs} />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="sm" loading={regenerate.isPending} onClick={onRegenerate}>
          <RefreshCw className="size-4" aria-hidden="true" />
          Rebuild
        </Button>

        {/*
          Offered whether or not a set exists. A set is computed once, at submit, against the
          catalog as it stood that day — so every college an administrator adds afterwards is
          invisible to this student until this is pressed. That is the ordinary case, not an error.
        */}
        <span className="text-xs text-muted-foreground">
          {set
            ? `Computed ${new Date(set.generated_at).toLocaleString()}. Rebuild to include catalog entries added since.`
            : 'Rebuilding is safe to press at any time — it replaces the set rather than adding to it.'}
        </span>
      </div>
    </div>
  );
}

/**
 * One scored attempt with the §21 retake (deviation D8). Two-step with the warning spelled out,
 * because it **voids a result the student already produced**: the expired attempt is kept as
 * history, but it stops counting — and any recommendation it fed regenerates from what remains.
 */
function ResultRow({
  classId,
  name,
  result,
}: {
  classId: string;
  name: string;
  result: AssessmentResult;
}) {
  const reset = useResetAttempt(classId);
  const [confirming, setConfirming] = useState(false);

  const title = result.assessment?.title ?? 'Assessment';

  return (
    <li className="border border-border bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge className="normal-case">{title}</Badge>
          {result.submitted_at ? (
            <span className="text-xs text-muted-foreground">
              Submitted {new Date(result.submitted_at).toLocaleString()}
            </span>
          ) : null}
        </div>

        {confirming ? (
          <div className="flex items-center gap-2">
            <Button
              variant="danger"
              size="sm"
              loading={reset.isPending}
              onClick={() =>
                reset.mutate(result.attempt_id, { onSettled: () => setConfirming(false) })
              }
            >
              Yes, reset it
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirming(true)}
            aria-label={`Reset attempt: ${title}`}
          >
            <RotateCcw className="size-4" aria-hidden="true" />
            Reset attempt
          </Button>
        )}
      </div>

      {confirming ? (
        <Alert tone="warning" className="mt-3">
          Resetting voids this result — <strong>{name}</strong> will be able to retake{' '}
          <strong>{title}</strong>, and this score stops counting toward their recommendations.
          The old attempt is kept in the record.
        </Alert>
      ) : null}

      {reset.isError ? (
        <Alert className="mt-3">
          {reset.error instanceof Error ? reset.error.message : 'The reset failed.'}
        </Alert>
      ) : null}
    </li>
  );
}

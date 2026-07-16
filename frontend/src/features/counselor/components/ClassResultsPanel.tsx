import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useClassResults, useResetAttempt } from '@/features/counselor/hooks/useAssignments';
import type { AssessmentResult } from '@/types/assessment';

/**
 * The class results overview (FULLPLAN §37) with the §21 retake button — deviation D8,
 * closed in Phase 6.
 *
 * The reset is two-step with the warning spelled out, for the same reason closing an
 * assignment is: it **voids a result the student already produced**. The expired attempt is
 * kept as history, but it stops counting — and if it fed a recommendation, that
 * recommendation regenerates from whatever results remain.
 */
export function ClassResultsPanel({ classId }: { classId: string }) {
  const { data: results, isLoading, isError, error } = useClassResults(classId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Results</CardTitle>
        <CardDescription>
          Every scored attempt in this class. Resetting one lets that student retake the
          assessment — their previous answers stop counting.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {isLoading ? <p className="text-sm text-slate-500">Loading results…</p> : null}

        {/* D11's rule, applied from birth: a failed load is never an empty state. */}
        {isError ? <Alert>We could not load the results. {error.message}</Alert> : null}

        {results && results.length === 0 ? (
          <p className="text-sm text-slate-500">
            No results yet. They appear here as students submit.
          </p>
        ) : null}

        {(results ?? []).map((result) => (
          <ResultRow key={result.attempt_id} classId={classId} result={result} />
        ))}
      </CardContent>
    </Card>
  );
}

function ResultRow({ classId, result }: { classId: string; result: AssessmentResult }) {
  const reset = useResetAttempt(classId);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 font-medium text-slate-900">
            {result.student?.name ?? 'Student'}
            {result.student?.username ? (
              <span className="text-sm font-normal text-slate-400">
                {result.student.username}
              </span>
            ) : null}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-slate-600">
            {result.assessment ? <Badge className="normal-case">{result.assessment.title}</Badge> : null}
            {result.result?.result_code ? (
              <span className="font-mono font-medium text-slate-900">
                {result.result.result_code}
              </span>
            ) : null}
            {result.result?.overall_summary ? <span>{result.result.overall_summary}</span> : null}
          </p>
          {result.submitted_at ? (
            <p className="mt-0.5 text-xs text-slate-400">
              Submitted {new Date(result.submitted_at).toLocaleString()}
            </p>
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
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
            Reset attempt
          </Button>
        )}
      </div>

      {confirming ? (
        <Alert tone="warning" className="mt-3">
          Resetting voids this result — <strong>{result.student?.name ?? 'the student'}</strong>{' '}
          will be able to retake{' '}
          <strong>{result.assessment?.title ?? 'the assessment'}</strong>, and this score stops
          counting toward their recommendations. The old attempt is kept in the record.
        </Alert>
      ) : null}

      {reset.isError ? (
        <Alert className="mt-3">
          {reset.error instanceof Error ? reset.error.message : 'The reset failed.'}
        </Alert>
      ) : null}
    </div>
  );
}

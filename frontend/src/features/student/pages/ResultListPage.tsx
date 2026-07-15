import { useNavigate } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useResults } from '@/features/student/hooks/useAssessment';
import { resultPath } from '@/routes/paths';

/**
 * "My results" (FULLPLAN §37).
 *
 * Only SCORED attempts appear (§21). An attempt that was abandoned, or that a counselor reset to
 * permit a retake, is history and never shows up here — which is what makes this list something a
 * student can trust: everything on it is a result, and there is exactly one per assessment.
 */
export function ResultListPage() {
  const { data: results, isLoading, isError, error } = useResults();
  const navigate = useNavigate();

  if (isLoading) return <p className="text-sm text-slate-500">Loading your results…</p>;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">My results</h1>
        <p className="text-sm text-slate-500">
          These are computed directly from your answers. No AI is involved anywhere in them.
        </p>
      </div>

      {/* D11 — a failed load must not be reported as "no results". See AssessmentListPage. */}
      {isError ? <Alert>{error.message}</Alert> : null}

      {results && results.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No results yet</CardTitle>
            <CardDescription>
              Finish an assessment and your result will appear here straight away.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <div className="flex flex-col gap-4">
        {(results ?? []).map((result) => (
          <Card key={result.attempt_id}>
            <CardContent className="flex flex-wrap items-center justify-between gap-4 pt-6">
              <div>
                <p className="font-medium text-slate-900">{result.assessment?.title}</p>
                <p className="mt-0.5 text-sm text-slate-500">
                  {/* RIASEC shows its code; SCCT shows its sentence (§22, §23). */}
                  {result.result?.result_code
                    ? `Holland Code: ${result.result.result_code}`
                    : result.result?.overall_summary}
                </p>
              </div>

              <Button variant="secondary" onClick={() => navigate(resultPath(result.attempt_id))}>
                See breakdown
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

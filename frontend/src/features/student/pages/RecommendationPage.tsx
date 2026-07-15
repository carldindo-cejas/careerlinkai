import { useNavigate } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  useExplainRecommendation,
  useMyRecommendations,
} from '@/features/student/hooks/useRecommendations';
import { paths } from '@/routes/paths';
import type { CareerRecommendation, ProgramRecommendation } from '@/types/recommendation';

/**
 * "My recommendations" (FULLPLAN §37, Phase 4).
 *
 * Every number on this page was computed by ordinary arithmetic with a known formula (§27) and can
 * be reproduced from the same inputs (§26). **No AI is involved anywhere in it**, and the page says
 * so — not as a disclaimer, but because §3's first principle is that a student is never told "the
 * AI recommends this". Phase 5a will add an "Explain more" button that calls a model; the reason
 * text already on every card is not that, and does not depend on it.
 *
 * Careers and programs are two separate lists because they are two separate rankings: their scores
 * come from different formulas with different weights (§27), so a career at 69.1 and a program at
 * 76.1 are not two entries in one league table. Interleaving them would invent a comparison the
 * engine never made.
 */
export function RecommendationPage() {
  const { data: set, isLoading, isError, error } = useMyRecommendations();
  const navigate = useNavigate();

  if (isLoading) {
    return <p className="text-sm text-slate-500">Working out your recommendations…</p>;
  }

  // D11's rule, applied from the start on this screen rather than retrofitted onto it: a failed
  // load is not an empty one. The three states below are genuinely different and look different.
  if (isError) {
    return (
      <Alert>
        We could not load your recommendations. {error.message} Try refreshing — your results are
        safe either way.
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">My recommendations</h1>
        <p className="text-sm text-slate-500">
          Ranked from your RIASEC interests, your SCCT confidence, and your academic profile. Every
          score here is calculated — no AI decided any of it.
        </p>
      </div>

      {/*
        `!set` rather than `set === null`: TanStack types `data` as `T | undefined` on top of the
        API's own `null`, and both mean the same thing here — nothing to show. Distinguishing them
        would be distinguishing "the server said you have none" from "the query has not resolved",
        and the isLoading branch above has already ruled the second one out.
      */}
      {!set ? (
        <Card>
          <CardHeader>
            <CardTitle>Not yet — finish both assessments</CardTitle>
            <CardDescription>
              Recommendations need <strong>both</strong> your RIASEC interest profile and your SCCT
              confidence scores. Complete whichever you have left and they will appear here
              straight away.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => navigate(paths.studentAssessments)}>
              Go to my assessments
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <section className="flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Careers</h2>
              <p className="text-sm text-slate-500">
                Matched against your interest profile and your confidence scores.
              </p>
            </div>

            {set.careers.map((recommendation) => (
              <CareerCard key={recommendation.id} recommendation={recommendation} />
            ))}
          </section>

          <section className="flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Programs</h2>
              <p className="text-sm text-slate-500">
                These also weigh your strand and your general weighted average — which is why a
                program can rank differently from the careers it leads to.
              </p>
            </div>

            {set.programs.map((recommendation) => (
              <ProgramCard key={recommendation.id} recommendation={recommendation} />
            ))}
          </section>
        </>
      )}
    </div>
  );
}

/**
 * The match score, shown as a percentage with its rank.
 *
 * It is deliberately not a progress bar or a five-star rating. §27 produces a number on a defined
 * 0–100 scale from a stated formula, and rendering it as four-and-a-half stars would throw away
 * precision the engine was careful to preserve (§28 carries components unrounded specifically so
 * the composite is not compounded).
 */
function MatchScore({ score, rank }: { score: number; rank: number }) {
  return (
    <div className="flex flex-col items-end">
      <span className="text-2xl font-semibold text-slate-900">{score.toFixed(1)}%</span>
      <Badge tone={rank === 1 ? 'success' : undefined}>
        {rank === 1 ? 'Best match' : `#${rank}`}
      </Badge>
    </div>
  );
}

/**
 * "Explain more" (§30, Phase 5a) — the one place on this page a model speaks, and it is
 * visually and verbally separate from the computed numbers above it.
 *
 * The fallback is not an error state. When the AI cannot answer — nothing relevant in the
 * knowledge base, the daily quota spent, the model down — the card simply keeps the
 * deterministic reason it already shows, and says so. §29: the paragraph is an enhancement,
 * never a dependency.
 */
function ExplainMore({ recommendationId }: { recommendationId: string }) {
  const explain = useExplainRecommendation();

  if (explain.data?.explanation) {
    return (
      <div className="rounded-md bg-slate-50 p-3">
        <p className="text-sm text-slate-700">{explain.data.explanation.explanation_text}</p>
        <p className="mt-1 text-xs text-slate-400">
          AI-generated from the school&apos;s guidance materials — the scores above are computed,
          not AI.
        </p>
      </div>
    );
  }

  if (explain.data && explain.data.explanation === null) {
    return (
      <p className="text-sm text-slate-500">
        An AI explanation isn&apos;t available right now — the reason above is the computed one
        and still stands.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          variant="secondary"
          disabled={explain.isPending}
          onClick={() => explain.mutate(recommendationId)}
        >
          {explain.isPending ? 'Asking…' : 'Explain more'}
        </Button>
      </div>
      {explain.isError ? (
        <p className="text-sm text-slate-500">
          We couldn&apos;t reach the explanation service. {explain.error.message}
        </p>
      ) : null}
    </div>
  );
}

function CareerCard({ recommendation }: { recommendation: CareerRecommendation }) {
  const { career } = recommendation;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            {career.title}
            {/*
              The Holland code is shown, not hidden. A student who can see that this career reads as
              "IEC" and that their own code is "IAR" can reason about *why* it ranked where it did —
              which is the difference between an explanation and an assertion.
            */}
            {career.typical_riasec_code ? <Badge>{career.typical_riasec_code}</Badge> : null}
          </CardTitle>
          {career.description ? <CardDescription>{career.description}</CardDescription> : null}
        </div>

        <MatchScore score={recommendation.match_score} rank={recommendation.ranking} />
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-slate-600">{recommendation.reason}</p>

        {career.salary_range || career.employment_outlook ? (
          <p className="text-sm text-slate-500">
            {career.salary_range}
            {career.salary_range && career.employment_outlook ? ' · ' : null}
            {career.employment_outlook}
          </p>
        ) : null}

        <ExplainMore recommendationId={recommendation.id} />
      </CardContent>
    </Card>
  );
}

function ProgramCard({ recommendation }: { recommendation: ProgramRecommendation }) {
  const { program, college } = recommendation;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            {program.name}
            <Badge>{program.code}</Badge>
          </CardTitle>
          {/*
            §13.6: the college is a real join, not a text match — so it can be named with
            confidence. "BS Computer Science" without an institution is not an answer to the
            question the student is actually asking.
          */}
          <CardDescription>
            {college.name}
            {program.department_name ? ` · ${program.department_name}` : null}
          </CardDescription>
        </div>

        <MatchScore score={recommendation.match_score} rank={recommendation.ranking} />
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-slate-600">{recommendation.reason}</p>

        {program.recommended_strand ? (
          <p className="text-sm text-slate-500">
            Typically taken by <strong>{program.recommended_strand}</strong> students.
          </p>
        ) : null}

        <ExplainMore recommendationId={recommendation.id} />
      </CardContent>
    </Card>
  );
}

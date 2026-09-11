import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAiInsights } from '@/features/admin/hooks/useAiKnowledge';
import { paths } from '@/routes/paths';
import type { CoverageGap, UnansweredQuestion } from '@/types/ai';

/**
 * **What the AI could not answer** (AiNormalisation Phase 4).
 *
 * The screen this whole plan builds towards. Every honest refusal the assistant makes already
 * records the exact question a student asked — that has been true since Phase 5a and nobody had
 * ever looked at it. Here it is, ranked by how many students asked, with a button that carries the
 * question straight into the answer form.
 *
 * The loop it closes: a student asks something nothing covers → the system refuses honestly rather
 * than inventing → the gap appears here → an admin writes one answer → the next student to ask
 * gets that answer word for word, from Gate 1, with no model call at all. After a term of use the
 * common questions are all answered by a human, deterministically, for free.
 *
 * Migration 0030 adds the student's own voice to the ranking. The refusal now carries a *"Request
 * to add to knowledge"* button, and a question somebody pressed it on sorts above one the pipeline
 * merely failed on more often — a count of retrieval misses is a measure of the corpus, while a
 * request is a measure of what a student actually needed and did not get.
 */
export function AiInsightsPage() {
  const { data, isLoading, isError, error } = useAiInsights();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">What the AI could not answer</h1>
        <p className="text-sm text-muted-foreground">
          Questions students asked that the knowledge base did not cover. Answering the ones at the
          top means the next student who asks gets your exact words back — no guessing, and no cost.
        </p>
      </div>

      {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {isError ? <Alert>We could not load the report. {error.message}</Alert> : null}

      {data ? (
        <>
          <CorpusHealth corpus={data.corpus} />
          <UnansweredList questions={data.unanswered_questions} />
          <CoverageCard coverage={data.coverage} />
          <FlaggedList answers={data.flagged_answers} />
        </>
      ) : null}
    </div>
  );
}

/**
 * The state of the corpus in four numbers.
 *
 * `embedded` versus `chunks` is the one that earns its place: text that exists but has no vector
 * is text the AI **cannot retrieve**, and it looks identical to healthy content in every other
 * list in this app. A gap between those two numbers is the only place it shows up.
 */
function CorpusHealth({
  corpus,
}: {
  corpus: { entries: number; chunks: number; embedded: number; failed: number };
}) {
  const pending = corpus.chunks - corpus.embedded;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Knowledge base</CardTitle>
        <CardDescription>
          {corpus.entries} entries · {corpus.embedded} of {corpus.chunks} passages searchable
          {pending > 0 ? ` · ${pending} still being read` : null}
          {corpus.failed > 0 ? ` · ${corpus.failed} failed` : null}
        </CardDescription>
      </CardHeader>
      {corpus.failed > 0 ? (
        <CardContent>
          <Alert>
            {corpus.failed} {corpus.failed === 1 ? 'entry' : 'entries'} failed to process, so their
            content is not searchable. Open Knowledge and press Reprocess on each — it is safe to
            run more than once.
          </Alert>
        </CardContent>
      ) : null}
    </Card>
  );
}

function UnansweredList({ questions }: { questions: UnansweredQuestion[] }) {
  const navigate = useNavigate();

  if (questions.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Nothing unanswered</CardTitle>
          <CardDescription>
            Every question students have asked so far was covered. This list fills itself as they
            ask — check back after a class has used the assistant.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Unanswered questions</CardTitle>
        <CardDescription>
          Questions students asked for first, then most-asked. Answer the top few.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {questions.map((row) => (
          <div
            key={row.question}
            className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3 last:border-0 last:pb-0"
          >
            <div className="min-w-0">
              <p className="text-sm text-foreground">{row.question}</p>
              <p className="text-xs text-muted-foreground">
                Asked {row.asks} {row.asks === 1 ? 'time' : 'times'} · last{' '}
                {new Date(row.last_asked_at).toLocaleString()}
              </p>
              {/*
                The one signal on this screen a person volunteered (migration 0030). Every other
                number here is the pipeline counting its own failures; this is a student reading a
                refusal and pressing "Request to add to knowledge" on it. It sorts these rows, and
                it is worth saying so rather than leaving an unexplained ordering.
              */}
              {row.requests > 0 ? (
                <p className="mt-1 text-xs font-medium text-foreground">
                  {row.requests} {row.requests === 1 ? 'student' : 'students'} asked you to answer
                  this
                </p>
              ) : null}
            </div>
            {/*
              The button that closes the loop. It carries the question into the Q&A form so the
              admin types an answer and nothing else — the difference between a report someone
              reads and a report someone acts on.
            */}
            <Button
              variant="secondary"
              onClick={() =>
                navigate(`${paths.adminKnowledge}?answer=${encodeURIComponent(row.question)}`)
              }
            >
              Answer this
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function CoverageCard({
  coverage,
}: {
  coverage: {
    careers: { total: number; covered: number };
    programs: { total: number; covered: number };
    gaps: CoverageGap[];
  };
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Catalog coverage</CardTitle>
        <CardDescription>
          {coverage.careers.covered} of {coverage.careers.total} careers and{' '}
          {coverage.programs.covered} of {coverage.programs.total} programs have something in the
          knowledge base about them. The target is all of them — that is what lets{' '}
          <strong>Explain more</strong> say something specific.
        </CardDescription>
      </CardHeader>
      {coverage.gaps.length > 0 ? (
        <CardContent className="flex flex-col gap-2">
          {coverage.gaps.map((gap) => (
            <div key={`${gap.kind}-${gap.id}`} className="flex items-center gap-2 text-sm">
              <Badge>{gap.kind === 'career' ? 'Career' : 'Program'}</Badge>
              <span className="min-w-0 truncate text-foreground/90">{gap.label}</span>
              {/*
                Two different problems, so they are labelled differently: a stalled entry is one
                Reprocess away from fixed, while a missing one needs the catalog sync to run.
              */}
              {gap.stalled ? (
                <span className="text-xs text-muted-foreground">entry failed to process</span>
              ) : (
                <span className="text-xs text-muted-foreground">no entry yet — run a sync</span>
              )}
            </div>
          ))}
        </CardContent>
      ) : null}
    </Card>
  );
}

function FlaggedList({
  answers,
}: {
  answers: {
    message_id: string;
    answer: string;
    question: string | null;
    chunk_ids: string[];
    created_at: string | null;
  }[];
}) {
  const [open, setOpen] = useState<string | null>(null);

  if (answers.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Answers students marked wrong</CardTitle>
        <CardDescription>
          Each one names the passages it was built from. Read the answer, find the entry that
          produced it, and correct or archive it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {answers.map((row) => (
          <div key={row.message_id} className="border-b border-border pb-3 last:border-0 last:pb-0">
            {row.question ? (
              <p className="text-sm text-foreground">{row.question}</p>
            ) : null}
            <button
              type="button"
              className="mt-1 text-left text-sm text-muted-foreground underline-offset-4 hover:underline"
              aria-expanded={open === row.message_id}
              onClick={() => setOpen((current) => (current === row.message_id ? null : row.message_id))}
            >
              {open === row.message_id ? row.answer : `${row.answer.slice(0, 140)}…`}
            </button>
            <p className="text-xs text-muted-foreground">
              {row.created_at ? new Date(row.created_at).toLocaleString() : null}
              {row.chunk_ids.length > 0 ? ` · ${row.chunk_ids.length} passages used` : ' · no passages used'}
            </p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

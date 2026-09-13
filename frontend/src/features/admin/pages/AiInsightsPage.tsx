import { useMemo, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import {
  useAiInsights,
  useCatalogCoverage,
  useCreateKnowledgeEntry,
  useDismissQuestion,
  useFlaggedAnswers,
  useKnowledgeScope,
  useReopenQuestion,
  useResolvedQuestions,
  useUnansweredQuestions,
} from '@/features/admin/hooks/useAiKnowledge';
import { similarQuestions } from '@/features/admin/utils/similarQuestions';
import { toast } from '@/stores/toastStore';
import type { AiInsights } from '@/types/ai';

/**
 * **What the AI could not answer** (AiNormalisation Phase 4, migration 0031).
 *
 * The screen the whole plan builds towards. Every honest refusal the assistant makes already
 * records the exact question a student asked — that has been true since Phase 5a and nobody had
 * ever looked at it. Here it is, ranked, with a button that carries the question straight into the
 * answer form.
 *
 * The loop it closes: a student asks something nothing covers → the system refuses honestly rather
 * than inventing → the gap appears here → somebody writes one answer → the next student to ask
 * gets that answer word for word, from Gate 1, with no model call at all. After a term of use the
 * common questions are all answered by a human, deterministically, for free.
 *
 * ## What migration 0031 fixed here
 *
 * The loop had no closing half. Answering a question wrote the entry and changed nothing on this
 * screen: the question stayed at the top of the list with its ask count intact, looking exactly
 * like the ones nobody had touched. A backlog that cannot be cleared is a backlog people stop
 * reading, and this was the most valuable screen in the module quietly becoming unusable after a
 * fortnight of real use.
 *
 * Now the answer is recorded against the question, the row goes, and the three ways that could be
 * wrong all surface rather than hide — an archived entry, a failed one, or a question asked again
 * anyway each bring it back, the last of them flagged, because *"this is answered and they are
 * still asking"* is a different problem from *"nobody has written this yet"*.
 *
 * ## One screen, two roles
 *
 * Counselors contribute to the same corpus. They see the questions **their own students** asked
 * and the answers they themselves wrote; an admin sees the platform. Every difference is decided
 * by the server and arrives in `can` — nothing here branches on a role string, because a client
 * that works out its own permissions is a client that renders a button the API refuses.
 */
/**
 * Which list is on screen. The corpus header sits above all four and never moves.
 *
 * `coverage` is admin-only — the server hands a counselor an empty report because the only fix for
 * a gap in it is the sync button on the admin's screen — so the tab is omitted rather than shown
 * empty, which would read as "nothing is missing" rather than "this is not yours to fix".
 */
type InsightsTab = 'unanswered' | 'resolved' | 'flagged' | 'coverage';

export function AiInsightsPage() {
  const [tab, setTab] = useState<InsightsTab>('unanswered');
  const { data, isLoading, isError, error } = useAiInsights();
  const scope = useKnowledgeScope();

  const tabs: { id: InsightsTab; label: string; count: number | undefined }[] = [
    { id: 'unanswered', label: 'Unanswered', count: data?.counts.unanswered },
    { id: 'resolved', label: 'Already dealt with', count: data?.counts.resolved },
    { id: 'flagged', label: 'Marked wrong', count: data?.counts.flagged },
    // Admin-only: the server hands a counselor an empty coverage report, and an empty tab would
    // read as "nothing is missing" rather than "this is not yours to fix".
    ...(data?.can.sync_catalog
      ? [{ id: 'coverage' as const, label: 'Catalog coverage', count: undefined }]
      : []),
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">What the AI could not answer</h1>
        <p className="text-sm text-muted-foreground">
          {scope === 'admin'
            ? 'Questions students asked that the knowledge base did not cover.'
            : 'Questions your students asked that the knowledge base did not cover.'}{' '}
          Answering the ones at the top means the next student who asks gets your exact words back —
          no guessing, and no cost.
        </p>
      </div>

      {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {isError ? <Alert>We could not load the report. {error.message}</Alert> : null}

      {data ? (
        <>
          <CorpusHealth corpus={data.corpus} mine={!data.can.see_all_knowledge} />

          {data.gates ? <GateDistribution days={data.gates.days} /> : null}

          {/*
            A tablist of plain buttons rather than a `Tabs` primitive: `components/ui` has none, and
            adding one for a single screen is more surface than the four buttons it would replace.
            The roles and `aria-selected` are what a screen reader needs; `aria-controls` points at
            the panel below so the relationship survives the visual grouping.
          */}
          <div role="tablist" aria-label="Report sections" className="flex flex-wrap gap-2 border-b border-border">
            {tabs.map((entry) => (
              <button
                key={entry.id}
                role="tab"
                type="button"
                id={`insights-tab-${entry.id}`}
                aria-selected={tab === entry.id}
                aria-controls="insights-panel"
                /*
                  Named explicitly rather than left to the button's contents. The count sits in its
                  own span with a margin for the visual gap, and the accessible name computed from
                  that runs the two together — so a screen reader announces "Unanswered30". The
                  label still starts with the visible text, which is what WCAG's label-in-name rule
                  asks for.
                */
                aria-label={entry.count === undefined ? entry.label : `${entry.label}, ${entry.count}`}
                className={
                  tab === entry.id
                    ? 'border-b-2 border-foreground px-3 py-2 text-sm font-medium text-foreground'
                    : 'border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground'
                }
                onClick={() => setTab(entry.id)}
              >
                {entry.label}
                {entry.count !== undefined && entry.count > 0 ? (
                  <span aria-hidden="true" className="ml-1.5 text-xs text-muted-foreground">
                    ({entry.count})
                  </span>
                ) : null}
              </button>
            ))}
          </div>

          <div id="insights-panel" role="tabpanel" aria-labelledby={`insights-tab-${tab}`}>
            {tab === 'unanswered' ? <UnansweredTab can={data.can} /> : null}
            {tab === 'resolved' ? <ResolvedTab /> : null}
            {tab === 'flagged' ? <FlaggedTab /> : null}
            {tab === 'coverage' ? <CoverageTab /> : null}
          </div>
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
 *
 * A counselor is shown their own contributions rather than the platform total — a "3 failed"
 * banner about somebody else's uploads is a banner they can do nothing about.
 */
function CorpusHealth({
  corpus,
  mine,
}: {
  corpus: { entries: number; chunks: number; embedded: number; failed: number };
  mine: boolean;
}) {
  const pending = corpus.chunks - corpus.embedded;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{mine ? 'What you have added' : 'Knowledge base'}</CardTitle>
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

/**
 * How the assistant answered over the last two weeks (AI-COVERAGE-PLAN.md Phase 6).
 *
 * The coverage measure the plan targets: answers from an admin's words, from exact lookups, and from
 * grounded generation, against refusals. Lookups and curated answers cost no model call, so their
 * share is also the share of the day's neuron budget left untouched.
 */
function GateDistribution({
  days,
}: {
  days: {
    date: string;
    curated: number;
    lookup: number;
    generated: number;
    refused: number;
    total: number;
    tokens: number;
  }[];
}) {
  const sum = (key: 'curated' | 'lookup' | 'generated' | 'refused' | 'total' | 'tokens') =>
    days.reduce((total, day) => total + day[key], 0);
  const total = sum('total');
  const share = (value: number) => (total === 0 ? '0%' : `${Math.round((value / total) * 100)}%`);
  const rows: { label: string; value: number }[] = [
    { label: 'Your school’s answers', value: sum('curated') },
    { label: 'Looked up (catalog or results)', value: sum('lookup') },
    { label: 'Written from sources', value: sum('generated') },
    { label: 'Not answered', value: sum('refused') },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>How the assistant answered</CardTitle>
        <CardDescription>
          Last 14 days · {total} answers · {sum('tokens').toLocaleString()} model tokens used
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {rows.map((row) => (
            <div key={row.label} className="border border-border px-3 py-2">
              <dt className="text-xs text-muted-foreground">{row.label}</dt>
              <dd className="text-lg font-semibold tabular-nums text-foreground">
                {row.value}{' '}
                <span className="text-xs font-normal text-muted-foreground">{share(row.value)}</span>
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

/**
 * The backlog tab — one page of open questions, newest-and-most-asked first.
 *
 * It fetches its own page rather than being handed rows, which is what lets the pager live inside
 * it: the page number is state nobody outside this component needs, and hoisting it would put a
 * number belonging to one tab in the state of a screen with four.
 */
function UnansweredTab({ can }: { can: AiInsights['can'] }) {
  const [page, setPage] = useState(1);
  const { data, isLoading, isFetching, isError, error } = useUnansweredQuestions(page);
  const questions = data?.items ?? [];
  const dismiss = useDismissQuestion();
  const [dismissing, setDismissing] = useState<string | null>(null);
  /**
   * The one row whose answer form is open, by normalised key, or null.
   *
   * One at a time rather than a set: two half-written answers on screen is two things to lose track
   * of, and the backlog is worked through in order anyway.
   */
  const [answering, setAnswering] = useState<string | null>(null);
  /**
   * Likely rephrasings of each row, among the rows on screen (found testing on production: "Where
   * is Holy Name University located?", "HNU located" and "location of HNU" were three rows). They
   * are carried into the answer form as *suggestions* — see `similarQuestions` for why nothing
   * here is ever resolved automatically.
   */
  const siblings = useMemo(() => {
    const texts = questions.map((row) => row.question);

    return new Map(questions.map((row) => [row.key, similarQuestions(row.question, texts)]));
  }, [questions]);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading questions…</p>;
  }

  if (isError) {
    return <Alert>We could not load the backlog. {error.message}</Alert>;
  }

  if (questions.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Nothing unanswered</CardTitle>
          <CardDescription>
            Every question students have asked so far was covered, or has been dealt with. This list
            fills itself as they ask — check back after a class has used the assistant.
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
            // The normalised key, not the display text: two spellings are deliberately one row,
            // and keying on the shown wording would make React's identity disagree with the
            // report's whenever the merge picked a different spelling on a refetch.
            key={row.key}
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

              {/*
                Migration 0031's most useful row, and the one that most needs explaining.

                There *is* an answer to this question in the corpus and students are still being
                refused — so the retrieval is not finding it, and writing a second entry would be
                wasted work that makes the corpus harder to maintain. Saying "asked again" without
                saying what to do instead would reliably produce exactly that duplicate.
              */}
              {(siblings.get(row.key)?.length ?? 0) > 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Possibly also asked as {siblings.get(row.key)!.length} other{' '}
                  {siblings.get(row.key)!.length === 1 ? 'question' : 'questions'} on this list — you
                  can mark them answered in the same step.
                </p>
              ) : null}

              {row.answered_at !== null ? (
                // `warning` rather than `info`: this is the one row on the screen where the
                // obvious action — write an answer — is the wrong one, so it needs more weight
                // than ambient context. Not `danger`, which takes `role="alert"` and would make a
                // screen reader interrupt itself once per row.
                <Alert tone="warning" className="mt-2">
                  Already answered on {new Date(row.answered_at).toLocaleDateString()}, and asked{' '}
                  {row.asks} more {row.asks === 1 ? 'time' : 'times'} since. The answer exists but
                  the assistant is not finding it — open the existing entry and reword it closer to
                  how students ask, rather than adding a second one.
                </Alert>
              ) : null}
            </div>

            <div className="flex shrink-0 gap-2">
              {/*
                **The button that closes the loop — and it no longer leaves this page.**

                It used to navigate to /knowledge with the question in the query string. That worked
                and it cost the reader their place: a backlog is worked through in order, and going
                to another screen to answer the fourth question meant coming back to page one of a
                list that had since re-sorted, to find where you were. Answering three questions in
                a row was three round trips through a screen nobody wanted to be on.

                The form opens underneath this row instead. Same entry, same resolution, same
                corpus — the only thing that changed is that the backlog stays on screen while it
                is being cleared.
              */}
              <Button
                variant="secondary"
                aria-expanded={answering === row.key}
                onClick={() => setAnswering((current) => (current === row.key ? null : row.key))}
              >
                {answering === row.key
                  ? 'Close'
                  : row.answered_at === null
                    ? 'Answer this'
                    : 'Answer again'}
              </Button>

              {/*
                Gibberish, tests and off-domain questions. Without this they sit here for the life
                of the deployment, and a backlog with permanent residents at the top is one nobody
                scrolls past.

                Two presses rather than a confirm dialog: a dismissal never lapses on its own, so
                it deserves more friction than a single click, and less than a modal for something
                that is undone from the list below in one click.
              */}
              {can.dismiss_questions ? (
                <Button
                  variant="secondary"
                  disabled={dismiss.isPending}
                  onClick={() => {
                    if (dismissing !== row.key) {
                      setDismissing(row.key);

                      return;
                    }

                    setDismissing(null);
                    dismiss.mutate(row.question);
                  }}
                  onBlur={() => setDismissing((current) => (current === row.key ? null : current))}
                >
                  {dismissing === row.key ? 'Sure?' : 'Not a question'}
                </Button>
              ) : null}
            </div>

            {/*
              The answer form, in place. Full width below the row rather than beside it, because an
              answer is a paragraph and the row is two columns of summary.
            */}
            {answering === row.key ? (
              <AnswerInline
                question={row.question}
                similar={siblings.get(row.key) ?? []}
                onDone={() => setAnswering(null)}
              />
            ) : null}
          </div>
        ))}

        {/*
          A pager, where this used to be a "Show more" button that refetched every row already on
          screen to reveal the next twenty-five. On a backlog of any size that turned reading page
          four into downloading pages one through four.
        */}
        {data ? (
          <Pagination
            pagination={data.pagination}
            onPageChange={setPage}
            noun="questions"
            isFetching={isFetching}
          />
        ) : null}

        {dismiss.isError ? <Alert>{dismiss.error.message}</Alert> : null}
      </CardContent>
    </Card>
  );
}

/**
 * **Answering a backlog question without leaving the backlog** (prompt-driven).
 *
 * This is the whole loop in one place: the question a student asked, a box to answer it in, and the
 * rephrasings it probably shares an answer with. Saving writes the knowledge entry and records the
 * resolution in the same request, so the row disappears from the list above it.
 *
 * ## The one subtle thing, and it is load-bearing
 *
 * `resolves_question` is the question **as the report worded it** — the `question` prop — and never
 * whatever the author finally typed into the box. The first thing anybody does with a student's
 * question is tidy it up, and keying the resolution off the tidied version keys it to text no
 * refusal ever recorded: the entry saves, the backlog item never clears, and the bug this closes
 * comes back wearing a resolutions row that claims it was handled.
 */
function AnswerInline({
  question,
  similar,
  onDone,
}: {
  question: string;
  /** Likely rephrasings on this page, offered as suggestions — never resolved automatically. */
  similar: string[];
  onDone: () => void;
}) {
  const create = useCreateKnowledgeEntry();
  const [answer, setAnswer] = useState('');
  /** Unticked by default, always: the matcher cannot tell "Cebu" from "Bohol". */
  const [alsoResolves, setAlsoResolves] = useState<string[]>([]);

  const empty = answer.trim().length === 0;

  async function save(event: React.FormEvent) {
    event.preventDefault();

    if (empty || create.isPending) {
      return;
    }

    try {
      await create.mutateAsync({
        type: 'qa',
        question,
        answer: answer.trim(),
        resolves_question: question,
        ...(alsoResolves.length === 0 ? {} : { also_resolves: alsoResolves }),
      });

      const cleared = 1 + alsoResolves.length;

      toast.success(
        cleared === 1
          ? 'Answered. The question is off the list — it comes back by itself if students keep asking.'
          : `Answered. ${cleared} questions are off the list — each comes back by itself if students keep asking.`,
      );
      onDone();
    } catch {
      // Rendered below from `create.error`; the form stays open with the text intact.
    }
  }

  return (
    <form className="mt-3 w-full border-t border-border pt-3" onSubmit={(event) => void save(event)}>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Your answer</span>
        <textarea
          className="min-h-24 border border-border bg-background px-3 py-2 text-sm"
          value={answer}
          maxLength={1200}
          autoFocus
          placeholder="Answer it the way you would say it to the student. This exact text is what the AI replies with."
          onChange={(event) => setAnswer(event.target.value)}
        />
        <span className="text-xs text-muted-foreground">
          Saved as a question-and-answer pair, so the next student who asks gets these words back
          verbatim — no model call, and nothing invented. {1200 - answer.length} characters left.
        </span>
      </label>

      {/*
        The siblings the report found. Opt-in, one tick each: a lexical match is a suggestion, and a
        wrong resolution would hide a real gap from the one screen built to show it.
      */}
      {similar.length > 0 ? (
        <fieldset className="mt-3 flex flex-col gap-2 border border-border p-3 text-sm">
          <legend className="px-1 font-medium">Also asked as — tick any this answer covers</legend>
          {similar.map((sibling) => (
            <label key={sibling} className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={alsoResolves.includes(sibling)}
                onChange={(event) =>
                  setAlsoResolves((current) =>
                    event.target.checked
                      ? [...current, sibling]
                      : current.filter((item) => item !== sibling),
                  )
                }
              />
              <span>{sibling}</span>
            </label>
          ))}
          <span className="text-xs text-muted-foreground">
            Only tick questions this answer really covers — two questions can look alike and ask
            different things, like the same course in Cebu and in Bohol.
          </span>
        </fieldset>
      ) : null}

      {create.isError ? <Alert className="mt-3">{create.error.message}</Alert> : null}

      <div className="mt-3 flex gap-2">
        <Button type="submit" disabled={empty} loading={create.isPending}>
          Save answer
        </Button>
        <Button type="button" variant="ghost" onClick={onDone} disabled={create.isPending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * What has already been dealt with — the other half of a backlog, and the undo for both ways of
 * leaving it.
 *
 * The `live: false` rows are why this is worth a section rather than a counter. A resolution
 * lapses silently when its entry is archived or fails to process: the question returns to the list
 * above, and without this nothing would ever say *why* an answer somebody wrote stopped counting.
 */
function ResolvedTab() {
  const [page, setPage] = useState(1);
  const { data, isLoading, isFetching, isError, error } = useResolvedQuestions(page);
  const questions = data?.items ?? [];
  const reopen = useReopenQuestion();

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  if (isError) {
    return <Alert>We could not load this list. {error.message}</Alert>;
  }

  /*
    This used to `return null` when empty, because it was one card in a stack and an empty card was
    just noise. As a tab it has to say something: a tab somebody clicked that renders nothing reads
    as a broken screen rather than an empty list.
  */
  if (questions.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Nothing dealt with yet</CardTitle>
          <CardDescription>
            Questions you answer or set aside from the Unanswered tab appear here, with a way to put
            them back.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Already dealt with</CardTitle>
        <CardDescription>
          Questions that have been answered or set aside. Putting one back returns it to the
          Unanswered tab with its original count — nothing is lost by changing your mind.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {questions.map((row) => (
          <div
            key={row.id}
            className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3 last:border-0 last:pb-0"
          >
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm text-foreground">
                <Badge tone={row.resolution === 'ANSWERED' ? 'success' : undefined}>
                  {row.resolution === 'ANSWERED' ? 'Answered' : 'Set aside'}
                </Badge>
                <span className="min-w-0">{row.question}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                {row.resolved_by_name} ({row.resolved_by_role}) ·{' '}
                {new Date(row.resolved_at).toLocaleString()}
                {row.document_title ? ` · ${row.document_title}` : null}
              </p>

              {/*
                The silent failure this section exists to make loud. The entry behind this answer
                is archived or never finished processing, so it covers nothing and the question is
                already back on the list above — which would otherwise look like the backlog
                spontaneously regrowing.
              */}
              {!row.live ? (
                // A fact about why this entry stopped counting, with the consequence stated. The
                // question is already back on the list above, so nothing is broken and nothing
                // needs doing here unless the archiving was a mistake.
                <Alert tone="info" className="mt-2">
                  The entry behind this is archived or failed to process, so it no longer answers
                  anything — the question is back on the unanswered list.
                </Alert>
              ) : null}
            </div>

            <Button
              variant="secondary"
              disabled={reopen.isPending}
              onClick={() => reopen.mutate(row.id)}
            >
              Put back
            </Button>
          </div>
        ))}

        {data ? (
          <Pagination
            pagination={data.pagination}
            onPageChange={setPage}
            noun="questions"
            isFetching={isFetching}
          />
        ) : null}

        {reopen.isError ? <Alert>{reopen.error.message}</Alert> : null}
      </CardContent>
    </Card>
  );
}

/**
 * Catalog coverage — fetched only when this tab is opened.
 *
 * That laziness is the point of the endpoint split: the report behind this runs a scan over every
 * career and program in the catalog, and it has no business running to render the backlog, which is
 * what the reader came for nine visits out of ten.
 */
function CoverageTab() {
  const { data: coverage, isLoading, isError, error } = useCatalogCoverage({ enabled: true });

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  if (isError || !coverage) {
    return <Alert>We could not load catalog coverage. {error?.message}</Alert>;
  }

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

/** Answers a student marked wrong. Fetched on open, like coverage, and for the same reason. */
function FlaggedTab() {
  const { data: answers, isLoading, isError, error } = useFlaggedAnswers({ enabled: true });
  const [open, setOpen] = useState<string | null>(null);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  if (isError || !answers) {
    return <Alert>We could not load these answers. {error?.message}</Alert>;
  }

  if (answers.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Nothing marked wrong</CardTitle>
          <CardDescription>
            When a student marks an answer wrong, it appears here with the passages it was built
            from — so you can correct or archive the entry that produced it.
          </CardDescription>
        </CardHeader>
      </Card>
    );
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

import {
  ChevronDown,
  ChevronUp,
  GraduationCap,
  Loader2,
  MapPin,
  RefreshCw,
  School,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { RecommendationChatPanel } from '@/features/student/components/RecommendationChatPanel';
import {
  useCareerPrograms,
  useExplainRecommendation,
  useMyRecommendations,
  useProgramColleges,
  useRegenerateMyRecommendations,
} from '@/features/student/hooks/useRecommendations';
import { paths } from '@/routes/paths';
import { toast } from '@/stores/toastStore';
import { formatSalaryRange } from '@/types/catalog';
import type {
  CareerRecommendation,
  CareerSort,
  ProgramRecommendation,
} from '@/types/recommendation';

/**
 * "My recommendations" (FULLPLAN §37, Phase 4; extended 2026-07-27).
 *
 * Every number on this page was computed by ordinary arithmetic with a known formula (§27) and can
 * be reproduced from the same inputs (§26). **No AI produced any of it**, and the page says so —
 * not as a disclaimer, but because §3's first principle is that a student is never told "the AI
 * recommends this". The "Explain more" button and the assistant panel are the two places a model
 * speaks, and both are visually and verbally separate from the computed figures.
 *
 * Careers and programs are two separate lists because they are two separate rankings: their scores
 * come from different formulas with different weights (§27), so a career at 69.1 and a program at
 * 76.1 are not two entries in one league table. Interleaving them would invent a comparison the
 * engine never made.
 *
 * ## Three by default, five on request
 *
 * The engine persists ten of each (§27's `TOP_N`), and the page used to render all ten. A student
 * reading twenty ranked cards is not choosing between twenty things; they are being asked to hold
 * a shortlist in their head that nobody shortlisted for them. Three is a shortlist. The next two
 * are one click away, and the sort control below re-orders **the same five** rather than reaching
 * further into the list — which matters, because a sort that changed the membership of the set
 * would be a second ranking the engine never made.
 */
export function RecommendationPage() {
  const { data: set, isLoading, isError, error } = useMyRecommendations();
  const navigate = useNavigate();
  const regenerate = useRegenerateMyRecommendations();

  const [careerSort, setCareerSort] = useState<CareerSort>('match');

  /**
   * Rebuild, and say plainly which of the two outcomes happened (audit C4).
   *
   * A `null` result is not a failure — it means the student genuinely has not finished both
   * instruments — and reporting it as an error would send someone to their counselor over a state
   * that is working exactly as designed. The empty-state copy raises the possibility that
   * generation broke; this is where that possibility gets resolved one way or the other.
   */
  async function onRegenerate() {
    try {
      const rebuilt = await regenerate.mutateAsync();

      if (rebuilt === null) {
        toast.info('Finish both RIASEC and SCCT first — there is nothing to build yet.');
      } else {
        toast.success('Your recommendations have been rebuilt from your latest results.');
      }
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : 'Your recommendations could not be rebuilt.',
      );
    }
  }

  if (isLoading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Working out your recommendations…
      </p>
    );
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
    <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:gap-8">
      <div className="flex min-w-0 flex-1 flex-col gap-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-foreground">My recommendations</h1>
            <p className="text-sm text-muted-foreground">
              Ranked from your RIASEC interests, your SCCT confidence, and your academic profile.
              Every score here is calculated — no AI decided any of it.
            </p>
          </div>

          {/*
            Offered whenever a set exists, not only on failure (audit C4). A set is computed once,
            at submit, against the catalog as it stood that day — so every college or career an
            administrator adds afterwards is invisible here until this is pressed. That is the
            ordinary case, not an error, which is why this is a quiet secondary control in the
            header rather than an alert.
          */}
          {set ? (
            <Button
              variant="secondary"
              size="sm"
              loading={regenerate.isPending}
              onClick={onRegenerate}
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              Rebuild
            </Button>
          ) : null}
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
                Recommendations need <strong>both</strong> your RIASEC interest profile and your
                SCCT confidence scores. Complete whichever you have left and they will appear here
                straight away.
                {/*
                  Audit C4. This sentence exists because the screen used to be *wrong* for a whole
                  class of student: recommendations are generated by a listener whose failures are
                  deliberately swallowed, so a student who had finished both instruments could land
                  here and be told to go and do the thing they had already done, with no way out
                  but re-sitting sixty items. The button below is that way out, and this sentence is
                  what tells them the message above may not apply to them.
                */}{' '}
                <strong>Already finished both?</strong> Something went wrong on our side — try
                rebuilding them.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-3">
              <Button onClick={() => navigate(paths.studentAssessments)}>
                Go to my assessments
              </Button>
              <Button variant="secondary" loading={regenerate.isPending} onClick={onRegenerate}>
                <RefreshCw className="size-4" aria-hidden="true" />
                Rebuild my recommendations
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            <CollapsibleSection
              title="Careers"
              description="Matched against your interest profile and your confidence scores."
              items={set.careers}
              sort={
                <CareerSortControl value={careerSort} onChange={setCareerSort} />
              }
              order={careerSort}
              render={(recommendation) => (
                <CareerCard key={recommendation.id} recommendation={recommendation} />
              )}
            />

            <CollapsibleSection
              title="Programs"
              description="These also weigh your strand and your subject grades — which is why a program can rank differently from the careers it leads to."
              items={set.programs}
              render={(recommendation) => (
                <ProgramCard key={recommendation.id} recommendation={recommendation} />
              )}
            />
          </>
        )}
      </div>

      <RecommendationChatPanel hasRecommendations={Boolean(set)} />
    </div>
  );
}

/** Three shown, five available. See the page doc for why the ceiling is five and not ten. */
const DEFAULT_VISIBLE = 3;
const EXPANDED_VISIBLE = 5;

/**
 * One ranked section, collapsed to three.
 *
 * Generic over the two recommendation shapes rather than written twice: the collapse behaviour,
 * the counts and the copy are identical, and two copies of it would drift the first time one was
 * adjusted. What differs between careers and programs — the card, and whether a sort is offered —
 * arrives as props.
 */
function CollapsibleSection<T extends { id: string; match_score: number }>({
  title,
  description,
  items,
  render,
  sort,
  order,
}: {
  title: string;
  description: string;
  items: T[];
  render: (item: T) => React.ReactNode;
  sort?: React.ReactNode;
  order?: CareerSort;
}) {
  const [expanded, setExpanded] = useState(false);
  const headingId = useId();

  /**
   * The candidate set is **always the engine's top five by match score**, taken before any
   * re-sorting. Sorting the whole persisted ten by salary and then slicing would silently swap in
   * careers the engine ranked seventh and eighth — a different set of recommendations wearing the
   * label of this one.
   */
  const shortlist = useMemo(() => items.slice(0, EXPANDED_VISIBLE), [items]);

  const ordered = useMemo(() => sortRecommendations(shortlist, order ?? 'match'), [shortlist, order]);
  const visible = expanded ? ordered : ordered.slice(0, DEFAULT_VISIBLE);
  const hidden = ordered.length - visible.length;

  return (
    // Named, so this is a landmark a screen reader can jump to and announce as "Careers" rather
    // than as the second of two unlabelled regions.
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id={headingId} className="text-lg font-semibold text-foreground">
            {title}
          </h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {sort}
      </div>

      {ordered.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              Nothing to show here yet. This usually means the catalog has no matching entries —
              your guidance counselor can tell you more.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {visible.map(render)}

          {hidden > 0 || expanded ? (
            <Button
              variant="secondary"
              className="w-fit"
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? (
                <>
                  <ChevronUp className="size-4" aria-hidden="true" />
                  Show top {DEFAULT_VISIBLE} only
                </>
              ) : (
                <>
                  <ChevronDown className="size-4" aria-hidden="true" />
                  Show top {ordered.length}
                </>
              )}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * Re-order a shortlist without changing its membership.
 *
 * `match` returns the engine's own order untouched. The other two sort on catalog facts already
 * visible on the card, and both fall back to the match ranking for entries missing that fact — a
 * career with no salary on file is not "the lowest paid", it is unknown, and sorting it to the
 * bottom as though it were zero would be the same lie §27 refuses to tell about a blank GWA.
 */
function sortRecommendations<T extends { id: string; match_score: number }>(
  items: T[],
  order: CareerSort,
): T[] {
  if (order === 'match') {
    return items;
  }

  return [...items].sort((a, b) => {
    const left = sortKey(a, order);
    const right = sortKey(b, order);

    if (left === null && right === null) return b.match_score - a.match_score;
    if (left === null) return 1;
    if (right === null) return -1;
    if (left !== right) return right - left;

    // Ties fall back to the computed ranking, so the order stays reproducible (§26).
    return b.match_score - a.match_score;
  });
}

function sortKey(item: { id: string }, order: CareerSort): number | null {
  const career = (item as Partial<CareerRecommendation>).career;

  if (career === undefined) return null;

  if (order === 'salary') {
    // The top of the band, because "what could this pay" is the question a student is asking.
    return career.salary_max ?? career.salary_min ?? null;
  }

  // The outlook lookup carries its own display order (Low → Moderate → High → Emerging), which is
  // a curated sequence rather than an alphabet — so it is the sort key, not the name.
  return career.employment_outlook?.display_order ?? null;
}

function CareerSortControl({
  value,
  onChange,
}: {
  value: CareerSort;
  onChange: (value: CareerSort) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor="career-sort" className="whitespace-nowrap text-sm text-muted-foreground">
        Sort by
      </label>
      <Select
        id="career-sort"
        className="h-9 w-auto"
        value={value}
        onChange={(event) => onChange(event.target.value as CareerSort)}
      >
        <option value="match">Match score</option>
        <option value="salary">Highest salary</option>
        <option value="outlook">Best job outlook</option>
      </Select>
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
      {/*
        Sighted readers get the label from the layout — a large number in the top-right corner of
        a recommendation card is unmistakably its score. Read linearly it is not: the card
        announced "Chemical Engineer, 97.0%, #2" with nothing saying what 97% is a measure of or
        what it is ranked out of. The two sr-only phrases are that missing layout.
      */}
      <span className="text-2xl font-semibold text-foreground">
        <span className="sr-only">Match score </span>
        {score.toFixed(1)}%
      </span>
      <Badge tone={rank === 1 ? 'success' : undefined}>
        {rank === 1 ? (
          'Best match'
        ) : (
          <>
            <span className="sr-only">Ranked </span>#{rank}
          </>
        )}
      </Badge>
    </div>
  );
}

/**
 * "Explain more" (§30, Phase 5a) — one of the two places on this page a model speaks, and it is
 * visually and verbally separate from the computed numbers above it.
 *
 * The fallback is not an error state. When the AI cannot answer — nothing relevant in the
 * knowledge base, the daily quota spent, the model down — the card simply keeps the
 * deterministic reason it already shows, and says so. §29: the paragraph is an enhancement,
 * never a dependency.
 */
function ExplainMore({ recommendationId }: { recommendationId: string }) {
  const explain = useExplainRecommendation();

  /**
   * Where focus goes when the button that had it is replaced by the answer.
   *
   * Both settled branches below render *instead of* the button, so pressing "Explain more"
   * removes the element the keyboard was on and focus falls back to `<body>` — the next Tab
   * restarts from the top of the page, several cards above where the student was. Moving focus
   * onto the answer keeps them in place and, because the region is where the new text is,
   * announces it on arrival.
   */
  const answerRef = useRef<HTMLDivElement>(null);
  const settled = explain.isSuccess;

  useEffect(() => {
    if (settled) answerRef.current?.focus();
  }, [settled]);

  if (explain.data?.explanation) {
    return (
      <div
        ref={answerRef}
        tabIndex={-1}
        className="rounded-none bg-muted p-3 focus-visible:outline-none"
      >
        <p className="text-sm text-foreground/80">{explain.data.explanation.explanation_text}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          AI-generated from the school&apos;s guidance materials — the scores above are computed,
          not AI.
        </p>
      </div>
    );
  }

  if (explain.data && explain.data.explanation === null) {
    return (
      <div ref={answerRef} tabIndex={-1} className="focus-visible:outline-none">
        <p className="text-sm text-muted-foreground">
          An AI explanation isn&apos;t available right now — the reason above is the computed one
          and still stands.
        </p>
      </div>
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
      {/*
        This branch keeps the button, so focus is not lost — but the failure still appears out of
        nowhere below it and needs announcing. `role="status"` rather than `alert`: a missing AI
        paragraph is an enhancement that did not arrive (§29), not an error worth interrupting for.
      */}
      {explain.isError ? (
        <p role="status" className="text-sm text-muted-foreground">
          We couldn&apos;t reach the explanation service. {explain.error.message}
        </p>
      ) : null}
    </div>
  );
}

function CareerCard({ recommendation }: { recommendation: CareerRecommendation }) {
  const { career } = recommendation;
  const [showPrograms, setShowPrograms] = useState(false);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          {/* `h3`: this card is inside the "Careers" section, whose heading is the `h2`. */}
          <CardTitle as="h3" className="flex items-center gap-2">
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
        <p className="text-sm text-muted-foreground">{recommendation.reason}</p>

        {(() => {
          const parts = [
            formatSalaryRange(career.salary_min, career.salary_max),
            career.employment_outlook?.name,
          ].filter(Boolean);

          return parts.length > 0 ? (
            <p className="text-sm text-muted-foreground">{parts.join(' · ')}</p>
          ) : null;
        })()}

        <ExplainMore recommendationId={recommendation.id} />

        <div>
          {/*
            Named for *this* career. Five cards carrying five buttons all called "View related
            college programs" is five identical rows in a screen reader's element list, and the
            only thing that tells them apart — the card they sit in — is exactly what such a list
            strips away.
          */}
          <Button
            variant="secondary"
            onClick={() => setShowPrograms((current) => !current)}
            aria-expanded={showPrograms}
            aria-label={
              showPrograms
                ? `Hide college programs for ${career.title}`
                : `View college programs related to ${career.title}`
            }
          >
            <GraduationCap className="size-4" aria-hidden="true" />
            {showPrograms ? 'Hide college programs' : 'View related college programs'}
          </Button>
        </div>

        {showPrograms ? <RelatedPrograms careerId={career.id} /> : null}
      </CardContent>
    </Card>
  );
}

/**
 * The programs that lead to a career — `program_careers` read in the direction §27 never needed.
 *
 * Deliberately **not** filtered to the student's own recommended programs. A student looking at
 * "Software Engineer" is asking what they could study to get there; answering with only the two
 * programs that happen to be in their own top ten would hide the rest of the catalog behind a
 * ranking they did not ask about.
 */
function RelatedPrograms({ careerId }: { careerId: string }) {
  const { data, isLoading, isError, error } = useCareerPrograms(careerId, true);

  if (isLoading) {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Finding college programs…
      </p>
    );
  }

  if (isError) {
    return (
      <Alert tone="danger">
        We could not load the related programs. {error instanceof Error ? error.message : ''}
      </Alert>
    );
  }

  const programs = data?.programs ?? [];

  if (programs.length === 0) {
    return (
      <Alert tone="info">
        No college programs have been mapped to this career yet. Your guidance counselor can point
        you to the ones your school knows about.
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-2 border-l-2 border-border pl-4">
      <p className="text-sm font-medium text-foreground/80">
        {programs.length} college {programs.length === 1 ? 'program leads' : 'programs lead'} to
        this career
      </p>

      <ul className="flex flex-col gap-2">
        {programs.map(({ program, college }) => (
          <li key={program.id} className="flex flex-col gap-2 border border-border p-3">
            <div>
              <p className="text-sm font-medium text-foreground">
                {program.name} <Badge>{program.code}</Badge>
              </p>
              <p className="text-sm text-muted-foreground">{college.name}</p>
            </div>

            <CollegesOfferingDisclosure programId={program.id} programName={program.name} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProgramCard({ recommendation }: { recommendation: ProgramRecommendation }) {
  const { program, college } = recommendation;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          {/* `h3`, under the "Programs" section heading — see CareerCard. */}
          <CardTitle as="h3" className="flex items-center gap-2">
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
        <p className="text-sm text-muted-foreground">{recommendation.reason}</p>

        {program.recommended_strand ? (
          <p className="text-sm text-muted-foreground">
            Typically taken by <strong>{program.recommended_strand}</strong> students.
          </p>
        ) : null}

        <ExplainMore recommendationId={recommendation.id} />

        <CollegesOfferingDisclosure programId={program.id} programName={program.name} />
      </CardContent>
    </Card>
  );
}

/**
 * "View colleges offering this program" — the question migration 0018's canonical catalog exists
 * to answer.
 *
 * A `programs` row is one college's offering; its canonical entry is what the program *is*; the
 * sibling offerings of that entry are the answer. A program that has not been matched to a
 * canonical entry says so plainly rather than rendering an empty list that reads like "nowhere
 * offers this".
 */
function CollegesOfferingDisclosure({
  programId,
  programName,
}: {
  programId: string;
  programName: string;
}) {
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError, error } = useProgramColleges(programId, open);

  return (
    <div className="flex flex-col gap-2">
      <div>
        {/* Named for the program, for the same reason CareerCard's disclosure is. */}
        <Button
          variant="secondary"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          aria-label={
            open
              ? `Hide colleges offering ${programName}`
              : `View colleges offering ${programName}`
          }
        >
          <School className="size-4" aria-hidden="true" />
          {open ? 'Hide colleges' : 'View colleges offering this program'}
        </Button>
      </div>

      {open ? (
        isLoading ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Finding colleges…
          </p>
        ) : isError ? (
          <Alert tone="danger">
            We could not load the colleges. {error instanceof Error ? error.message : ''}
          </Alert>
        ) : data?.canonical === null ? (
          <Alert tone="info">
            {programName} hasn&apos;t been matched to the shared program catalog yet, so we
            can&apos;t list the other colleges that offer it.
          </Alert>
        ) : (data?.offerings.length ?? 0) === 0 ? (
          <Alert tone="info">No other college in the catalog currently offers this program.</Alert>
        ) : (
          <ul className="flex flex-col gap-2 border-l-2 border-border pl-4">
            {data!.offerings.map(({ college, program }) => (
              <li
                key={program.id}
                className="flex flex-wrap items-center justify-between gap-2 border border-border p-3"
              >
                <div>
                  <p className="text-sm font-medium text-foreground">{college.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {[college.town?.name, college.province?.name].filter(Boolean).join(', ') ||
                      'Location not listed'}
                  </p>
                </div>

                {/*
                  The existing college mapping, reused verbatim from the public Colleges page —
                  same label, same target, same external-link hygiene.
                */}
                {college.map_link ? (
                  <a
                    href={college.map_link}
                    target="_blank"
                    rel="noopener noreferrer"
                    // Which college, and that the link leaves the page — `target="_blank"` is a
                    // silent change of context otherwise, and the twenty colleges offering a
                    // popular program would otherwise be twenty links with one name between them.
                    aria-label={`View ${college.name} on Google Maps (opens in a new tab)`}
                    className="inline-flex h-9 items-center gap-2 rounded-none border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
                  >
                    <MapPin className="size-4" aria-hidden="true" />
                    View on Google Maps
                  </a>
                ) : (
                  <span className="text-xs text-muted-foreground">No map available</span>
                )}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

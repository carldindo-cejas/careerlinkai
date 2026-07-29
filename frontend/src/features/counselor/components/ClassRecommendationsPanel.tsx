import { ChevronDown, Loader2, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';

import { StudentRecommendationLists } from '@/components/recommendations/StudentRecommendationLists';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/components/ui/cn';
import { useClassResults } from '@/features/counselor/hooks/useAssignments';
import { useRoster } from '@/features/counselor/hooks/useRoster';
import {
  useRegenerateStudentRecommendations,
  useStudentRecommendations,
} from '@/features/student/hooks/useRecommendations';
import { toast } from '@/stores/toastStore';
import { fullName, type RosterEntry } from '@/types/class';

/**
 * The counselor's view of their own students' recommendations (audit F2, absorbing P1-1).
 *
 * ## Why this exists
 *
 * `GET /counselor/students/{id}/recommendations` and its `regenerate` sibling have both been live
 * since Phase 4 and Phase 0 respectively, along with an API client and two hooks — and **nothing
 * rendered any of it**. An admin could read a student's recommendations through
 * `CounselorDetailPage`; the counselor who actually advises that student could not, and the
 * regenerate button they were the intended user of was reachable only by `curl`. That is the whole
 * of finding F2, and P1-1 is the same defect Phase 0 accidentally re-created while fixing F1.
 *
 * ## One student at a time, on purpose
 *
 * There is no bulk endpoint here. The admin's roster arrives with every student's recommendations
 * hydrated server-side in one N+1-free query; this screen has only the per-student route. So the
 * rows render from the roster and the class results — both already fetched by `RosterTable` and
 * `ClassResultsPanel` on this same page, and therefore free from the React Query cache — and a
 * student's recommendations are fetched **when their row is opened**. A panel that mounted the hook
 * for all forty students would fire forty requests on page load for cards nobody has looked at.
 *
 * Only one row is open at a time. Two open rows is two sets of ten ranked entries on screen, which
 * invites exactly the cross-student comparison of match scores that §27 does not support — the
 * scores are computed per student against their own profile.
 *
 * ## The Holland code comes from the results, not the set
 *
 * `RecommendationSet` carries the careers and the programs but not the RIASEC code they were
 * derived from, so the badge reads the class results — the latest SCORED RIASEC attempt for that
 * student. That query is ordered `submitted_at DESC` server-side, so the first match is the latest.
 * Showing it matters: a counselor looking at "why did this student get these five" is asking about
 * the code, and it is the one figure that makes the ranking legible rather than oracular.
 */
export function ClassRecommendationsPanel({ classId }: { classId: string }) {
  const { data: roster, isPending, isError, error } = useRoster(classId);
  const { data: results } = useClassResults(classId);
  const [openStudentId, setOpenStudentId] = useState<string | null>(null);

  /**
   * Student id → their latest Holland code. Built from the results already on the page rather than
   * refetched; a student with no scored RIASEC attempt is simply absent, which the row renders as
   * "not assessed yet" rather than as a blank that could be read as an empty code.
   */
  const hollandCodes = useMemo(() => {
    const codes = new Map<string, string>();

    for (const result of results ?? []) {
      const code = result.result?.result_code;
      const studentId = result.student?.id;

      if (
        result.assessment?.category === 'RIASEC' &&
        code != null &&
        studentId != null &&
        !codes.has(studentId)
      ) {
        codes.set(studentId, code);
      }
    }

    return codes;
  }, [results]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recommendations</CardTitle>
        <CardDescription>
          Each student&apos;s computed career and college matches. Open a row to see their top five
          of each — every score here is calculated from their own results, so scores are not
          comparable between students.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {isPending ? (
          <div className="flex justify-center py-8" role="status">
            <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
            <span className="sr-only">Loading the roster…</span>
          </div>
        ) : null}

        {/* D11's rule: a failed load is never an empty state. */}
        {isError ? <Alert>We could not load the roster. {error.message}</Alert> : null}

        {roster && roster.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            Nobody in this class yet. Recommendations appear here once students join and finish both
            RIASEC and SCCT.
          </p>
        ) : null}

        {(roster ?? []).map((entry) => (
          <StudentRow
            key={entry.id}
            entry={entry}
            hollandCode={hollandCodes.get(entry.student_id) ?? null}
            open={openStudentId === entry.student_id}
            onToggle={() =>
              setOpenStudentId((current) =>
                current === entry.student_id ? null : entry.student_id,
              )
            }
          />
        ))}
      </CardContent>
    </Card>
  );
}

function StudentRow({
  entry,
  hollandCode,
  open,
  onToggle,
}: {
  entry: RosterEntry;
  hollandCode: string | null;
  open: boolean;
  onToggle: () => void;
}) {
  const name = fullName(entry) || entry.username;

  return (
    <div className="border border-border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center justify-between gap-3 p-4 text-left hover:bg-muted/30"
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground">{name}</span>
          <span className="font-mono text-sm text-muted-foreground">{entry.username}</span>
          {hollandCode ? (
            <Badge className="font-mono">{hollandCode}</Badge>
          ) : (
            <span className="text-sm text-muted-foreground">No RIASEC result yet</span>
          )}
        </span>

        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform duration-200',
            open && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </button>

      {/* Mounted only while open — that is what keeps the fetch lazy (see the panel doc). */}
      {open ? <StudentRecommendations studentId={entry.student_id} name={name} /> : null}
    </div>
  );
}

function StudentRecommendations({ studentId, name }: { studentId: string; name: string }) {
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
        cause instanceof Error
          ? cause.message
          : `${name}’s recommendations could not be rebuilt.`,
      );
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 border-t border-border p-4" role="status">
        <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="text-sm text-muted-foreground">Loading {name}’s recommendations…</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="border-t border-border p-4">
        <Alert>
          We could not load {name}’s recommendations. {error.message}
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 border-t border-border bg-muted/20 p-4">
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
        <Button
          variant="secondary"
          size="sm"
          loading={regenerate.isPending}
          onClick={onRegenerate}
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          Rebuild
        </Button>

        {/*
          Offered whether or not a set exists, and the sentence says why. A set is computed once, at
          submit, against the catalog as it stood that day — so every college an administrator adds
          afterwards is invisible to this student until this is pressed. That is the ordinary case,
          not an error.
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

import { Briefcase, GraduationCap } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/components/ui/cn';
import type { CareerRecommendation, ProgramRecommendation } from '@/types/recommendation';

/**
 * One student's recommendations as **staff** read them: top careers beside top college programs,
 * each numbered, each carrying the §27 match score.
 *
 * Shared deliberately. It was written for the admin's `CounselorDetailPage`, and the counselor's
 * `ClassRecommendationsPanel` (audit F2) needs the *same* presentation — not a similar one. Two
 * copies would drift the first time either was adjusted, and an admin and the counselor who
 * actually advises the student would end up reading the same numbers in two different layouts and
 * wondering which screen was right.
 *
 * Purely presentational: it takes two lists and nothing else. Whether they arrived hydrated in a
 * bulk roster payload or from a single-student fetch is the caller's business, and keeping that out
 * of here is what lets both callers exist.
 *
 * The student-facing `RecommendationPage` is **not** a third caller and should not become one. It
 * shows the reason, the salary band, the outlook and the "explain more" affordance — it is a
 * different screen answering a different question, and collapsing the two would strip a student's
 * page down to a staff summary.
 */

/** The engine persists ten of each (§27's `TOP_N`); the staff summary shows five. */
const DEFAULT_LIMIT = 5;

export interface StudentRecommendationListsProps {
  careers: CareerRecommendation[];
  programs: ProgramRecommendation[];
  /** How many of each to show. */
  limit?: number;
  className?: string;
}

export function StudentRecommendationLists({
  careers,
  programs,
  limit = DEFAULT_LIMIT,
  className,
}: StudentRecommendationListsProps) {
  return (
    <div className={cn('grid gap-6 md:grid-cols-2', className)}>
      <RecommendationList
        icon={<Briefcase className="size-4 text-muted-foreground" aria-hidden="true" />}
        title={`Top ${limit} career recommendations`}
        empty="No career recommendations yet."
        items={careers.slice(0, limit).map((recommendation) => ({
          id: recommendation.id,
          primary: recommendation.career.title,
          secondary: recommendation.career.typical_riasec_code,
          score: recommendation.match_score,
        }))}
      />
      <RecommendationList
        icon={<GraduationCap className="size-4 text-muted-foreground" aria-hidden="true" />}
        title={`Top ${limit} college recommendations`}
        empty="No college recommendations yet."
        items={programs.slice(0, limit).map((recommendation) => ({
          id: recommendation.id,
          primary: recommendation.college.name,
          secondary: recommendation.program.name,
          score: recommendation.match_score,
        }))}
      />
    </div>
  );
}

interface RecommendationItem {
  id: string;
  primary: string;
  secondary: string | null;
  score: number;
}

function RecommendationList({
  icon,
  title,
  empty,
  items,
}: {
  icon: ReactNode;
  title: string;
  empty: string;
  items: RecommendationItem[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        {icon}
        {title}
      </h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {items.map((item, index) => (
            <li key={item.id} className="flex items-baseline gap-2 text-sm">
              <span className="w-5 shrink-0 text-right font-mono text-xs text-muted-foreground">
                {index + 1}.
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-foreground">{item.primary}</span>
                {item.secondary ? (
                  <span className="text-muted-foreground"> · {item.secondary}</span>
                ) : null}
              </span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {item.score.toFixed(1)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

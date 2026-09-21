import { eq, inArray } from 'drizzle-orm';

import type { Database } from '@/db/client';
import {
  assessmentDimensions,
  assessmentResults,
  dimensionScores,
  studentProfiles,
  towns,
} from '@/db/schema';
import { collegeAliases } from '@/lib/aliases';
import { academicAverage, RIASEC_DIMENSION_NAMES } from '@/lib/recommendation';
import { ScoringService } from '@/modules/assessment/scoring-service';
import {
  RecommendationService,
  type RecommendationSet,
} from '@/modules/recommendation/recommendation-service';

/**
 * **The Student Brief** — everything the assistant may know about the student it is talking to
 * (AI-COVERAGE-PLAN.md Phase 1, 2026-09-13).
 *
 * ## Why it exists
 *
 * The chat prompt used to carry ten lines: five career titles and five program titles, each with a
 * score and the reason sentence. It did not carry the RIASEC profile, the SCCT scores, the strand,
 * the grades, or the components behind a score — all of which this system holds and the scorer
 * already uses. So *"why is Accountancy my top program when I'm Artistic?"* could only be answered
 * by repeating the reason sentence, and *"what subjects should I focus on?"* could not be answered
 * at all.
 *
 * ## What it is not
 *
 * Not a cache and not a model preload. Workers AI keeps nothing between calls, so "loading the
 * student's knowledge once at login" is not something the platform can do. The brief is built from
 * the rows on each turn — about six D1 reads — and sent as ~500 tokens, which is the cheapest form
 * of "the assistant already knows me" that the Free plan allows.
 *
 * ## The assembly rule
 *
 * Named fields only (§32/§40), exactly like the prompt itself: no row is dumped, so a column added
 * to `student_profiles` tomorrow (a guardian's phone number, say) cannot reach a prompt without
 * somebody writing its name here. Scoped to one student id, which the caller resolves from the
 * bearer token.
 */

export interface BriefDimension {
  code: string;
  name: string;
  score: number;
  /** The stored band label, e.g. "High Interest" — migration 0035's five-tier scale. */
  band: string | null;
}

export interface BriefMatch {
  ranking: number;
  title: string;
  matchScore: number;
  reason: string;
  /** Unrounded §27 components (migration 0036). Null on rows generated before it. */
  components: Record<string, number> | null;
  /** Programs only. */
  college?: string;
  collegeAliases?: string[];
  town?: string | null;
}

export interface StudentBrief {
  profile: {
    gradeLevel: string | null;
    strand: string | null;
    grades: { math: number | null; science: number | null; english: number | null };
    average: number | null;
  };
  riasec: { complete: boolean; hollandCode: string | null; dimensions: BriefDimension[] };
  scct: {
    complete: boolean;
    confidenceIndex: number | null;
    band: string | null;
    dimensions: BriefDimension[];
  };
  careers: BriefMatch[];
  programs: BriefMatch[];
}

/** How many of each match type the brief carries. Five is what the recommendations page shows. */
export const BRIEF_MATCHES = 5;

/**
 * The five-tier scale (migration 0035), for the one number with no stored label: the composite
 * career-confidence index, which is recomputed rather than stored (§23).
 */
const BANDS: [number, string][] = [
  [84, 'Very High'],
  [68, 'High'],
  [52, 'Moderate'],
  [36, 'Low'],
  [0, 'Very Low'],
];

export function bandFor(score: number): string {
  return BANDS.find(([floor]) => score >= floor)?.[1] ?? 'Very Low';
}

export class StudentBriefService {
  private readonly recommendations: RecommendationService;
  private readonly scoring: ScoringService;

  constructor(private readonly db: Database) {
    this.recommendations = new RecommendationService(db);
    this.scoring = new ScoringService(db);
  }

  /**
   * The brief for one student. `set` is the recommendation set the caller already loaded, passed
   * in so a chat turn does not read it twice; `undefined` loads it here.
   */
  async briefFor(studentId: string, set?: RecommendationSet | null): Promise<StudentBrief> {
    const recommendationSet =
      set === undefined ? await this.recommendations.latestFor(studentId) : set;

    const [profile] = await this.db
      .select({
        gradeLevel: studentProfiles.gradeLevel,
        strand: studentProfiles.strand,
        mathGrade: studentProfiles.mathGrade,
        scienceGrade: studentProfiles.scienceGrade,
        englishGrade: studentProfiles.englishGrade,
      })
      .from(studentProfiles)
      .where(eq(studentProfiles.userId, studentId))
      .limit(1);

    const latest = await this.recommendations.latestScoredResults(studentId);
    const attemptIds = [latest.riasec?.attemptId, latest.scct?.attemptId].filter(
      (id): id is string => id !== undefined,
    );

    // Both instruments' dimensions in one read.
    const dimensionRows =
      attemptIds.length === 0
        ? []
        : await this.db
            .select({
              attemptId: dimensionScores.attemptId,
              code: assessmentDimensions.code,
              name: assessmentDimensions.name,
              score: dimensionScores.normalizedScore,
              band: dimensionScores.interpretation,
              order: assessmentDimensions.orderNumber,
            })
            .from(dimensionScores)
            .innerJoin(
              assessmentDimensions,
              eq(dimensionScores.dimensionId, assessmentDimensions.id),
            )
            .where(inArray(dimensionScores.attemptId, attemptIds));

    const dimensionsOf = (attemptId: string | undefined): BriefDimension[] =>
      attemptId === undefined
        ? []
        : dimensionRows
            .filter((row) => row.attemptId === attemptId)
            .sort((a, b) => a.order - b.order)
            .map(({ code, name, score, band }) => ({ code, name, score, band }));

    const hollandCode =
      latest.riasec === null
        ? null
        : ((
            await this.db
              .select({ code: assessmentResults.resultCode })
              .from(assessmentResults)
              .where(eq(assessmentResults.id, latest.riasec.resultId))
              .limit(1)
          )[0]?.code ?? null);

    let confidenceIndex: number | null = null;

    if (latest.scct !== null) {
      try {
        confidenceIndex = await this.scoring.compositeIndexFor(latest.scct.attemptId);
      } catch {
        confidenceIndex = null;
      }
    }

    const programs = recommendationSet?.programs.slice(0, BRIEF_MATCHES) ?? [];
    const townIds = [
      ...new Set(
        programs.map(({ college }) => college.townId).filter((id): id is string => id !== null),
      ),
    ];
    const townNames =
      townIds.length === 0
        ? new Map<string, string>()
        : new Map(
            (
              await this.db
                .select({ id: towns.id, name: towns.name })
                .from(towns)
                .where(inArray(towns.id, townIds))
            ).map((row) => [row.id, row.name]),
          );

    const grades = {
      math: profile?.mathGrade ?? null,
      science: profile?.scienceGrade ?? null,
      english: profile?.englishGrade ?? null,
    };

    return {
      profile: {
        gradeLevel: profile?.gradeLevel ?? null,
        strand: profile?.strand ?? null,
        grades,
        average: academicAverage({
          mathGrade: grades.math,
          scienceGrade: grades.science,
          englishGrade: grades.english,
        }),
      },
      riasec: {
        complete: latest.riasec !== null,
        hollandCode,
        dimensions: dimensionsOf(latest.riasec?.attemptId),
      },
      scct: {
        complete: latest.scct !== null,
        confidenceIndex,
        band: confidenceIndex === null ? null : bandFor(confidenceIndex),
        dimensions: dimensionsOf(latest.scct?.attemptId),
      },
      careers: (recommendationSet?.careers.slice(0, BRIEF_MATCHES) ?? []).map(
        ({ recommendation, career }) => ({
          ranking: recommendation.ranking,
          title: career.title,
          matchScore: recommendation.matchScore,
          reason: recommendation.reason,
          components: recommendation.components ?? null,
        }),
      ),
      programs: programs.map(({ recommendation, program, college }) => ({
        ranking: recommendation.ranking,
        title: program.name,
        matchScore: recommendation.matchScore,
        reason: recommendation.reason,
        components: recommendation.components ?? null,
        college: college.name,
        collegeAliases: collegeAliases(college.name),
        town: college.townId === null ? null : (townNames.get(college.townId) ?? null),
      })),
    };
  }
}

// --- prose ------------------------------------------------------------------------------------

/** One decimal, no trailing ".0": 83.6, 75, 90.1. */
export function formatScore(value: number): string {
  return String(Math.round(value * 10) / 10);
}

const COMPONENT_LABELS: [string, string][] = [
  ['riasecCompatibility', 'RIASEC fit'],
  ['careerAlignment', 'career alignment'],
  ['careerConfidenceIndex', 'career confidence'],
  ['academicFit', 'academic fit'],
  ['strandAlignment', 'strand alignment'],
  // `programEligibility` is listed so that a recommendation stored before 2026-09-18 still reads
  // back with the component it was actually scored on. The engine no longer produces it.
  ['programEligibility', 'eligibility'],
];

/** "RIASEC fit 90.2, career confidence 75.4" — the preference term is a constant and omitted. */
export function componentsProse(components: Record<string, number> | null): string | null {
  if (components === null) {
    return null;
  }

  const parts = COMPONENT_LABELS.filter(([key]) => typeof components[key] === 'number').map(
    ([key, label]) => `${label} ${formatScore(components[key]!)}`,
  );

  return parts.length === 0 ? null : parts.join(', ');
}

function hollandProse(code: string | null): string | null {
  if (code === null || code === '') {
    return null;
  }

  const names = [...code]
    .map((letter) => RIASEC_DIMENSION_NAMES[letter as keyof typeof RIASEC_DIMENSION_NAMES])
    .filter((name): name is string => name !== undefined);

  return names.length === 0 ? code : `${code} (${names.join(', ')})`;
}

/**
 * The brief as prompt text.
 *
 * Also the non-document half of the claim check's sources (`ChatService`), which is why it is plain
 * labelled sentences carrying every number exactly as the model sees it: a figure the model copies
 * from here must be found here.
 */
export function briefToProse(brief: StudentBrief): string {
  const lines: string[] = ['STUDENT PROFILE'];
  const { profile, riasec, scct } = brief;

  lines.push(
    `Grade level: ${profile.gradeLevel ?? 'not given'}. Senior high school strand: ${profile.strand ?? 'not given'}.`,
  );

  const grade = (label: string, value: number | null) =>
    `${label} ${value === null ? 'not given' : formatScore(value)}`;

  lines.push(
    `Subject grades: ${grade('Math', profile.grades.math)}, ${grade('Science', profile.grades.science)}, ${grade('English', profile.grades.english)}.` +
      (profile.average === null
        ? ' No subject average, so academic fit is neutral.'
        : ` Subject average: ${formatScore(profile.average)}.`),
  );

  lines.push(
    `Assessments completed: RIASEC ${riasec.complete ? 'yes' : 'not yet'}, SCCT ${scct.complete ? 'yes' : 'not yet'}.`,
  );

  if (riasec.dimensions.length > 0) {
    lines.push(
      `RIASEC interest scores out of 100: ${riasec.dimensions
        .map((d) => `${d.name} ${formatScore(d.score)}${d.band === null ? '' : ` (${d.band})`}`)
        .join(', ')}.`,
    );
  }

  const holland = hollandProse(riasec.hollandCode);

  if (holland !== null) {
    lines.push(`Holland code: ${holland}.`);
  }

  if (scct.dimensions.length > 0) {
    lines.push(
      `SCCT confidence scores out of 100: ${scct.dimensions
        .map((d) => `${d.name} ${formatScore(d.score)}${d.band === null ? '' : ` (${d.band})`}`)
        .join(', ')}.`,
    );
  }

  if (scct.confidenceIndex !== null) {
    lines.push(
      `Career confidence index: ${formatScore(scct.confidenceIndex)} (${scct.band ?? ''} Career Confidence).`,
    );
  }

  if (brief.careers.length === 0 && brief.programs.length === 0) {
    lines.push(
      '',
      'THE STUDENT HAS NO RECOMMENDATIONS YET',
      'They have not completed both required assessments, so there are no match scores. Answer catalog and guidance questions normally.',
    );

    return lines.join('\n');
  }

  lines.push(
    '',
    'THE STUDENT’S RECOMMENDATIONS (computed deterministically — you did not produce these and may not revise them)',
    'Career matches, best first (score out of 100):',
    ...brief.careers.map((match) => {
      const parts = componentsProse(match.components);

      return `  ${match.ranking}. ${match.title} — ${formatScore(match.matchScore)}.${parts === null ? '' : ` Components: ${parts}.`} ${match.reason}`;
    }),
    'College program matches, best first (score out of 100):',
    ...brief.programs.map((match) => {
      const parts = componentsProse(match.components);
      const place = match.town ? ` (${match.town})` : '';
      const aliases =
        match.collegeAliases && match.collegeAliases.length > 0
          ? ` [${match.college} is also called ${match.collegeAliases.join(' or ')}.]`
          : '';

      return `  ${match.ranking}. ${match.title} at ${match.college}${place} — ${formatScore(match.matchScore)}.${parts === null ? '' : ` Components: ${parts}.`} ${match.reason}${aliases}`;
    }),
  );

  return lines.join('\n');
}

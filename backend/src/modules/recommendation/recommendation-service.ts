import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';

import type { Database } from '@/db/client';
import { RIASEC_DIMENSIONS, type RiasecDimension } from '@/db/enums';
import {
  assessmentAttempts,
  assessmentDimensions,
  assessmentResults,
  assessmentTemplates,
  assessmentVersions,
  careers,
  colleges,
  dimensionScores,
  programs,
  recommendationExplanations,
  recommendations,
  studentProfiles,
  type Career,
  type College,
  type EmploymentOutlook,
  type Program,
  type Recommendation,
  type RecommendationExplanation,
} from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import {
  academicAverage,
  rankTop,
  scoreCareer,
  scoreProgram,
  TOP_N,
  type CareerTarget,
  type ProgramTarget,
  type RiasecProfile,
  type StudentSignals,
} from '@/lib/recommendation';
import { AcademicCatalogService } from '@/modules/catalog/academic-catalog-service';
import { ScoringService } from '@/modules/assessment/scoring-service';
import { AuditService } from '@/modules/platform/audit-service';

/**
 * RecommendationService (FULLPLAN §27, §28) — the shell around the pure engine.
 *
 * `lib/recommendation.ts` owns every formula and knows nothing about a database. This owns every
 * read and every write and knows nothing about the arithmetic. That split is what lets §28's
 * worked example be checked against numbers a human computed by hand rather than against the
 * engine's own output, and it is why `lib/recommendation.ts` was built and tested in Step 3 while
 * the tables it needed did not exist yet.
 *
 * ## The two inputs, and one thing this must never do
 *
 * §27 needs a RIASEC interest profile and an SCCT career-confidence index. Both come from
 * `dimension_scores` — the RIASEC one directly, the SCCT one via
 * `ScoringService.compositeIndexFor()`, which **recomputes** §23's composite from the stored
 * dimension scores and the version's `scoring_config`.
 *
 * It is **never** parsed out of `assessment_results.overall_summary`. That column is display prose
 * and §23 forbids any consumer reading a number back out of it — which is why the scorer
 * deliberately writes no digits into it at all, and a test asserts that. If this service ever
 * needs a number that is only available in a sentence, the sentence is the bug.
 */

const MODULE = 'Recommendation';

/**
 * **D1 refuses a query with more than 100 bound parameters.**
 *
 * A `recommendations` row binds 10 columns, and §27 persists the top 10 careers *and* the top 10
 * programs — so a full set is 20 rows, and a single multi-row insert of it binds **200** parameters.
 * D1 rejects that query outright.
 *
 * Found on staging, and it is the third limit in this project that **no local test could see**:
 * Miniflare's SQLite allows up to 999 bound variables, so the insert simply worked there. Worse, the
 * *test* catalog is tiny — a handful of careers and programs — so even a strict local runtime would
 * only ever have built a 2–4 row insert and stayed under the cap by accident. The bug needed a real
 * catalog **and** a real D1 to appear, and it appeared as a student submitting their second
 * assessment, getting a perfectly scored result, and finding an empty recommendations screen: the
 * listener threw, and `dispatch()` swallowed it exactly as it is designed to (a recommendation
 * failure must never fail a submitted assessment).
 *
 * 9 rows × 10 columns = 90 bindings, which leaves headroom for a column being added to the table
 * without this silently starting to fail again.
 */
const D1_MAX_BOUND_PARAMETERS = 100;
const RECOMMENDATION_COLUMNS = 10;
const ROWS_PER_INSERT = Math.floor((D1_MAX_BOUND_PARAMETERS - 10) / RECOMMENDATION_COLUMNS);

/** Split rows into inserts that each stay under D1's bound-parameter ceiling. */
export function chunkForD1<T>(rows: T[], size: number = ROWS_PER_INSERT): T[][] {
  const chunks: T[][] = [];

  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }

  return chunks;
}

/** A recommendation with the catalog row it points at — what every read of this table actually wants. */
export interface CareerRecommendation {
  recommendation: Recommendation;
  career: Career;
  /** The resolved employment-outlook row, for the card's demand label and the outlook sort. */
  outlook?: EmploymentOutlook | null;
}

export interface ProgramRecommendation {
  recommendation: Recommendation;
  program: Program;
  /** §13.6: a recommended college is a join, not a stored match. This is that join, resolved. */
  college: College;
}

export interface RecommendationSet {
  /** The RIASEC result these were computed from — the Holland Code the cards sit next to. */
  assessmentResultId: string;
  generatedAt: string;
  careers: CareerRecommendation[];
  programs: ProgramRecommendation[];
}

export class RecommendationService {
  private readonly catalog: AcademicCatalogService;
  private readonly scoring: ScoringService;
  private readonly audit: AuditService;

  constructor(private readonly db: Database) {
    this.catalog = new AcademicCatalogService(db);
    this.scoring = new ScoringService(db);
    this.audit = new AuditService(db);
  }

  /**
   * Generate and persist a student's recommendations (§27).
   *
   * Returns `null` when the student does not yet have **both** a scored RIASEC and a scored SCCT
   * result. That is not an error — it is the ordinary state of a student who has taken one of the
   * two — and it is checked here as well as in the listener because a service must not depend on
   * its caller having checked. §11 (v1.2) puts the both-complete rule in the listener; this is the
   * same rule enforced where the data actually is.
   *
   * **Idempotent by construction.** §26 promises the same inputs produce the same ranking, so
   * running this twice for the same RIASEC result must produce the same rows, not twice as many.
   * The delete-then-insert below is what makes that true, and the unique index on
   * `(assessment_result_id, match_type, ranking)` is what would catch it if it stopped being true.
   */
  async generateFor(studentId: string): Promise<{ careers: number; programs: number } | null> {
    const { riasec, scct } = await this.latestScoredResults(studentId);

    if (riasec === null || scct === null) {
      return null;
    }

    const profile = await this.riasecProfileFor(riasec.attemptId);

    if (profile === null) {
      // A scored RIASEC attempt with no dimension rows is not a student who scored zero — it is a
      // student for whom nothing was measured (§24: `max === 0` writes no row at all). Ranking the
      // entire catalog against an interest profile that does not exist would produce ten confident
      // cards backed by nothing.
      return null;
    }

    const careerConfidenceIndex = await this.scoring.compositeIndexFor(scct.attemptId);

    if (careerConfidenceIndex === null) {
      return null;
    }

    const student = await this.signalsFor(studentId, profile, careerConfidenceIndex);

    const rankedCareers = await this.rankCareers(student);
    const rankedPrograms = await this.rankPrograms(student);

    const generatedAt = now();

    const rows = [
      ...rankedCareers.map((match, index) => ({
        id: uuid(),
        assessmentResultId: riasec.resultId,
        studentId,
        matchType: 'CAREER' as const,
        targetCareerId: match.careerId,
        targetProgramId: null,
        matchScore: match.matchScore,
        ranking: index + 1,
        reason: match.reason,
        createdAt: generatedAt,
      })),
      ...rankedPrograms.map((match, index) => ({
        id: uuid(),
        assessmentResultId: riasec.resultId,
        studentId,
        matchType: 'PROGRAM' as const,
        targetCareerId: null,
        targetProgramId: match.programId,
        matchScore: match.matchScore,
        ranking: index + 1,
        reason: match.reason,
        createdAt: generatedAt,
      })),
    ];

    // One batch: D1 has no interactive transactions, and a half-written recommendation set — the
    // careers replaced and the programs not — would be shown to the student as though it were
    // whole. `db.batch()` runs every statement below in one implicit transaction.
    //
    // The insert is **chunked**, and that is not a performance tweak — it is the difference between
    // this working and silently doing nothing. See `chunkForD1`.
    //
    // M4: the delete **always runs**, even when the new set is empty, and is scoped to the
    // *student* rather than to this one RIASEC result. Two bugs closed at once:
    //   1. If the catalog was emptied or every career archived, ranking produces zero rows — and
    //      the old `if (rows.length > 0)` guard skipped the delete entirely, so a regeneration
    //      that should have cleared the student's cards left the stale ones standing.
    //   2. A retake produces a new RIASEC result; deleting only *this* result's rows left every
    //      superseded set from older results accumulating forever (only `latestFor` hid them).
    // A student's recommendations are derived, replaceable data (not §12 historical evidence), so
    // "regenerate" correctly means "replace everything this student has", not "append".
    const deleteStatement = this.db
      .delete(recommendations)
      .where(eq(recommendations.studentId, studentId));

    await this.db.batch([
      deleteStatement,
      ...chunkForD1(rows).map((chunk) => this.db.insert(recommendations).values(chunk)),
    ]);

    await this.audit.write({
      action: 'RECOMMENDATIONS_GENERATED',
      module: MODULE,
      userId: studentId,
      targetType: 'assessment_result',
      targetId: riasec.resultId,
      newValues: {
        careers: rankedCareers.length,
        programs: rankedPrograms.length,
        top_career_score: rankedCareers[0]?.matchScore ?? null,
        top_program_score: rankedPrograms[0]?.matchScore ?? null,
      },
    });

    // Counts, not the hydrated set. This runs inline inside the student's submit request
    // (D17), whose subrequest budget is finite and asserted (§45, Phase 4.5) — and the one
    // caller, the `AssessmentCompleted` listener, discards the return value. Hydrating the
    // set here cost four D1 queries per submit that nothing ever read; the screens fetch
    // through `latestFor` on their own request.
    return { careers: rankedCareers.length, programs: rankedPrograms.length };
  }

  /**
   * The student's current recommendations, hydrated with the catalog rows they point at.
   *
   * "Latest" is resolved by `created_at` on the rows themselves rather than by chasing the most
   * recent RIASEC result: a student can retake RIASEC, and the recommendations that exist are the
   * ones that were actually generated — not the ones the newest result implies should exist.
   */
  async latestFor(studentId: string): Promise<RecommendationSet | null> {
    const [newest] = await this.db
      .select()
      .from(recommendations)
      .where(eq(recommendations.studentId, studentId))
      .orderBy(desc(recommendations.createdAt))
      .limit(1);

    if (newest === undefined) {
      return null;
    }

    return this.forResult(studentId, newest.assessmentResultId);
  }

  /** One generated set, hydrated. */
  async forResult(
    studentId: string,
    assessmentResultId: string,
  ): Promise<RecommendationSet | null> {
    const rows = await this.db
      .select()
      .from(recommendations)
      .where(
        and(
          eq(recommendations.studentId, studentId),
          eq(recommendations.assessmentResultId, assessmentResultId),
        ),
      )
      .orderBy(asc(recommendations.ranking));

    if (rows.length === 0) {
      return null;
    }

    const careerRows = rows.filter((row) => row.matchType === 'CAREER');
    const programRows = rows.filter((row) => row.matchType === 'PROGRAM');

    // Two queries for N rows rather than N queries — the ten cards on a student's screen must not
    // cost twenty round trips to D1.
    const careerById = await this.careersById(
      careerRows.map((row) => row.targetCareerId).filter((id): id is string => id !== null),
    );
    const programById = await this.programsById(
      programRows.map((row) => row.targetProgramId).filter((id): id is string => id !== null),
    );

    /**
     * The employment-outlook lookup, resolved for the career cards (2026-07-27).
     *
     * It was previously left unjoined here, on the reasoning that a recommendation card shows a
     * title and a Holland code and does not need a demand label. That reasoning stopped holding
     * when the cards gained a **"sort by job outlook"** control: the field was on the wire, always
     * null, so the card's outlook line never rendered and the sort would have had nothing to sort
     * on. One query for a four-row table, once per page.
     */
    const outlooks = await this.catalog.outlooksById();

    return {
      assessmentResultId,
      generatedAt: rows[0]!.createdAt,
      careers: careerRows.flatMap((recommendation) => {
        const career = careerById.get(recommendation.targetCareerId!);

        // A career deleted since generation. The row cascades away with a real DELETE, so this is
        // only reachable in a race — but a card with a blank title is worse than one card fewer.
        return career === undefined
          ? []
          : [
              {
                recommendation,
                career,
                outlook:
                  career.employmentOutlookId === null
                    ? null
                    : (outlooks.get(career.employmentOutlookId) ?? null),
              },
            ];
      }),
      programs: programRows.flatMap((recommendation) => {
        const found = programById.get(recommendation.targetProgramId!);

        return found === undefined ? [] : [{ recommendation, ...found }];
      }),
    };
  }

  // --- explanations (§13.6 — this module owns the table; the AI module owns the pipeline) --

  /**
   * One recommendation, scoped to its owner. `null` rather than a throw so the route can
   * answer 404 — "not yours" and "not real" must stay indistinguishable (§39).
   */
  async findForStudent(
    studentId: string,
    recommendationId: string,
  ): Promise<Recommendation | null> {
    const [row] = await this.db
      .select()
      .from(recommendations)
      .where(
        and(eq(recommendations.id, recommendationId), eq(recommendations.studentId, studentId)),
      )
      .limit(1);

    return row ?? null;
  }

  async explanationFor(recommendationId: string): Promise<RecommendationExplanation | null> {
    const [row] = await this.db
      .select()
      .from(recommendationExplanations)
      .where(eq(recommendationExplanations.recommendationId, recommendationId))
      .limit(1);

    return row ?? null;
  }

  /**
   * Persist an AI explanation — **replacing** any prior one (§13.6: one explanation per
   * recommendation; re-explaining replaces rather than accumulating variations). The AI
   * module calls this; nothing else writes the table.
   */
  async saveExplanation(
    recommendationId: string,
    explanationText: string,
    aiModel: string,
  ): Promise<RecommendationExplanation> {
    const row = {
      id: uuid(),
      recommendationId,
      explanationText,
      aiModel,
      createdAt: now(),
    };

    await this.db.batch([
      this.db
        .delete(recommendationExplanations)
        .where(eq(recommendationExplanations.recommendationId, recommendationId)),
      this.db.insert(recommendationExplanations).values(row),
    ]);

    return row;
  }

  /**
   * The current recommendation set for **many** students at once, hydrated — the counselor
   * students view (§20). Because `generateFor` replaces a student's rows wholesale
   * (delete-then-insert scoped to the student), every row a student has *is* their current set, so
   * this needs no "latest result" subquery: select all their rows, ranked, and hydrate the catalog
   * in two queries for the whole cohort rather than per student (the N+1 §27's inline generation
   * was bitten by — see `scorableCareersForMany`).
   */
  async setsForStudents(studentIds: string[]): Promise<Map<string, RecommendationSet>> {
    const result = new Map<string, RecommendationSet>();

    if (studentIds.length === 0) {
      return result;
    }

    const rows = await this.db
      .select()
      .from(recommendations)
      .where(inArray(recommendations.studentId, studentIds))
      .orderBy(asc(recommendations.ranking));

    if (rows.length === 0) {
      return result;
    }

    const careerById = await this.careersById(
      rows
        .filter((row) => row.matchType === 'CAREER')
        .map((row) => row.targetCareerId)
        .filter((id): id is string => id !== null),
    );
    const programById = await this.programsById(
      rows
        .filter((row) => row.matchType === 'PROGRAM')
        .map((row) => row.targetProgramId)
        .filter((id): id is string => id !== null),
    );

    const byStudent = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byStudent.get(row.studentId) ?? [];
      list.push(row);
      byStudent.set(row.studentId, list);
    }

    for (const [studentId, studentRows] of byStudent) {
      const careerRows = studentRows.filter((row) => row.matchType === 'CAREER');
      const programRows = studentRows.filter((row) => row.matchType === 'PROGRAM');

      result.set(studentId, {
        assessmentResultId: studentRows[0]!.assessmentResultId,
        generatedAt: studentRows[0]!.createdAt,
        careers: careerRows.flatMap((recommendation) => {
          const career = careerById.get(recommendation.targetCareerId!);

          return career === undefined ? [] : [{ recommendation, career }];
        }),
        programs: programRows.flatMap((recommendation) => {
          const found = programById.get(recommendation.targetProgramId!);

          return found === undefined ? [] : [{ recommendation, ...found }];
        }),
      });
    }

    return result;
  }

  /**
   * The latest **SCORED RIASEC** Holland Code (`assessment_results.result_code`) per student — the
   * "IAS" that the counselor students table shows even for a student who has no recommendations yet
   * (they need SCCT too). One query for the whole cohort; newest attempt per student wins.
   */
  async hollandCodesForStudents(studentIds: string[]): Promise<Map<string, string | null>> {
    const codes = new Map<string, string | null>();

    if (studentIds.length === 0) {
      return codes;
    }

    const rows = await this.db
      .select({
        studentId: assessmentAttempts.studentId,
        resultCode: assessmentResults.resultCode,
      })
      .from(assessmentResults)
      .innerJoin(assessmentAttempts, eq(assessmentResults.attemptId, assessmentAttempts.id))
      .innerJoin(
        assessmentVersions,
        eq(assessmentAttempts.assessmentVersionId, assessmentVersions.id),
      )
      .innerJoin(
        assessmentTemplates,
        eq(assessmentVersions.assessmentTemplateId, assessmentTemplates.id),
      )
      .where(
        and(
          inArray(assessmentAttempts.studentId, studentIds),
          eq(assessmentAttempts.status, 'SCORED'),
          eq(assessmentTemplates.category, 'RIASEC'),
        ),
      )
      .orderBy(desc(assessmentAttempts.submittedAt));

    for (const row of rows) {
      if (!codes.has(row.studentId)) {
        codes.set(row.studentId, row.resultCode ?? null);
      }
    }

    return codes;
  }

  /** The current rank-1 rows of each type — what the queued explanation job pre-explains. */
  async topRecommendationsFor(studentId: string): Promise<Recommendation[]> {
    const [newest] = await this.db
      .select()
      .from(recommendations)
      .where(eq(recommendations.studentId, studentId))
      .orderBy(desc(recommendations.createdAt))
      .limit(1);

    if (newest === undefined) {
      return [];
    }

    return this.db
      .select()
      .from(recommendations)
      .where(
        and(
          eq(recommendations.studentId, studentId),
          eq(recommendations.assessmentResultId, newest.assessmentResultId),
          eq(recommendations.ranking, 1),
        ),
      );
  }

  // --- internals -------------------------------------------------------------------------

  /**
   * The student's most recent **SCORED** attempt of each instrument, and its result.
   *
   * `SCORED`, not `SUBMITTED`: §21 is explicit that an `EXPIRED` attempt never feeds
   * recommendations, and a `SUBMITTED`-but-unscored attempt has no `dimension_scores` to read.
   * Ordered by the attempt's `submitted_at` rather than the result's `generated_at` so that a
   * retake taken today beats an original taken last month even if the rows were written out of
   * order.
   *
   * One query for both categories, not one each: this runs inline inside the student's
   * submit (D17), where every D1 call counts against the Free plan's 50-subrequest ceiling
   * (§45). The rows per student are a handful; picking the newest per category in JS is free.
   */
  private async latestScoredResults(
    studentId: string,
  ): Promise<Record<'riasec' | 'scct', { resultId: string; attemptId: string } | null>> {
    const rows = await this.db
      .select({
        resultId: assessmentResults.id,
        attemptId: assessmentAttempts.id,
        category: assessmentTemplates.category,
      })
      .from(assessmentResults)
      .innerJoin(assessmentAttempts, eq(assessmentResults.attemptId, assessmentAttempts.id))
      .innerJoin(
        assessmentVersions,
        eq(assessmentAttempts.assessmentVersionId, assessmentVersions.id),
      )
      .innerJoin(
        assessmentTemplates,
        eq(assessmentVersions.assessmentTemplateId, assessmentTemplates.id),
      )
      .where(
        and(
          eq(assessmentAttempts.studentId, studentId),
          eq(assessmentAttempts.status, 'SCORED'),
          inArray(assessmentTemplates.category, ['RIASEC', 'SCCT']),
        ),
      )
      // Newest first, so the first row seen per category below is the latest one.
      .orderBy(desc(assessmentAttempts.submittedAt));

    const latest: Record<'riasec' | 'scct', { resultId: string; attemptId: string } | null> = {
      riasec: null,
      scct: null,
    };

    for (const row of rows) {
      const key = row.category === 'RIASEC' ? 'riasec' : 'scct';

      latest[key] ??= { resultId: row.resultId, attemptId: row.attemptId };
    }

    return latest;
  }

  /**
   * The six normalized RIASEC scores, keyed by letter.
   *
   * A dimension with no row is **absent, not zero** (§24) — but §27's arithmetic needs all six
   * letters to index into. A missing dimension is filled with 0 *for the purposes of the weighted
   * average only*, which is the honest reading: a dimension nothing measured contributes no
   * evidence of interest. Returns `null` if there are no rows at all, which is the case that must
   * not be silently treated as "a student interested in nothing".
   */
  private async riasecProfileFor(attemptId: string): Promise<RiasecProfile | null> {
    const rows = await this.db
      .select({
        code: assessmentDimensions.code,
        normalizedScore: dimensionScores.normalizedScore,
      })
      .from(dimensionScores)
      .innerJoin(assessmentDimensions, eq(dimensionScores.dimensionId, assessmentDimensions.id))
      .where(eq(dimensionScores.attemptId, attemptId));

    if (rows.length === 0) {
      return null;
    }

    const profile = Object.fromEntries(
      RIASEC_DIMENSIONS.map((dimension) => [dimension, 0]),
    ) as RiasecProfile;

    for (const row of rows) {
      if ((RIASEC_DIMENSIONS as readonly string[]).includes(row.code)) {
        profile[row.code as RiasecDimension] = row.normalizedScore;
      }
    }

    return profile;
  }

  /** §27's student side: the interest profile, the SCCT index, and the two profile fields. */
  private async signalsFor(
    studentId: string,
    riasec: RiasecProfile,
    careerConfidenceIndex: number,
  ): Promise<StudentSignals> {
    const [profile] = await this.db
      .select({
        strand: studentProfiles.strand,
        mathGrade: studentProfiles.mathGrade,
        scienceGrade: studentProfiles.scienceGrade,
        englishGrade: studentProfiles.englishGrade,
      })
      .from(studentProfiles)
      .where(eq(studentProfiles.userId, studentId))
      .limit(1);

    // No profile row at all is the same signal as an empty one: unknown. §27 maps unknown to a
    // neutral value, never to a penalty — a student who has not filled in their grades has not
    // failed anything.
    return {
      riasec,
      careerConfidenceIndex,
      academicAverage:
        profile === undefined
          ? null
          : academicAverage({
              mathGrade: profile.mathGrade,
              scienceGrade: profile.scienceGrade,
              englishGrade: profile.englishGrade,
            }),
      strand: profile?.strand ?? null,
    };
  }

  /** Every `active` career, scored and ranked (§27). */
  private async rankCareers(student: StudentSignals) {
    const rows = await this.db
      .select()
      .from(careers)
      .where(and(eq(careers.status, 'active'), isNull(careers.deletedAt)));

    const targets: CareerTarget[] = rows.map((career) => ({
      id: career.id,
      title: career.title,
      typicalRiasecCode: career.typicalRiasecCode,
    }));

    const matches = targets.map((career) => ({
      ...scoreCareer(student, career),
      title: career.title,
    }));

    return rankTop(
      matches,
      (m) => m.matchScore,
      (m) => m.title,
      TOP_N,
    );
  }

  /**
   * Every rankable program, scored and ranked (§27).
   *
   * `rankablePrograms()` is **the single place recommendability is decided** and this asks nothing
   * else: an `active` program under an `archived` college is not rankable, because a program's own
   * status says nothing about whether the college still offers it. Likewise `scorableCareersFor()`
   * is the only thing that decides which careers vote on a program's RIASEC average. Both were
   * built in Step 3 for exactly this call site.
   */
  private async rankPrograms(student: StudentSignals) {
    const rankable = await this.catalog.rankablePrograms();

    // **One query for every program's careers, not one per program.** This ranks the whole catalog,
    // so the per-program version in a loop was an N+1 — and on Cloudflare that is not just slow: a
    // Worker has a hard subrequest limit, D1 queries count against it, and this runs inside the
    // student's `submit()`, which has already spent budget scoring the attempt. It passed every
    // local test (Miniflare enforces no such limit) and generated nothing at all on the deployed
    // Worker. See `scorableCareersForMany`.
    const linkedByProgram = await this.catalog.scorableCareersForMany(
      rankable.map(({ program }) => program.id),
    );

    const matches = rankable.map(({ program }) => {
      const target: ProgramTarget = {
        id: program.id,
        name: program.name,
        recommendedStrand: program.recommendedStrand,
      };

      const linked = linkedByProgram.get(program.id) ?? [];

      return {
        ...scoreProgram(
          student,
          target,
          linked.map((career) => career.typicalRiasecCode),
        ),
        name: program.name,
      };
    });

    return rankTop(
      matches,
      (m) => m.matchScore,
      (m) => m.name,
      TOP_N,
    );
  }

  private async careersById(ids: string[]): Promise<Map<string, Career>> {
    if (ids.length === 0) {
      return new Map();
    }

    const rows = await this.db.select().from(careers).where(inArray(careers.id, ids));

    return new Map(rows.map((career) => [career.id, career]));
  }

  private async programsById(
    ids: string[],
  ): Promise<Map<string, { program: Program; college: College }>> {
    if (ids.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .select({ program: programs, college: colleges })
      .from(programs)
      .innerJoin(colleges, eq(programs.collegeId, colleges.id))
      .where(inArray(programs.id, ids));

    return new Map(rows.map((row) => [row.program.id, row]));
  }
}

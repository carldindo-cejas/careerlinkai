import { asc, eq, inArray } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';

import type { Database } from '@/db/client';
import {
  assessmentAnswers,
  assessmentAttempts,
  assessmentDimensions,
  assessmentQuestions,
  assessmentResults,
  assessmentVersions,
  dimensionScores,
  questionDimensions,
  questionOptions,
  type AssessmentAttempt,
  type AssessmentVersion,
} from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { ApiError } from '@/lib/envelope';
import {
  compositeIndex,
  score as runScoring,
  type ScoredDimension,
  type ScoringInput,
  type ScoringQuestion,
} from '@/lib/scoring';

/**
 * The shell around §24's engine (FULLPLAN §22–§24).
 *
 * All the *judgment* lives in `lib/scoring.ts`, which is pure and unit-tested against the Part VI
 * worked examples. This file only loads rows, hands them over, and persists what comes back —
 * which is the split that makes the plan's "build the scorer first, test it standalone before any
 * route exists" instruction actually executable.
 *
 * **Scoring runs inline on submit, never queued** (§24). It is fast, deterministic, and the
 * student is on the screen waiting for their result — a queue would buy nothing and cost them a
 * spinner. Only the *downstream* recommendation and AI steps are queued (Part XI).
 */
export class ScoringService {
  constructor(private readonly db: Database) {}

  /**
   * Score an attempt and persist `dimension_scores` + `assessment_results`, moving it to `SCORED`.
   *
   * Everything is written in **one `db.batch()`** — D1 has no interactive transactions. A partial
   * write here would be a genuinely bad state: an attempt marked SCORED with only half its
   * dimensions, which no later read could tell apart from a student who legitimately skipped them
   * (an absent dimension means "not measured" — §24). The batch is what stops "not measured" from
   * ever being a lie about the system rather than a fact about the student.
   *
   * `version`, when the caller already holds it, skips one D1 read — this runs inside the
   * submit request, whose subrequest budget is measured (§45, Phase 4.5). Returns the
   * timestamp it stamped, so the caller can mirror the row it just wrote without re-reading it.
   */
  async score(
    attempt: AssessmentAttempt,
    version?: AssessmentVersion,
  ): Promise<{ generatedAt: string }> {
    const input = await this.loadScoringInput(attempt, version);
    const output = runScoring(input);

    const generatedAt = now();

    const statements: BatchItem<'sqlite'>[] = [
      // Re-scoring must replace, never accumulate — a counselor reset can bring an attempt back
      // through here, and two result rows would make "the result" ambiguous.
      this.db.delete(dimensionScores).where(eq(dimensionScores.attemptId, attempt.id)),
      this.db.delete(assessmentResults).where(eq(assessmentResults.attemptId, attempt.id)),
    ];

    if (output.dimensionScores.length > 0) {
      statements.push(
        this.db.insert(dimensionScores).values(
          output.dimensionScores.map((scored) => ({
            id: uuid(),
            attemptId: attempt.id,
            dimensionId: scored.dimensionId,
            rawScore: scored.rawScore,
            normalizedScore: scored.normalizedScore,
            interpretation: scored.interpretation,
            createdAt: generatedAt,
          })),
        ),
      );
    }

    statements.push(
      this.db.insert(assessmentResults).values({
        id: uuid(),
        attemptId: attempt.id,
        overallSummary: output.overallSummary,
        resultCode: output.resultCode,
        generatedAt,
      }),
      this.db
        .update(assessmentAttempts)
        .set({ status: 'SCORED', updatedAt: generatedAt })
        .where(eq(assessmentAttempts.id, attempt.id)),
    );

    await this.db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);

    return { generatedAt };
  }

  /**
   * §23's Career Confidence Index for a scored attempt — **the number Part VII consumes.**
   *
   * It is recomputed from the `dimension_scores` rows plus the version's `scoring_config`, and is
   * never parsed out of `assessment_results.overall_summary`, which is display-only prose (§23,
   * v1.2). The summary deliberately contains no digits, so there would be nothing to parse even
   * if someone tried.
   */
  async compositeIndexFor(attemptId: string): Promise<number | null> {
    // One joined query for the attempt's scoring_config, not attempt-then-version: this is
    // called from inside the student's submit request (via the recommendation listener,
    // D17), where every D1 call counts against the Free plan's subrequest ceiling (§45).
    const [row] = await this.db
      .select({ scoringConfig: assessmentVersions.scoringConfig })
      .from(assessmentAttempts)
      .innerJoin(
        assessmentVersions,
        eq(assessmentAttempts.assessmentVersionId, assessmentVersions.id),
      )
      .where(eq(assessmentAttempts.id, attemptId))
      .limit(1);

    if (row === undefined) {
      throw ApiError.notFound('Attempt not found.');
    }

    const scored = await this.scoredDimensionsFor(attemptId);

    return compositeIndex(scored, row.scoringConfig);
  }

  /** The persisted `dimension_scores`, projected back into the pure engine's shape. */
  async scoredDimensionsFor(attemptId: string): Promise<ScoredDimension[]> {
    const rows = await this.db
      .select({
        dimensionId: dimensionScores.dimensionId,
        code: assessmentDimensions.code,
        rawScore: dimensionScores.rawScore,
        normalizedScore: dimensionScores.normalizedScore,
        interpretation: dimensionScores.interpretation,
      })
      .from(dimensionScores)
      .innerJoin(assessmentDimensions, eq(dimensionScores.dimensionId, assessmentDimensions.id))
      .where(eq(dimensionScores.attemptId, attemptId))
      .orderBy(asc(assessmentDimensions.orderNumber));

    return rows;
  }

  /**
   * Project the attempt's version into the pure engine's inputs.
   *
   * Note `maxOptionScore` is the max over the question's *options*, taken live from
   * `question_options` — that is correct and is not in tension with the answer-score snapshot.
   * The version is immutable once published (§12), so its options cannot move underneath a
   * scored attempt; the snapshot on `assessment_answers.score` exists to protect against a
   * *different* thing (a client supplying its own score, and a future version editing an option).
   */
  private async loadScoringInput(
    attempt: AssessmentAttempt,
    knownVersion?: AssessmentVersion,
  ): Promise<ScoringInput> {
    const version =
      knownVersion ??
      (
        await this.db
          .select()
          .from(assessmentVersions)
          .where(eq(assessmentVersions.id, attempt.assessmentVersionId))
          .limit(1)
      )[0];

    if (version === undefined) {
      throw ApiError.notFound('Assessment version not found.');
    }

    const dimensions = await this.db
      .select()
      .from(assessmentDimensions)
      .where(eq(assessmentDimensions.assessmentTemplateId, version.assessmentTemplateId))
      .orderBy(asc(assessmentDimensions.orderNumber));

    const questions = await this.db
      .select()
      .from(assessmentQuestions)
      .where(eq(assessmentQuestions.assessmentVersionId, version.id));

    const questionIds = questions.map((question) => question.id);

    const options =
      questionIds.length === 0
        ? []
        : await this.db
            .select()
            .from(questionOptions)
            .where(inArray(questionOptions.questionId, questionIds));

    const mappings =
      questionIds.length === 0
        ? []
        : await this.db
            .select()
            .from(questionDimensions)
            .where(inArray(questionDimensions.questionId, questionIds));

    const maxScoreByQuestion = new Map<string, number>();

    for (const option of options) {
      const current = maxScoreByQuestion.get(option.questionId) ?? Number.NEGATIVE_INFINITY;

      maxScoreByQuestion.set(option.questionId, Math.max(current, option.score));
    }

    const scoringQuestions: ScoringQuestion[] = questions.map((question) => ({
      id: question.id,
      maxOptionScore: maxScoreByQuestion.get(question.id) ?? 0,
      dimensions: mappings
        .filter((mapping) => mapping.questionId === question.id)
        .map((mapping) => ({ dimensionId: mapping.dimensionId, weight: mapping.weight })),
    }));

    const answers = await this.db
      .select({ questionId: assessmentAnswers.questionId, score: assessmentAnswers.score })
      .from(assessmentAnswers)
      .where(eq(assessmentAnswers.attemptId, attempt.id));

    return {
      config: version.scoringConfig,
      dimensions: dimensions.map((dimension) => ({
        id: dimension.id,
        code: dimension.code,
        orderNumber: dimension.orderNumber,
        interpretationRanges: dimension.interpretationRanges,
      })),
      questions: scoringQuestions,
      answers,
    };
  }
}

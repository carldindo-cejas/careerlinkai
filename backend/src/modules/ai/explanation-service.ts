import { eq } from 'drizzle-orm';

import type { Database } from '@/db/client';
import {
  assessmentDimensions,
  assessmentResults,
  careers,
  colleges,
  dimensionScores,
  programs,
  studentProfiles,
  type Recommendation,
  type RecommendationExplanation,
} from '@/db/schema';
import {
  RECOMMENDATION_EXPLANATION_PROMPT_VERSION,
  RECOMMENDATION_EXPLANATION_SYSTEM_PROMPT,
} from '@/prompts/recommendation-explanation.v1';
import type { AiGatewayService, GenerateOptions } from '@/modules/ai/ai-gateway-service';
import type { RetrievalService, RetrievedChunk } from '@/modules/ai/retrieval-service';
import { RecommendationService } from '@/modules/recommendation/recommendation-service';

/**
 * `ExplanationService` — the §30 RAG pipeline, end to end: retrieve, prompt, generate,
 * validate, persist. The AI module owns this orchestration; the Recommendation module owns
 * the `recommendation_explanations` table it lands in (§13.6), which is why every write
 * goes through `RecommendationService.saveExplanation` rather than touching the table.
 *
 * ## The one promise this service keeps whatever happens
 *
 * **The student always sees something true.** Every recommendation already carries a
 * deterministic `reason` (§27); the AI paragraph is an elaboration on it, never a
 * substitute (§29). So every failure mode below — zero retrieval, model down, quota
 * exhausted, output that fails the §34 guardrails — converges on the same behaviour:
 * log a FAILED `ai_requests` row with the reason, and hand the caller the deterministic
 * fallback. A grounded number is always better than an ungrounded paragraph (§30).
 */

/** §34: reject a response shorter than 20 or longer than 1500 characters. */
const MIN_EXPLANATION_CHARS = 20;
const MAX_EXPLANATION_CHARS = 1500;

/** §34's absolute-claim filter: language that promises an outcome is rejected outright. */
const ABSOLUTE_CLAIM_PATTERN =
  /guaranteed|you will definitely|100% certain|you are destined|you will become/i;

export interface ExplainOutcome {
  /** Present when an AI explanation exists (fresh or previously generated). */
  explanation: RecommendationExplanation | null;
  /** The §27 deterministic reason — always present, and the display text when `explanation` is null. */
  fallbackReason: string;
  /** Why there is no AI paragraph, when there is none. */
  failure?: string;
}

export class ExplanationService {
  private readonly recommendations: RecommendationService;

  constructor(
    private readonly db: Database,
    private readonly gateway: AiGatewayService,
    private readonly retrieval: RetrievalService,
    private readonly activePolicy: { instructions: string | null; restrictions: string | null } | null,
  ) {
    this.recommendations = new RecommendationService(db);
  }

  /**
   * Explain one recommendation — "if not already generated" (§20): an existing explanation
   * is returned as-is, so a student mashing the button costs zero model calls.
   *
   * `userId` is the acting user for the `ai_requests` row; NULL for the queued job (§13.7).
   */
  async explain(recommendation: Recommendation, userId: string | null): Promise<ExplainOutcome> {
    const existing = await this.recommendations.explanationFor(recommendation.id);

    if (existing !== null) {
      return { explanation: existing, fallbackReason: recommendation.reason };
    }

    const target = await this.targetLabelFor(recommendation);
    const student = await this.studentContextFor(recommendation);

    // §30: the query is built from the student's top RIASEC dimensions and the target.
    const query = [
      target.label,
      target.kind === 'PROGRAM' ? 'college program' : 'career',
      'for a student whose strongest interests are',
      student.topDimensions.map((dimension) => dimension.name).join(', '),
    ].join(' ');

    const baseOptions: Omit<GenerateOptions, 'systemPrompt' | 'userPrompt'> = {
      userId,
      requestType: 'RECOMMENDATION_EXPLANATION',
      inputContext: {
        prompt_version: RECOMMENDATION_EXPLANATION_PROMPT_VERSION,
        recommendation_id: recommendation.id,
        retrieval_query: query,
        chunk_ids: [] as string[],
      },
    };

    // Retrieval trouble (Vectorize unreachable, embedding failed) is handled exactly like
    // zero results: this pipeline never generates ungrounded (§29 principle 3), so "could
    // not retrieve" and "retrieved nothing relevant" both end at the deterministic fallback.
    let retrieved: RetrievedChunk[];

    try {
      retrieved = await this.retrieval.retrieve(query);
    } catch (error) {
      await this.gateway.logSkipped(
        { ...baseOptions, systemPrompt: '', userPrompt: query },
        `Retrieval failed: ${error instanceof Error ? error.message : String(error)}`,
      );

      return {
        explanation: null,
        fallbackReason: recommendation.reason,
        failure: 'RETRIEVAL_UNAVAILABLE',
      };
    }

    if (retrieved.length === 0) {
      await this.gateway.logSkipped(
        { ...baseOptions, systemPrompt: '', userPrompt: query },
        'No knowledge chunks above the similarity threshold — refusing to generate ungrounded (§30).',
      );

      return {
        explanation: null,
        fallbackReason: recommendation.reason,
        failure: 'NO_GROUNDING',
      };
    }

    const options: GenerateOptions = {
      ...baseOptions,
      inputContext: {
        ...baseOptions.inputContext,
        chunk_ids: retrieved.map(({ chunk }) => chunk.id),
      },
      systemPrompt: this.systemPrompt(),
      userPrompt: this.userPrompt(recommendation, target, student, retrieved),
      maxTokens: 400,
    };

    let result = await this.gateway.generate(options);

    // §34: an output tripping the absolute-claim filter is regenerated once, then given up on.
    if (result.ok && ABSOLUTE_CLAIM_PATTERN.test(result.text)) {
      result = await this.gateway.generate({
        ...options,
        inputContext: { ...options.inputContext, regenerated: 'absolute-claim filter' },
      });
    }

    if (!result.ok) {
      return { explanation: null, fallbackReason: recommendation.reason, failure: result.reason };
    }

    const text = result.text.trim();

    if (
      text.length < MIN_EXPLANATION_CHARS ||
      text.length > MAX_EXPLANATION_CHARS ||
      ABSOLUTE_CLAIM_PATTERN.test(text)
    ) {
      return { explanation: null, fallbackReason: recommendation.reason, failure: 'FAILED_VALIDATION' };
    }

    const explanation = await this.recommendations.saveExplanation(
      recommendation.id,
      text,
      result.request.model ?? 'unknown',
    );

    return { explanation, fallbackReason: recommendation.reason };
  }

  // --- prompt assembly (§32) -----------------------------------------------------------

  private systemPrompt(): string {
    // The one database-editable injection point (§13.7): the active policy's text replaces
    // the placeholders; an absent or inactive policy injects nothing and the base prompt
    // stands alone.
    return RECOMMENDATION_EXPLANATION_SYSTEM_PROMPT.replace(
      '{active_ai_policy.instructions}',
      this.activePolicy?.instructions ?? '',
    ).replace('{active_ai_policy.restrictions}', this.activePolicy?.restrictions ?? '');
  }

  /**
   * §32/§40: only named, whitelisted fields are interpolated — never a raw row dump, so a
   * password, token, or another student's data cannot leak into a prompt by schema drift.
   */
  private userPrompt(
    recommendation: Recommendation,
    target: { kind: string; label: string },
    student: {
      topDimensions: { name: string; score: number }[];
      strand: string | null;
      gwa: number | null;
      gradeLevel: string | null;
    },
    retrieved: RetrievedChunk[],
  ): string {
    const context = retrieved
      .map(({ chunk }, index) => `[${index + 1}] ${chunk.content}`)
      .join('\n\n');

    const profile = [
      `Top interest dimensions: ${student.topDimensions
        .map((dimension) => `${dimension.name} (${dimension.score.toFixed(1)}/100)`)
        .join(', ')}`,
      student.strand === null ? null : `Strand: ${student.strand}`,
      student.gwa === null ? null : `General weighted average: ${student.gwa}`,
      student.gradeLevel === null ? null : `Grade level: ${student.gradeLevel}`,
    ]
      .filter((line): line is string => line !== null)
      .join('\n');

    return [
      `RECOMMENDATION TO EXPLAIN`,
      `${target.kind === 'PROGRAM' ? 'Program' : 'Career'}: ${target.label}`,
      `Match score (computed deterministically): ${recommendation.matchScore}%`,
      `Deterministic reason: ${recommendation.reason}`,
      '',
      'STUDENT DATA',
      profile,
      '',
      'KNOWLEDGE CONTEXT',
      context,
    ].join('\n');
  }

  // --- context loading -------------------------------------------------------------------

  private async targetLabelFor(
    recommendation: Recommendation,
  ): Promise<{ kind: 'CAREER' | 'PROGRAM'; label: string }> {
    if (recommendation.matchType === 'CAREER') {
      const [career] = await this.db
        .select({ title: careers.title })
        .from(careers)
        .where(eq(careers.id, recommendation.targetCareerId!))
        .limit(1);

      return { kind: 'CAREER', label: career?.title ?? 'this career' };
    }

    const [program] = await this.db
      .select({ name: programs.name, collegeName: colleges.name })
      .from(programs)
      .innerJoin(colleges, eq(programs.collegeId, colleges.id))
      .where(eq(programs.id, recommendation.targetProgramId!))
      .limit(1);

    return {
      kind: 'PROGRAM',
      label: program === undefined ? 'this program' : `${program.name} at ${program.collegeName}`,
    };
  }

  private async studentContextFor(recommendation: Recommendation): Promise<{
    topDimensions: { name: string; score: number }[];
    strand: string | null;
    gwa: number | null;
    gradeLevel: string | null;
  }> {
    // The recommendation anchors to the RIASEC result (§13.6) — its dimension scores are the
    // interest profile the ranking was computed over, so they are what the prompt names.
    const scores = await this.db
      .select({
        name: assessmentDimensions.name,
        score: dimensionScores.normalizedScore,
      })
      .from(assessmentResults)
      .innerJoin(dimensionScores, eq(dimensionScores.attemptId, assessmentResults.attemptId))
      .innerJoin(assessmentDimensions, eq(dimensionScores.dimensionId, assessmentDimensions.id))
      .where(eq(assessmentResults.id, recommendation.assessmentResultId));

    const topDimensions = [...scores].sort((a, b) => b.score - a.score).slice(0, 3);

    const [profile] = await this.db
      .select({
        strand: studentProfiles.strand,
        gwa: studentProfiles.gwa,
        gradeLevel: studentProfiles.gradeLevel,
      })
      .from(studentProfiles)
      .where(eq(studentProfiles.userId, recommendation.studentId))
      .limit(1);

    return {
      topDimensions,
      strand: profile?.strand ?? null,
      gwa: profile?.gwa ?? null,
      gradeLevel: profile?.gradeLevel ?? null,
    };
  }
}

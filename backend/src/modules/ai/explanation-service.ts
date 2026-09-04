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
import { unsupportedClaims, validateCitations } from '@/lib/grounding';
import { academicAverage } from '@/lib/recommendation';
import type { AiGatewayService, GenerateOptions } from '@/modules/ai/ai-gateway-service';
import {
  RETRIEVAL_TOP_K,
  type RetrievalService,
  type RetrievedChunk,
} from '@/modules/ai/retrieval-service';
import { sourceTitles } from '@/modules/ai/sources';
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

/**
 * How many of the §30 context slots the target's *own* chunks may claim (Phase 2's first pass).
 *
 * Three of six. Enough that a catalog entry and its neighbours are certainly present, and few
 * enough that the general guidance material which connects those facts to a RIASEC profile is
 * not squeezed out — an explanation built only from catalog facts reads like a brochure.
 */
const TARGET_CHUNK_SLOTS = 3;

/** §34: reject a response shorter than 20 or longer than 1500 characters. */
const MIN_EXPLANATION_CHARS = 20;
const MAX_EXPLANATION_CHARS = 1500;

/** §34's absolute-claim filter: language that promises an outcome is rejected outright. */
const ABSOLUTE_CLAIM_PATTERN =
  /guaranteed|you will definitely|100% certain|you are destined|you will become/i;

/** The thing being explained, with the catalog text retrieval searches on (§30, D4). */
interface Target {
  kind: 'CAREER' | 'PROGRAM';
  label: string;
  description: string | null;
  /** The `careers.id` / `programs.id` the catalog knowledge entry for this target is keyed by. */
  entityId: string | null;
}

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

    /**
     * The retrieval query is the target's **own catalog text** — its title and description
     * (AiNormalisation D4).
     *
     * §30 originally built a sentence from the label plus the student's top RIASEC dimensions:
     * *"Nursing at Saint Louis College college program for a student whose strongest interests are
     * Social, Investigative"*. No guidance document is written that way, so the query matched the
     * corpus on almost nothing but the program name. The description already in the database is
     * written in the same register as the material being searched, which is exactly what a
     * bi-encoder is comparing.
     *
     * The student's interests are not lost — they are in the *prompt*, where they belong. What
     * gets retrieved is knowledge about the target; who it is being explained to is context the
     * model is given, not a search term.
     */
    const query = [target.label, target.description]
      .filter((part): part is string => part !== null && part.trim().length > 0)
      .join('. ');

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
      retrieved = await this.retrieveForTarget(query, target);
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

    /**
     * The grounding contract (AiNormalisation Phase 3), in cost order.
     *
     * **Cite or refuse.** This paragraph is attached to a computed number, which is exactly the
     * context in which an ungrounded sentence reads as evidence for that number. An explanation
     * that cites nothing was written from the model's own general knowledge, and there is no way
     * to tell that by reading it — so it does not ship.
     *
     * **Then the claim check**, which catches what a citation cannot: a marker on a sentence
     * whose figure appears in no passage. A model that has been told to cite will cite, including
     * on the sentence where it invented something.
     *
     * Both failures land where every other failure in this service lands — the deterministic §27
     * reason, which was true whatever the model did. Rejecting a sound explanation costs a
     * paragraph; accepting an invented one costs a student acting on it.
     */
    const citations = validateCitations(text, retrieved.length);

    if (!citations.ok) {
      await this.gateway.logSkipped(
        { ...options, systemPrompt: '', userPrompt: query },
        `Rejected by the grounding contract: ${citations.reason}.`,
      );

      return {
        explanation: null,
        fallbackReason: recommendation.reason,
        failure: citations.reason,
      };
    }

    const unsupported = unsupportedClaims(text, [
      ...retrieved.map(({ chunk }) => chunk.content),
      // Arithmetic is grounding too (§26): the score, the reason and the interest names are
      // computed, not retrieved, and a check that did not know that would reject the truest
      // sentences in the paragraph.
      target.label,
      recommendation.reason,
      `${recommendation.matchScore}`,
      ...student.topDimensions.map((dimension) => dimension.name),
    ]);

    if (unsupported.length > 0) {
      await this.gateway.logSkipped(
        { ...options, systemPrompt: '', userPrompt: query },
        `Rejected by the grounding contract: UNSUPPORTED_CLAIM (${unsupported
          .map((claim) => `${claim.kind}:${claim.token}`)
          .join(', ')}).`,
      );

      return {
        explanation: null,
        fallbackReason: recommendation.reason,
        failure: 'UNSUPPORTED_CLAIM',
      };
    }

    const explanation = await this.recommendations.saveExplanation(
      recommendation.id,
      text,
      result.request.model ?? 'unknown',
      // What the student is shown under the paragraph. An answer whose source a reader can see is
      // an answer they can judge — and an answer with no visible source is visibly not a fact.
      sourceTitles(retrieved),
    );

    return { explanation, fallbackReason: recommendation.reason };
  }

  /**
   * **Two-pass retrieval** (AiNormalisation Phase 2): this target's own chunks first, then
   * general guidance material for whatever slots remain.
   *
   * One pass over the whole corpus ranks everything on similarity alone, so a well-written
   * general passage about "choosing a healthcare career" can outrank the catalog entry for the
   * exact program being explained — and the paragraph a student reads then says nothing specific
   * about their match. The first pass is filtered to `entity_id`, so the entry *about this
   * program* is in the context by construction rather than by winning a similarity contest.
   *
   * The second pass is not optional garnish. A catalog entry alone is a few facts; the theory
   * chunks are what let the model connect them to the student's RIASEC profile, which is what
   * §30 asked the explanation to do.
   *
   * Deduplicated by chunk id: a chunk can legitimately be returned by both passes, and the same
   * passage twice in a context block is wasted context and a subtly worse prompt.
   */
  private async retrieveForTarget(query: string, target: Target): Promise<RetrievedChunk[]> {
    const entity =
      target.entityId === null
        ? undefined
        : {
            type: target.kind === 'CAREER' ? ('career' as const) : ('program' as const),
            id: target.entityId,
          };

    const own =
      entity === undefined
        ? []
        : await this.retrieval.retrieve(query, { entity, limit: TARGET_CHUNK_SLOTS });

    const general = await this.retrieval.retrieve(query, {
      limit: RETRIEVAL_TOP_K - own.length,
    });

    const seen = new Set(own.map(({ chunk }) => chunk.id));

    return [...own, ...general.filter(({ chunk }) => !seen.has(chunk.id))].slice(
      0,
      RETRIEVAL_TOP_K,
    );
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
    target: Target,
    student: {
      topDimensions: { name: string; score: number }[];
      strand: string | null;
      academicAverage: number | null;
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
      // Named as what it is. The GWA field was removed on 2026-07-27 and this is the mean of the
      // subject grades the student gave; calling it a GWA in a prompt would invite the model to
      // repeat that word back to a student who never supplied one (§40 — only named, accurate
      // fields reach a prompt).
      student.academicAverage === null
        ? null
        : `Average of reported subject grades: ${student.academicAverage.toFixed(1)}`,
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

  private async targetLabelFor(recommendation: Recommendation): Promise<Target> {
    if (recommendation.matchType === 'CAREER') {
      const [career] = await this.db
        .select({ title: careers.title, description: careers.description })
        .from(careers)
        .where(eq(careers.id, recommendation.targetCareerId!))
        .limit(1);

      return {
        kind: 'CAREER',
        label: career?.title ?? 'this career',
        description: career?.description ?? null,
        entityId: recommendation.targetCareerId,
      };
    }

    const [program] = await this.db
      .select({
        name: programs.name,
        description: programs.description,
        collegeName: colleges.name,
      })
      .from(programs)
      .innerJoin(colleges, eq(programs.collegeId, colleges.id))
      .where(eq(programs.id, recommendation.targetProgramId!))
      .limit(1);

    return {
      kind: 'PROGRAM',
      label: program === undefined ? 'this program' : `${program.name} at ${program.collegeName}`,
      description: program?.description ?? null,
      entityId: recommendation.targetProgramId,
    };
  }

  private async studentContextFor(recommendation: Recommendation): Promise<{
    topDimensions: { name: string; score: number }[];
    strand: string | null;
    academicAverage: number | null;
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
        mathGrade: studentProfiles.mathGrade,
        scienceGrade: studentProfiles.scienceGrade,
        englishGrade: studentProfiles.englishGrade,
        gradeLevel: studentProfiles.gradeLevel,
      })
      .from(studentProfiles)
      .where(eq(studentProfiles.userId, recommendation.studentId))
      .limit(1);

    return {
      topDimensions,
      strand: profile?.strand ?? null,
      academicAverage:
        profile === undefined
          ? null
          : academicAverage({
              mathGrade: profile.mathGrade,
              scienceGrade: profile.scienceGrade,
              englishGrade: profile.englishGrade,
            }),
      gradeLevel: profile?.gradeLevel ?? null,
    };
  }
}

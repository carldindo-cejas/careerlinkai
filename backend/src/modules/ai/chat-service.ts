import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import type { Database } from '@/db/client';
import {
  chatConversations,
  chatMessages,
  knowledgeChunks,
  knowledgeDocuments,
  type ChatConversation,
  type ChatMessage,
} from '@/db/schema';
import type { KnowledgeRequestState } from '@/db/enums';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import {
  answerableFromResults,
  citedIndexes,
  normaliseQuestion,
  offDomainKind,
  offDomainReply,
  parseQaChunk,
  selfReportedGap,
  unsupportedClaims,
  validateCitations,
} from '@/lib/grounding';
import {
  RECOMMENDATION_CHAT_PROMPT_VERSION,
  RECOMMENDATION_CHAT_SYSTEM_PROMPT,
} from '@/prompts/recommendation-chat.v1';
import type { AiGatewayService, GenerateOptions } from '@/modules/ai/ai-gateway-service';
import {
  toFtsQuery,
  type RetrievalService,
  type RetrievedChunk,
} from '@/modules/ai/retrieval-service';
import { sourceTitlesFor } from '@/modules/ai/sources';
import type { RecommendationSet } from '@/modules/recommendation/recommendation-service';

/**
 * `ChatService` — the recommendations-page assistant (prompt-driven, 2026-07-27).
 *
 * It is `ExplanationService` for a conversation, and it keeps the same promise that service keeps:
 * **the student always sees something true.** Every failure mode — no grounding, model down, quota
 * exhausted, output that trips the guardrails — converges on a deterministic reply built from the
 * student's own recommendation data, logged as a FAILED `ai_requests` row with a reason. §29 is
 * explicit that the AI is an enhancement, never a dependency, and a chat panel is not an exception
 * to that just because it looks like one.
 *
 * ## What the model is given, and what it is not
 *
 * The prompt carries the student's **own** recommendation set — titles, scores, deterministic
 * reasons, their top RIASEC dimensions — plus retrieved knowledge chunks and the recent transcript.
 * It is assembled field by field from named values (§32/§40), never a row dump: a schema change
 * cannot push a new column into a prompt, because every line below names what it interpolates.
 *
 * It is **not** given another student's anything. Every read here is scoped by `studentId`, which
 * the route resolves from the bearer token and never from a URL.
 *
 * ## Why the history is trimmed rather than sent whole
 *
 * A Free-plan Worker's model call is bounded by neurons (§45), and a transcript that grows without
 * limit turns a cheap answer into an expensive one for no gain — the last few turns carry the
 * thread, and the recommendation context is re-sent every time regardless. `HISTORY_TURNS` is the
 * cap, and it is a cap on what is *sent*, not on what is stored: the student keeps their whole
 * conversation on screen.
 */

/** How many prior messages travel with a turn. Six is three exchanges. */
export const HISTORY_TURNS = 6;

/** The §34 guardrails, same values as the explanation path — one taxonomy, not two. */
const MIN_REPLY_CHARS = 2;
const MAX_REPLY_CHARS = 2000;

const ABSOLUTE_CLAIM_PATTERN =
  /guaranteed|you will definitely|100% certain|you are destined|you will become/i;

/** Bounded so one student cannot bank an unbounded transcript against the daily neuron quota. */
export const MAX_QUESTION_CHARS = 1000;

/** How many Q&A candidates Gate 1 pulls before comparing normalised question text. */
const GATE_ONE_CANDIDATES = 10;

/**
 * What a student is told when nothing covers their question.
 *
 * Deliberately not an apology and not a dead end: it says what is missing, and it routes to the
 * person who can actually answer. Every one of these also writes an `ai_requests` row carrying
 * the exact question — which is the backlog an admin closes with one Q&A entry, after which this
 * same question is answered by Gate 1 for free, forever.
 */
const NO_COVERAGE_REPLY =
  'I don’t have anything in the school’s guidance materials that answers that, so I would rather not guess. Your guidance counselor can help — and if you tell them what you asked, they can add it here for next time. I can still explain anything about your own assessment results, matches and scores.';

/** One answer, whichever gate produced it. */
interface Answer {
  text: string;
  aiRequestId: string | null;
  failure: string | null;
  /** Knowledge entries to name under the answer. Empty for anything not drawn from documents. */
  sources: string[];
  /**
   * True on the four paths that end in `NO_COVERAGE_REPLY` — nothing retrieved, a citation the
   * grounding contract rejected, an unsupported claim, a failed verification — and on a fifth that
   * does not: an otherwise-accepted answer in which the model itself says its material does not
   * cover the question (`selfReportedGap`). That one keeps its text; only the button is added.
   *
   * It is what puts *"Request to add to knowledge"* under the answer (migration 0030). Recorded on
   * the row rather than re-derived by matching the reply text, so the button survives a reworded
   * refusal and a transcript reloaded next week.
   */
  coverageGap: boolean;
}

export interface ChatTurn {
  conversation: ChatConversation;
  question: ChatMessage;
  answer: ChatMessage;
  /** Why the answer is the deterministic fallback, when it is. Null on a real generation. */
  failure: string | null;
}

export class ChatService {
  constructor(
    private readonly db: Database,
    private readonly gateway: AiGatewayService,
    private readonly retrieval: RetrievalService,
    private readonly activePolicy: {
      instructions: string | null;
      restrictions: string | null;
    } | null,
    /**
     * The §34 verifier pass (`AI_VERIFIER_ENABLED`). Off by default — it is the only check in the
     * grounding contract that spends neurons, so it is a budget decision rather than a code one.
     */
    private readonly verifier = false,
  ) {}

  /**
   * The student's current conversation, or null.
   *
   * One conversation per student in v1 — the most recently updated. The table models many
   * because the shape costs nothing and "start a new chat" is an obvious next ask (§63); the
   * service picks one because the screen shows one.
   */
  async currentFor(studentId: string): Promise<ChatConversation | null> {
    const [conversation] = await this.db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.studentId, studentId))
      .orderBy(desc(chatConversations.updatedAt))
      .limit(1);

    return conversation ?? null;
  }

  /** A conversation's messages, oldest first. Scoped by student — an id alone is not authority. */
  async messagesFor(studentId: string, conversationId: string): Promise<ChatMessage[]> {
    const conversation = await this.db.query.chatConversations.findFirst({
      where: and(
        eq(chatConversations.id, conversationId),
        eq(chatConversations.studentId, studentId),
      ),
    });

    if (conversation === undefined) {
      return [];
    }

    return this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conversationId))
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
  }

  /**
   * Flag an answer as wrong (AiNormalisation Phase 4).
   *
   * Scoped by student through the conversation, like every other read here: a message id alone is
   * not authority to touch it. Idempotent — flagging twice is the same state, and a student
   * clicking again should not be an error.
   *
   * Deliberately no un-flagging in v1. The signal goes to an admin review queue, and a
   * disappearing item is worse than a stale one: it removes the evidence before anyone has looked
   * at it, and the admin has no way to know it was ever there.
   */
  async flagAnswer(studentId: string, messageId: string): Promise<boolean> {
    const [message] = await this.db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .innerJoin(chatConversations, eq(chatConversations.id, chatMessages.conversationId))
      .where(
        and(
          eq(chatMessages.id, messageId),
          eq(chatMessages.role, 'assistant'),
          eq(chatConversations.studentId, studentId),
        ),
      )
      .limit(1);

    if (message === undefined) {
      return false;
    }

    await this.db
      .update(chatMessages)
      .set({ feedback: 'DOWN' })
      .where(eq(chatMessages.id, messageId));

    return true;
  }

  /**
   * *"Request to add to knowledge"* — a student asking for a gap to be filled (migration 0030).
   *
   * Only ever on an answer the service itself marked `OFFERED`: a no-coverage refusal. That is the
   * whole authorisation story beyond the ownership check — a student cannot nominate a generated
   * answer, an off-domain redirect or somebody else's message, because none of those carry the
   * state this transition starts from.
   *
   * The question itself is **already** in the admin's backlog: every one of these refusals wrote a
   * SKIPPED `ai_requests` row carrying the exact text, and `/admin/ai-insights` has been reading
   * that since Phase 4. What this adds is the student's own voice on top of the pipeline's — a
   * question two students asked to have answered is a better use of an admin's afternoon than one
   * the retrieval merely missed, and nothing recorded that difference before.
   *
   * Idempotent, and one direction only, exactly like `flagAnswer`: pressing twice is the same
   * state, and a backlog item that can vanish before anyone has looked at it is worse than a
   * stale one.
   */
  async requestKnowledge(studentId: string, messageId: string): Promise<boolean> {
    const [message] = await this.db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .innerJoin(chatConversations, eq(chatConversations.id, chatMessages.conversationId))
      .where(
        and(
          eq(chatMessages.id, messageId),
          eq(chatMessages.role, 'assistant'),
          eq(chatConversations.studentId, studentId),
          // `OFFERED` or `REQUESTED` — the second is the idempotent re-press, which is a success
          // rather than a 404. NULL is not a request anyone was invited to make.
          isNotNull(chatMessages.knowledgeRequest),
        ),
      )
      .limit(1);

    if (message === undefined) {
      return false;
    }

    await this.db
      .update(chatMessages)
      .set({ knowledgeRequest: 'REQUESTED' })
      .where(eq(chatMessages.id, messageId));

    return true;
  }

  /** Wipe the transcript. The student's own data, and their own decision to clear it. */
  async clearFor(studentId: string): Promise<void> {
    // The `chat_messages` FK cascades, so deleting the conversation takes its messages with it.
    await this.db.delete(chatConversations).where(eq(chatConversations.studentId, studentId));
  }

  /**
   * One turn: store the question, answer it, store the answer.
   *
   * The question is persisted **before** the model is called, on purpose. If generation fails —
   * or the invocation dies outright — the student's message is still in the transcript, which is
   * what makes the panel recoverable on refresh rather than silently losing what they typed.
   */
  async ask(
    studentId: string,
    question: string,
    recommendations: RecommendationSet | null,
  ): Promise<ChatTurn> {
    const conversation = await this.openConversation(studentId, recommendations);
    const history = await this.recentHistory(conversation.id);
    const questionMessage = await this.appendMessage(conversation.id, 'user', question, null);

    const outcome = await this.answer(studentId, question, history, recommendations);
    const answerMessage = await this.appendMessage(
      conversation.id,
      'assistant',
      outcome.text,
      outcome.aiRequestId,
      outcome.sources,
      outcome.coverageGap ? 'OFFERED' : null,
    );

    await this.db
      .update(chatConversations)
      .set({ updatedAt: now() })
      .where(eq(chatConversations.id, conversation.id));

    return {
      conversation,
      question: questionMessage,
      answer: answerMessage,
      failure: outcome.failure,
    };
  }

  // --- generation ------------------------------------------------------------------------

  private async answer(
    studentId: string,
    question: string,
    history: ChatMessage[],
    recommendations: RecommendationSet | null,
  ): Promise<Answer> {
    /**
     * **Gate 0 — scope.** Declined by design (§34), before anything is retrieved or generated.
     * A guidance assistant that answers homework has quietly become a homework tool that is bad
     * at homework; a student bringing a personal problem gets pointed at a person instead.
     */
    const offDomain = offDomainKind(question);

    if (offDomain !== null) {
      return {
        text: offDomainReply(offDomain),
        aiRequestId: null,
        failure: `OUT_OF_SCOPE_${offDomain}`,
        sources: [],
        // Declined by design, not for want of material: there is nothing here for an admin to
        // write, and offering to add homework help to the corpus would invite exactly that.
        coverageGap: false,
      };
    }

    /**
     * **Gate 1 — an admin already answered this.** Zero neurons, zero hallucination, and the
     * admin's words reach the student unaltered.
     *
     * The exact-match half runs first because it is free: a keyword lookup over Q&A entries, then
     * a normalised string comparison. No embedding, no vector query, no generation. This is the
     * gate the whole flywheel turns on — the questions students repeat most are the ones that
     * never reach the model at all.
     */
    const canned = await this.cannedAnswerFor(question);

    if (canned !== null) {
      return {
        text: canned.answer,
        aiRequestId: null,
        failure: null,
        sources: [canned.title],
        coverageGap: false,
      };
    }

    return this.generated(studentId, question, history, recommendations);
  }

  /**
   * An admin-authored answer to exactly this question, or null.
   *
   * Matching is on the normalised question text — case, punctuation and diacritics removed —
   * because none of that variation changes which written answer is correct. It is deliberately
   * *exact* after normalisation rather than fuzzy: Gate 1 returns an admin's words verbatim, with
   * no model in the loop to notice that the question was actually a different one.
   *
   * FTS5 narrows the candidates to Q&A entries sharing the question's words, so this is one D1
   * query regardless of corpus size. Never throws: a lookup failure means the question goes
   * through the normal pipeline, which is a slower answer rather than no answer.
   */
  private async cannedAnswerFor(question: string): Promise<{ answer: string; title: string } | null> {
    const match = toFtsQuery(question);

    if (match === null) {
      return null;
    }

    try {
      const rows = await this.db
        .select({ content: knowledgeChunks.content, title: knowledgeDocuments.title })
        .from(knowledgeChunks)
        .innerJoin(
          sql`knowledge_chunks_fts`,
          sql`knowledge_chunks_fts.rowid = ${knowledgeChunks}.rowid`,
        )
        .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId))
        .where(
          and(
            sql`knowledge_chunks_fts MATCH ${match}`,
            eq(knowledgeChunks.sourceType, 'qa'),
            isNull(knowledgeDocuments.archivedAt),
          ),
        )
        .limit(GATE_ONE_CANDIDATES);

      const asked = normaliseQuestion(question);

      for (const row of rows) {
        const pair = parseQaChunk(row.content);

        if (pair !== null && normaliseQuestion(pair.question) === asked) {
          return { answer: pair.answer, title: row.title };
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  private async generated(
    studentId: string,
    question: string,
    history: ChatMessage[],
    recommendations: RecommendationSet | null,
  ): Promise<Answer> {
    const baseOptions: Omit<GenerateOptions, 'systemPrompt' | 'userPrompt'> = {
      userId: studentId,
      requestType: 'CHAT',
      inputContext: {
        prompt_version: RECOMMENDATION_CHAT_PROMPT_VERSION,
        retrieval_query: question,
        chunk_ids: [] as string[],
        history_messages: history.length,
      },
    };

    /**
     * Retrieval failure is not fatal here, and this is the one place this service deliberately
     * diverges from `ExplanationService`.
     *
     * That pipeline refuses to generate without grounding, because it is making a claim *about a
     * computed score* and an ungrounded paragraph attached to a number reads as evidence for it.
     * A chat turn is different: "which of my top three pays best?" is answerable from the
     * student's own recommendation data alone, and refusing it because the school's PDF corpus has
     * nothing to say about salaries would be refusing a question the system can actually answer.
     *
     * So: chunks when there are chunks, and the recommendation context is grounding in its own
     * right. What does **not** change is that nothing is answered from the model's own general
     * knowledge — the prompt's first rule is to say so when neither source covers the question.
     */
    let retrieved: RetrievedChunk[];

    try {
      retrieved = await this.retrieval.retrieve(question);
    } catch {
      // An empty context block is the fallback: retrieval being down degrades the answer's
      // grounding, it does not stop the student getting one.
      retrieved = [];
    }

    /**
     * **D7, narrowed** (AiNormalisation Phase 3). The reasoning above is sound for *"which of my
     * top three pays best?"* and exactly wrong for *"how much is tuition at that college?"*.
     *
     * In the second case nothing has been retrieved, the recommendation set says nothing about
     * fees, and the only thing standing between the student and an invented figure is the
     * prompt's first rule — which an 8B model obeys perhaps four times in five. Four times in
     * five is not a guarantee; it is a coin weighted slightly in our favour, handed to a
     * seventeen-year-old making a decision about their future.
     *
     * So the zero-retrieval path survives only for questions the student's own results can
     * actually answer. Everything else refuses, honestly, and the refusal is logged as the gap it
     * is — which is what turns it into an admin's backlog item rather than a dead end.
     */
    const resultsContext = this.resultsContextFor(recommendations);

    if (retrieved.length === 0 && !answerableFromResults(question, resultsContext)) {
      await this.gateway.logSkipped(
        { ...baseOptions, systemPrompt: '', userPrompt: question },
        'Nothing retrieved and the question is not answerable from the student’s own results — refusing to generate ungrounded (§30).',
      );

      return {
        text: NO_COVERAGE_REPLY,
        aiRequestId: null,
        failure: 'NO_GROUNDING',
        sources: [],
        coverageGap: true,
      };
    }

    const options: GenerateOptions = {
      ...baseOptions,
      inputContext: {
        ...baseOptions.inputContext,
        chunk_ids: retrieved.map(({ chunk }) => chunk.id),
      },
      systemPrompt: this.systemPrompt(),
      userPrompt: this.userPrompt(question, history, recommendations, retrieved),
      maxTokens: 500,
    };

    const result = await this.gateway.generate(options);

    if (!result.ok) {
      return {
        text: this.deterministicReply(recommendations),
        // NULL, not the failed request's id: §29 is explicit that the fallback is not model
        // output, and pointing a fallback message at an `ai_requests` row would record it as one.
        aiRequestId: null,
        failure: result.reason,
        sources: [],
        // The model being down is an operational problem. No amount of admin writing fixes it,
        // and filing it as a knowledge gap would bury the real ones on exactly the bad days.
        coverageGap: false,
      };
    }

    const text = result.text.trim();

    if (
      text.length < MIN_REPLY_CHARS ||
      text.length > MAX_REPLY_CHARS ||
      ABSOLUTE_CLAIM_PATTERN.test(text)
    ) {
      return {
        text: this.deterministicReply(recommendations),
        aiRequestId: null,
        failure: 'FAILED_VALIDATION',
        sources: [],
        coverageGap: false,
      };
    }

    /**
     * **Cite or refuse** — but only when there was something to cite. An answer built from the
     * student's own computed results has no passages behind it, and demanding a marker there
     * would reject the one class of answer that is arithmetic rather than retrieval.
     */
    if (retrieved.length > 0) {
      const citations = validateCitations(text, retrieved.length);

      if (!citations.ok) {
        await this.gateway.logSkipped(
          { ...baseOptions, systemPrompt: '', userPrompt: question },
          `Rejected by the grounding contract: ${citations.reason}.`,
        );

        return {
          text: NO_COVERAGE_REPLY,
          aiRequestId: null,
          failure: citations.reason,
          sources: [],
          coverageGap: true,
        };
      }
    }

    /**
     * **The claim check.** This is where the invented tuition fee dies: a figure or a name the
     * model wrote that appears in none of the material it was given did not come from that
     * material. Citing correctly and inventing within the cited sentence is a thing models do,
     * so the marker is checked and then ignored.
     */
    const unsupported = unsupportedClaims(text, [
      ...retrieved.map(({ chunk }) => chunk.content),
      resultsContext,
    ]);

    if (unsupported.length > 0) {
      await this.gateway.logSkipped(
        { ...baseOptions, systemPrompt: '', userPrompt: question },
        `Rejected by the grounding contract: UNSUPPORTED_CLAIM (${unsupported
          .map((claim) => `${claim.kind}:${claim.token}`)
          .join(', ')}).`,
      );

      return {
        text: NO_COVERAGE_REPLY,
        aiRequestId: null,
        failure: 'UNSUPPORTED_CLAIM',
        sources: [],
        coverageGap: true,
      };
    }

    /**
     * The one paid check, and only where it earns its neurons: an answer that survived everything
     * above **and still asserts a figure**. Those are the claims a student acts on and the ones a
     * reader cannot sanity-check by eye, so they are worth ~30 tokens when the budget allows.
     */
    if (this.verifier && /\d{3,}/.test(text)) {
      const supported = await this.gateway.verifyClaim(
        [...retrieved.map(({ chunk }) => chunk.content), resultsContext].join('\n'),
        text,
      );

      if (!supported) {
        await this.gateway.logSkipped(
          { ...baseOptions, systemPrompt: '', userPrompt: question },
          'Rejected by the grounding contract: UNSUPPORTED_CLAIM (verifier).',
        );

        return {
          text: NO_COVERAGE_REPLY,
          aiRequestId: null,
          failure: 'UNSUPPORTED_CLAIM',
          sources: [],
          coverageGap: true,
        };
      }
    }

    /**
     * **The model said it does not know** (found testing on production, 2026-09-11).
     *
     * A reply like *"I don't have any information about a Mechanical Engineering program at Bohol
     * Island State University…"* passes every check above — it cites a real passage and invents
     * nothing — so it used to be recorded as a plain success: the student's real question never
     * reached the backlog, and they were never offered *"Request to add to knowledge"*.
     *
     * The text is kept, because it is usually the most honest reply available: it says what is
     * missing and points at what does exist, which is what the prompt asks for. Only the
     * bookkeeping changes — the gap is logged as the SKIPPED row the backlog reads, and the answer
     * carries the button. A false positive therefore costs one extra backlog row and never hides an
     * answer, which is why this uses the generous tier of `selfReportedGap`.
     */
    const gap = selfReportedGap(text);

    if (gap) {
      await this.gateway.logSkipped(
        { ...baseOptions, systemPrompt: '', userPrompt: question },
        'The model answered that its material does not cover the question (SELF_REPORTED_GAP).',
      );
    }

    return {
      text,
      aiRequestId: result.request.id,
      failure: null,
      // Only what the answer actually cited. Naming a passage the model never used would be a
      // worse lie than naming none: the student would check it and find nothing.
      sources: sourceTitlesFor(retrieved, citedIndexes(text)),
      coverageGap: gap,
    };
  }

  /**
   * The student's own results as one searchable string.
   *
   * Two jobs, both about honesty rather than presentation: it is what `answerableFromResults`
   * tests a question against, and it is the non-document half of the claim check's sources —
   * because a match score of 87% is grounded by §26 arithmetic, and a check that did not know
   * that would reject the truest sentence in the answer.
   */
  private resultsContextFor(recommendations: RecommendationSet | null): string {
    if (recommendations === null) {
      return '';
    }

    return [
      ...recommendations.careers.map(
        ({ recommendation, career }) =>
          `${career.title} ${recommendation.matchScore}% ${recommendation.reason}`,
      ),
      ...recommendations.programs.map(
        ({ recommendation, program, college }) =>
          `${program.name} ${college.name} ${recommendation.matchScore}% ${recommendation.reason}`,
      ),
    ].join('\n');
  }

  /**
   * What the student is told when the model cannot answer.
   *
   * It is a real answer, not an apology: their top matches with the §27 reasons already computed
   * for them. Those sentences are reproducible arithmetic (§26) and were going to be true whatever
   * the model did.
   *
   * **Reserved for the model actually being unavailable** — a failed call, or a reply so malformed
   * that another attempt might genuinely produce a better one. It used to serve the grounding
   * rejections too, and that was measured on production as a lie: a student who asked about
   * tuition was told the assistant was *"unavailable at the moment"* and to *"try again in a
   * moment"*, when the truth was that the corpus holds no tuition figure and never would on a
   * retry. Those paths now answer with `NO_COVERAGE_REPLY`, which says what is missing and routes
   * to someone who can fix it.
   */
  private deterministicReply(recommendations: RecommendationSet | null): string {
    if (recommendations === null) {
      return 'I can’t answer that right now. Once you have completed both the RIASEC and SCCT assessments, your recommendations will appear here and I can talk you through them.';
    }

    const topCareer = recommendations.careers[0];
    const topProgram = recommendations.programs[0];

    const lines = [
      'The assistant is unavailable at the moment, so here is what your results already say:',
    ];

    if (topCareer !== undefined) {
      lines.push(
        `• Your strongest career match is ${topCareer.career.title} at ${topCareer.recommendation.matchScore}%. ${topCareer.recommendation.reason}`,
      );
    }

    if (topProgram !== undefined) {
      lines.push(
        `• Your strongest program match is ${topProgram.program.name} at ${topProgram.college.name} (${topProgram.recommendation.matchScore}%). ${topProgram.recommendation.reason}`,
      );
    }

    lines.push('Try again in a moment, or ask your guidance counselor.');

    return lines.join('\n');
  }

  // --- prompt assembly (§32) --------------------------------------------------------------

  private systemPrompt(): string {
    return RECOMMENDATION_CHAT_SYSTEM_PROMPT.replace(
      '{active_ai_policy.instructions}',
      this.activePolicy?.instructions ?? '',
    ).replace('{active_ai_policy.restrictions}', this.activePolicy?.restrictions ?? '');
  }

  /**
   * §32/§40: only named, whitelisted values are interpolated — never a raw row dump, so a
   * password, a token, or another student's data cannot reach a prompt through schema drift.
   */
  private userPrompt(
    question: string,
    history: ChatMessage[],
    recommendations: RecommendationSet | null,
    retrieved: RetrievedChunk[],
  ): string {
    const sections: string[] = [];

    if (recommendations === null) {
      sections.push(
        'THE STUDENT HAS NO RECOMMENDATIONS YET',
        'They have not completed both required assessments. Say so plainly if they ask about their results.',
      );
    } else {
      sections.push(
        'THE STUDENT’S RECOMMENDATIONS (computed deterministically — you did not produce these and may not revise them)',
        'Careers, best match first:',
        ...recommendations.careers
          .slice(0, 5)
          .map(
            ({ recommendation, career }) =>
              `  ${recommendation.ranking}. ${career.title} — ${recommendation.matchScore}%. ${recommendation.reason}`,
          ),
        'College programs, best match first:',
        ...recommendations.programs
          .slice(0, 5)
          .map(
            ({ recommendation, program, college }) =>
              `  ${recommendation.ranking}. ${program.name} at ${college.name} — ${recommendation.matchScore}%. ${recommendation.reason}`,
          ),
      );
    }

    if (retrieved.length > 0) {
      sections.push(
        '',
        'KNOWLEDGE CONTEXT (from the school’s own guidance materials)',
        retrieved.map(({ chunk }, index) => `[${index + 1}] ${chunk.content}`).join('\n\n'),
      );
    }

    if (history.length > 0) {
      sections.push(
        '',
        'RECENT CONVERSATION',
        history
          .map((message) => `${message.role === 'user' ? 'Student' : 'You'}: ${message.content}`)
          .join('\n'),
      );
    }

    sections.push('', 'THE STUDENT’S QUESTION', question);

    return sections.join('\n');
  }

  // --- persistence ------------------------------------------------------------------------

  private async openConversation(
    studentId: string,
    recommendations: RecommendationSet | null,
  ): Promise<ChatConversation> {
    const existing = await this.currentFor(studentId);

    if (existing !== null) {
      return existing;
    }

    const timestamp = now();
    const conversation: ChatConversation = {
      id: uuid(),
      studentId,
      assessmentResultId: recommendations?.assessmentResultId ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.db.insert(chatConversations).values(conversation);

    return conversation;
  }

  /** The last `HISTORY_TURNS` messages, oldest first — see the class doc on why it is trimmed. */
  private async recentHistory(conversationId: string): Promise<ChatMessage[]> {
    const rows = await this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conversationId))
      .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
      .limit(HISTORY_TURNS);

    return rows.reverse();
  }

  private async appendMessage(
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    aiRequestId: string | null,
    sources: string[] = [],
    knowledgeRequest: KnowledgeRequestState | null = null,
  ): Promise<ChatMessage> {
    const message: ChatMessage = {
      id: uuid(),
      conversationId,
      role,
      content,
      aiRequestId,
      // NULL, not [], for "nothing to name" — the two would render identically and mean the same
      // thing, and the absence of a source line is what tells a student this is not a cited fact.
      sources: sources.length === 0 ? null : sources,
      /*
        NULL until Gate 3/4 is wired up, which is exactly what migration 0029 specifies for a
        message written before the tiers exist: the panel treats NULL as it always did. It is
        not a claim that no gate answered — it is the absence of a claim, which is the only
        honest value while nothing records one.
      */
      answerKind: null,
      feedback: null,
      /*
        `OFFERED` on a no-coverage refusal, NULL on everything else (migration 0030). Written here
        rather than derived on read, so a transcript reloaded next term still knows which of its
        refusals a student may ask to have answered.
      */
      knowledgeRequest,
      // Set only when a question the student requested is later answered (migration 0033).
      knowledgeAnsweredAt: null,
      createdAt: now(),
    };

    await this.db.insert(chatMessages).values(message);

    return message;
  }
}

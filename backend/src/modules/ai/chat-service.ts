import { and, asc, desc, eq } from 'drizzle-orm';

import type { Database } from '@/db/client';
import {
  chatConversations,
  chatMessages,
  type ChatConversation,
  type ChatMessage,
} from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import {
  RECOMMENDATION_CHAT_PROMPT_VERSION,
  RECOMMENDATION_CHAT_SYSTEM_PROMPT,
} from '@/prompts/recommendation-chat.v1';
import type { AiGatewayService, GenerateOptions } from '@/modules/ai/ai-gateway-service';
import type { RetrievalService, RetrievedChunk } from '@/modules/ai/retrieval-service';
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
  ): Promise<{ text: string; aiRequestId: string | null; failure: string | null }> {
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
      };
    }

    return { text, aiRequestId: result.request.id, failure: null };
  }

  /**
   * What the student is told when the model cannot answer.
   *
   * It is a real answer, not an apology: their top matches with the §27 reasons already computed
   * for them. Those sentences are reproducible arithmetic (§26) and were going to be true whatever
   * the model did.
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
  ): Promise<ChatMessage> {
    const message: ChatMessage = {
      id: uuid(),
      conversationId,
      role,
      content,
      aiRequestId,
      createdAt: now(),
    };

    await this.db.insert(chatMessages).values(message);

    return message;
  }
}

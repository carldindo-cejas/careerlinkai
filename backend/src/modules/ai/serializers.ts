import type {
  AiPolicy,
  ChatMessage,
  KnowledgeDocument,
  RecommendationExplanation,
} from '@/db/schema';

/**
 * Allow-list serializers (F-L2 discipline): a column added next year cannot leak through a
 * spread it was never named in.
 */

export function serializeKnowledgeDocument(
  document: KnowledgeDocument & {
    chunkCount?: number;
    authorName?: string;
    authorRole?: string;
  },
): Record<string, unknown> {
  return {
    id: document.id,
    title: document.title,
    file_name: document.fileName,
    source_type: document.sourceType,
    entity_type: document.entityType,
    entity_id: document.entityId,
    processing_status: document.processingStatus,
    visibility: document.visibility,
    archived_at: document.archivedAt,
    chunk_count: document.chunkCount ?? null,
    /**
     * Who wrote this, and in what capacity (migration 0031's second half).
     *
     * `uploaded_by` has been on the row since §33 and never left the server, because until
     * counselors could contribute there was only ever one kind of author and naming them added
     * nothing. Now the corpus has two, and the distinction is the one an admin reviewing a wrong
     * answer needs first: a school-published entry and one counselor's note are different things
     * to act on, even when they read identically.
     *
     * The id travels alongside the name because the client uses it for the only thing it can act
     * on — deciding whether an entry is the viewer's own — and a name is not an identity.
     *
     * Undefined on the write paths, which serialize a row they just built and have no join in
     * hand. `null` rather than a fabricated name: the field says "not loaded here", and a client
     * that renders a byline from it will render nothing rather than something wrong.
     */
    added_by: document.uploadedBy,
    added_by_name: document.authorName ?? null,
    added_by_role: document.authorRole ?? null,
    created_at: document.createdAt,
    updated_at: document.updatedAt,
  };
}

export function serializeAiPolicy(policy: AiPolicy): Record<string, unknown> {
  return {
    id: policy.id,
    scope: policy.scope,
    instructions: policy.instructions,
    restrictions: policy.restrictions,
    is_active: policy.isActive,
    updated_at: policy.updatedAt,
  };
}

export function serializeExplanation(
  explanation: RecommendationExplanation,
): Record<string, unknown> {
  return {
    id: explanation.id,
    recommendation_id: explanation.recommendationId,
    explanation_text: explanation.explanationText,
    ai_model: explanation.aiModel,
    sources: explanation.sources ?? [],
    created_at: explanation.createdAt,
  };
}

/**
 * One chat message (migration 0019).
 *
 * `ai_request_id` travels because it is the provenance link (§13.7) and because its absence is
 * *meaningful* to the client: an assistant message with no request behind it is the deterministic
 * fallback, and the panel labels it as such rather than presenting computed text as a generation.
 */
export function serializeChatMessage(message: ChatMessage): Record<string, unknown> {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    ai_request_id: message.aiRequestId,
    sources: message.sources ?? [],
    feedback: message.feedback,
    /**
     * Whether this answer can be — or has been — nominated for the knowledge base (migration
     * 0030). `OFFERED` puts *"Request to add to knowledge"* under a no-coverage refusal; NULL, the
     * ordinary value, offers nothing.
     */
    knowledge_request: message.knowledgeRequest,
    /**
     * When the question this refusal was about got answered (migration 0033). The panel swaps
     * "Requested" for "Answered — ask again", so a student who asked is not left guessing.
     */
    knowledge_answered_at: message.knowledgeAnsweredAt,
    created_at: message.createdAt,
  };
}

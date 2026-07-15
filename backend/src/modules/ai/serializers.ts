import type { AiPolicy, KnowledgeDocument, RecommendationExplanation } from '@/db/schema';

/**
 * Allow-list serializers (F-L2 discipline): a column added next year cannot leak through a
 * spread it was never named in.
 */

export function serializeKnowledgeDocument(
  document: KnowledgeDocument & { chunkCount?: number },
): Record<string, unknown> {
  return {
    id: document.id,
    file_name: document.fileName,
    file_type: document.fileType,
    processing_status: document.processingStatus,
    visibility: document.visibility,
    archived_at: document.archivedAt,
    chunk_count: document.chunkCount ?? null,
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
    created_at: explanation.createdAt,
  };
}

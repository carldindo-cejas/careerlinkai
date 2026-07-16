import type { AssessmentCategory } from '@/types/assessment';

/**
 * The assessment builder's types (Phase 5b — FULLPLAN §20, §31).
 *
 * These mirror the **author's** API payloads, which deliberately carry what the player's
 * types (`types/assessment.ts`) deliberately omit: option scores and dimension mappings.
 * The §25 review is a human confirming *what a question measures* — a reviewer who cannot
 * see the mapping and the scores cannot meaningfully confirm anything. The two type files
 * describe two different disclosures to two different audiences, on purpose.
 */

export interface BuilderDimension {
  code: string;
  name: string;
  description: string | null;
}

export interface BuilderVersionSummary {
  id: string;
  version_number: number;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  instructions: string | null;
  duration_minutes: number | null;
  scoring_algorithm: 'HOLLAND_CODE_TOP3' | 'WEIGHTED_COMPOSITE';
  created_at: string;
}

export interface BuilderTemplate {
  id: string;
  category: AssessmentCategory;
  title: string;
  description: string | null;
  ownership: 'GLOBAL' | 'COUNSELOR_PRIVATE';
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  ai_generatable: boolean;
  dimensions?: BuilderDimension[];
  versions?: BuilderVersionSummary[];
}

export interface PublishReadiness {
  total: number;
  confirmed: number;
  remaining: number;
}

export interface AuthorOption {
  id: string;
  label: string;
  value: string;
  /** Present here and absent in the player payload — the author must see it. */
  score: number;
  order_number: number;
}

export interface AuthorMapping {
  mapping_id: string;
  code: string;
  name: string;
  weight: number;
  confirmed: boolean;
  confirmed_at: string | null;
}

export interface AuthorQuestion {
  id: string;
  question_text: string;
  question_type: 'LIKERT' | 'MULTIPLE_CHOICE' | 'BOOLEAN';
  section_label: string | null;
  order_number: number;
  required: boolean;
  source: 'MANUAL' | 'AI_GENERATED';
  source_ai_request_id: string | null;
  options: AuthorOption[];
  dimensions: AuthorMapping[];
}

export interface VersionReview extends BuilderVersionSummary {
  template: { id: string; title: string; category: AssessmentCategory };
  publish_readiness: PublishReadiness;
  questions: AuthorQuestion[];
}

export type GenerationStatus = 'PENDING' | 'FAILED' | 'VALIDATION_FAILED' | 'DRAFTED';

export interface GenerationStatusResponse {
  ai_request_id: string;
  status: GenerationStatus;
  failure_reason?: string | null;
  question_count?: number;
  /** §31 Mode A: inert suggestions — text for the reviewer, never rows. */
  suggested_dimensions?: { name: string; description: string | null }[];
}

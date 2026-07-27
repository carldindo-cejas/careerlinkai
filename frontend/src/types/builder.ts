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
  /** Migration 0016 — NULL for a draft, and for a version archived before it ever published. */
  published_at: string | null;
}

/** The three item types the builder's type selector offers. */
export type QuestionType = 'LIKERT' | 'MULTIPLE_CHOICE' | 'BOOLEAN';

export interface QuestionOptionDraft {
  label: string;
  value: string;
  score: number;
}

/**
 * One auto-save. Every field is optional and the editor sends only what changed, so toggling
 * Required is a two-field request rather than a round trip carrying the whole item back.
 *
 * `options` and `dimension_codes`, when present, are the **complete** new set — the server replaces
 * rather than merges, because a diff would have to guess what a "changed" option is and would get
 * it wrong for the case that matters: two options swapped, with different scores.
 */
export interface QuestionPatch {
  question_text?: string;
  question_type?: QuestionType;
  section_label?: string | null;
  required?: boolean;
  options?: QuestionOptionDraft[];
  dimension_codes?: string[];
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
  question_type: QuestionType;
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

/**
 * The §20 poll's states. `PENDING` (queued) and `PROCESSING` (a consumer has it) are the two
 * non-terminal ones; the other three end the poll.
 *
 * `PROCESSING` was added with the backend's `ai_requests` lifecycle: the row is now written at
 * enqueue time and advanced by the job, so the client can tell "waiting in the queue" from "the
 * model is working" — and, more importantly, so a request that stalls is a state the server can
 * time out and report as FAILED instead of an indefinite PENDING.
 */
export type GenerationStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'FAILED'
  | 'VALIDATION_FAILED'
  | 'DRAFTED';

/** The two states that mean "keep polling". Everything else is final. */
export const GENERATION_IN_FLIGHT: readonly GenerationStatus[] = ['PENDING', 'PROCESSING'];

export function isGenerationTerminal(status: GenerationStatus | undefined): boolean {
  return status !== undefined && !GENERATION_IN_FLIGHT.includes(status);
}

export interface GenerationStatusResponse {
  ai_request_id: string;
  status: GenerationStatus;
  failure_reason?: string | null;
  question_count?: number;
  /** §31 Mode A: inert suggestions — text for the reviewer, never rows. */
  suggested_dimensions?: { name: string; description: string | null }[];
}

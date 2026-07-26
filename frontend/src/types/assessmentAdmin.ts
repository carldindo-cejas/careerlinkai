import type { AssessmentCategory } from '@/types/assessment';
import type { SortDirection } from '@/types/address';

/**
 * The administrator's assessment management types (backend migration 0014).
 *
 * Mirrors `modules/assessment/serializers.ts` — `serializeAssessmentRow`, `serializeAssessmentType`
 * and `serializeAssessmentScoring` — and must stay in lockstep with them.
 *
 * The one shape worth pausing on is `AssessmentType.allowed_scoring_ids`. It is the client's copy
 * of the compatibility matrix, shipped inside the type list so the scoring multi-select can
 * re-filter the instant the type changes, with no request in the middle of a keystroke. It is a
 * **filter, not the rule**: the server validates the same pairs from the same table, so a client
 * that ignored this would be refused rather than obeyed.
 */

export interface AssessmentType {
  id: string;
  code: string;
  name: string;
  description: string | null;
  order_number: number;
  /** The scoring methods this type permits, already in the scoring lookup's display order. */
  allowed_scoring_ids: string[];
}

export interface AssessmentScoring {
  id: string;
  code: string;
  name: string;
  description: string | null;
  order_number: number;
}

/** The taxonomy references embedded in a row — name and code only; the full rows come from the lookups. */
export interface TaxonomyRef {
  id: string;
  code: string;
  name: string;
}

export interface AssessmentVersionRef {
  id: string;
  version_number: number;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
}

/**
 * How an assessment currently reaches students.
 *
 * **`scope: null` means "not assigned"** — a third state, not `'CLASS'` with a zero count. A table
 * that collapsed the two would end up printing "Specific classes (0)".
 */
export interface AssignmentSummary {
  scope: 'GLOBAL' | 'CLASS' | null;
  class_count: number;
}

export interface AssessmentRow {
  id: string;
  title: string;
  description: string | null;
  category: AssessmentCategory;
  ownership: 'GLOBAL' | 'COUNSELOR_PRIVATE';
  /** The stored template status, which drives Archive vs Restore. */
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  /** The **derived** status the Status column shows: is any version publishable. */
  is_published: boolean;
  is_archived: boolean;
  type: TaxonomyRef | null;
  scorings: TaxonomyRef[];
  /** Newest first — the table renders `v3, v2, v1` and folds the tail into "+N more". */
  versions: AssessmentVersionRef[];
  published_version: {
    id: string;
    version_number: number;
    duration_minutes: number | null;
    question_count: number;
  } | null;
  assignment: AssignmentSummary;
  ai_generatable: boolean;
  created_at: string;
  updated_at: string;
}

export type AssessmentSort = 'title' | 'type' | 'status' | 'created_at' | 'updated_at';
export type AssessmentStatusFilter = 'PUBLISHED' | 'UNPUBLISHED' | 'ARCHIVED';
export type AssessmentAssignmentFilter = 'GLOBAL' | 'CLASS' | 'UNASSIGNED';

export interface AssessmentListQuery {
  search?: string | undefined;
  assessment_type_id?: string | undefined;
  status?: AssessmentStatusFilter | undefined;
  assignment?: AssessmentAssignmentFilter | undefined;
  page?: number | undefined;
  per_page?: number | undefined;
  sort?: AssessmentSort | undefined;
  direction?: SortDirection | undefined;
}

/** Create and edit share a payload — the only difference is that create also fixes the category. */
export interface AssessmentFormPayload {
  title: string;
  description: string | null;
  assessment_type_id: string;
  scoring_ids: string[];
}

/**
 * Assigning. A discriminated union, mirroring the backend schema: `GLOBAL` carries no class list at
 * all, because its target is "every active class" resolved server-side — a client-supplied list of
 * "all classes" is a snapshot that is wrong the moment a class is created.
 */
export type AssignPayload =
  | { scope: 'GLOBAL'; assessment_version_id?: string; deadline?: string | null }
  | {
      scope: 'CLASS';
      class_ids: string[];
      assessment_version_id?: string;
      deadline?: string | null;
    };

export interface AssignResult {
  assessment: AssessmentRow;
  assigned_classes: number;
  skipped_classes: number;
  version_number: number;
}

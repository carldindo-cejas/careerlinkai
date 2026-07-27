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
  /**
   * Whether Delete is offered, and — when it is not — the sentence to show (v1.6).
   *
   * The reason is computed server-side so the disabled button's tooltip and the 422 the endpoint
   * would answer with say the same thing. A UI that phrased the refusal itself would eventually
   * phrase it differently.
   */
  can_delete: boolean;
  delete_blockers: ('HAS_RESPONSES' | 'HAS_ACTIVE_ASSIGNMENTS')[];
  delete_blocked_reason: string | null;
  response_count: number;
  active_assignment_count: number;
  created_at: string;
  updated_at: string;
  /**
   * When this assessment last became available to students — the newest `published_at` across its
   * versions. **NULL means never published**, which is a state rather than missing data.
   */
  published_at: string | null;
  /** The first time any version published — "in service since", not "last republished". */
  first_published_at: string | null;
}

/** The live re-check the confirmation dialog runs before it lets the button fire. */
export interface AssessmentDeletability {
  can_delete: boolean;
  blockers: ('HAS_RESPONSES' | 'HAS_ACTIVE_ASSIGNMENTS')[];
  reason: string | null;
  response_count: number;
  active_assignment_count: number;
}

export type AssessmentSort =
  | 'title'
  | 'type'
  | 'status'
  | 'created_at'
  | 'updated_at'
  | 'published_at';
export type AssessmentStatusFilter = 'PUBLISHED' | 'UNPUBLISHED' | 'ARCHIVED';
export type AssessmentAssignmentFilter = 'GLOBAL' | 'CLASS' | 'UNASSIGNED';

/** Which date the range picker is filtering on. Three separate server-side ranges back it. */
export const ASSESSMENT_DATE_FIELDS = ['published_at', 'created_at', 'updated_at'] as const;
export type AssessmentDateField = (typeof ASSESSMENT_DATE_FIELDS)[number];

export interface AssessmentListQuery {
  search?: string | undefined;
  assessment_type_id?: string | undefined;
  status?: AssessmentStatusFilter | undefined;
  assignment?: AssessmentAssignmentFilter | undefined;
  /** `YYYY-MM-DD`; the server snaps each bound to the right edge of its day. */
  created_from?: string | undefined;
  created_to?: string | undefined;
  updated_from?: string | undefined;
  updated_to?: string | undefined;
  published_from?: string | undefined;
  published_to?: string | undefined;
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

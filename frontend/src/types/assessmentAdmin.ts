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

/**
 * How an instrument's items are dealt to a student (backend migration 0037).
 *
 * The **items** only — answer choices are never shuffled. A Likert scale whose anchors moved
 * between questions would stop being a scale.
 */
export type PresentationMode = 'SEQUENTIAL' | 'RANDOM';

/** The named creator behind `ownership` + `creator_id` — the author relationship, resolved. */
export interface AssessmentAuthor {
  id: string;
  name: string;
  role: string;
}

export interface AssessmentRow {
  id: string;
  title: string;
  description: string | null;
  category: AssessmentCategory;
  /**
   * The **author type**: `GLOBAL` is curated administrator content, `COUNSELOR_PRIVATE` belongs to
   * the counselor in `author` and is visible only to them and their own classes' students.
   */
  ownership: 'GLOBAL' | 'COUNSELOR_PRIVATE';
  /** Who created it. Null only if that account has since been removed. */
  author: AssessmentAuthor | null;
  /** The instrument this was copied from, or null when it was authored from scratch. */
  source_template_id: string | null;
  /** `SEQUENTIAL` | `RANDOM`, switchable from the table even after publication. */
  presentation_mode: PresentationMode;
  /**
   * **What this caller may do, as the server decided it.**
   *
   * These replace the client-side `ownership !== 'GLOBAL'` guess the table used to make. That guess
   * agreed with the server only by coincidence of what a counselor's list happens to contain, and a
   * rule written twice is a rule that eventually disagrees with itself.
   */
  can_manage: boolean;
  can_copy: boolean;
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

/** What `POST /assessment-templates/{id}/copy` hands back — the new instrument and its draft v1. */
export interface CopyResult {
  assessment: AssessmentRow;
  version: {
    id: string;
    version_number: number;
    status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
    source_version_id: string | null;
  };
  question_count: number;
}

/**
 * The result of installing the two curated instruments (§22, §23).
 *
 * `created` is the whole story for the UI: `true` means this call installed them, `false` means
 * they were already there and nothing changed. The two version ids are returned so a caller could
 * link straight to them; the management page does not, because installing lands them in the table
 * it is already showing.
 *
 * **camelCase, unlike every other type in this file** — and that is a faithful description of the
 * endpoint rather than a slip here. `POST /admin/assessment-templates/seed-instruments` returns
 * `seedAssessmentInstruments`' own `SeededInstruments` struct straight into the envelope with no
 * serializer in between, so the wire shape really is camelCase. The rest of the API goes through a
 * `serialize*` function and is snake_case. Renaming the fields server-side would be the tidier
 * fix and is deliberately not bundled into this audit change: it is a live contract with backend
 * tests pinned to it, and a type that lies about the wire is worse than one that is ugly.
 */
export interface SeedInstrumentsResult {
  riasecVersionId: string | null;
  scctVersionId: string | null;
  created: boolean;
}

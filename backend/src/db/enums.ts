/**
 * The string-literal unions behind every TEXT + CHECK enum column (FULLPLAN §12).
 *
 * The CHECK constraint in the migration and the union here are the same rule written
 * twice — once for the database, once for the type checker. Keep them in lockstep: a value
 * added here without a matching migration will fail at runtime with a constraint error.
 */

export const USER_ROLES = ['admin', 'counselor', 'student'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['pending', 'active', 'inactive', 'suspended'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const STRANDS = ['Academic', 'Technical-Professional'] as const;
export type Strand = (typeof STRANDS)[number];

/** §13.2 — new classes default to `active` (ratified v1.2); only `active` accepts joins. */
export const CLASS_STATUSES = ['draft', 'active', 'archived'] as const;
export type ClassStatus = (typeof CLASS_STATUSES)[number];

/** §13.2 — an enrollment is never deleted, only `removed`; the row is the history. */
export const ENROLLMENT_STATUSES = ['active', 'removed'] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

/**
 * §13.3 — colleges and careers have two states. A college has no meaningful "entered but not
 * yet offered" state, so `draft` is deliberately absent: it belongs to programs alone.
 */
export const CATALOG_STATUSES = ['active', 'archived'] as const;
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];

/**
 * §13.3 — programs have a real third state. `draft` is a program the admin has entered but is
 * not offering, and §27 ranks only `active` programs, so choosing it at creation is a
 * meaningful act rather than a workflow artefact.
 */
export const PROGRAM_STATUSES = ['draft', 'active', 'archived'] as const;
export type ProgramStatus = (typeof PROGRAM_STATUSES)[number];

/**
 * The six RIASEC dimensions **in their canonical order** (§24, §27).
 *
 * The order is load-bearing twice over, so do not sort it: it is the tie-break sequence for
 * `HOLLAND_CODE_TOP3` scoring (R > I > A > S > E > C), and it is the alphabet a
 * `typical_riasec_code` is validated against (`lib/holland.ts`).
 */
export const RIASEC_DIMENSIONS = ['R', 'I', 'A', 'S', 'E', 'C'] as const;
export type RiasecDimension = (typeof RIASEC_DIMENSIONS)[number];

// --- Assessment (§13.4) --------------------------------------------------------------

/**
 * §13.4. **RIASEC and SCCT are permanently excluded from AI-assisted creation and editing**
 * (§5) — not in v1, not in any deferred future scope. `policies/assessment.ts` reads this
 * column as the *first* check in `generateWithAi`, before ownership, which is why even an admin
 * is refused.
 */
export const ASSESSMENT_CATEGORIES = ['RIASEC', 'SCCT', 'CUSTOM'] as const;
export type AssessmentCategory = (typeof ASSESSMENT_CATEGORIES)[number];

export const ASSESSMENT_OWNERSHIPS = ['GLOBAL', 'COUNSELOR_PRIVATE'] as const;
export type AssessmentOwnership = (typeof ASSESSMENT_OWNERSHIPS)[number];

export const TEMPLATE_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

/** §12 — once `PUBLISHED`, the version and every row beneath it is frozen forever. */
export const VERSION_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export const QUESTION_TYPES = ['LIKERT', 'MULTIPLE_CHOICE', 'BOOLEAN'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/** §13.4 (v1.1) — provenance. RIASEC/SCCT questions are `MANUAL` by construction. */
export const QUESTION_SOURCES = ['MANUAL', 'AI_GENERATED'] as const;
export type QuestionSource = (typeof QUESTION_SOURCES)[number];

export const ASSIGNMENT_STATUSES = ['ACTIVE', 'CLOSED'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

/**
 * §24 — the two scoring algorithms, selected by `assessment_versions.scoring_config.algorithm`.
 *
 * These are the *whole* extension point: §24 is one engine with two configurations precisely so
 * that a third instrument is added by writing data, never by writing new scoring code.
 */
export const SCORING_ALGORITHMS = ['HOLLAND_CODE_TOP3', 'WEIGHTED_COMPOSITE'] as const;
export type ScoringAlgorithm = (typeof SCORING_ALGORITHMS)[number];

// --- Attempt & Results (§13.5) -------------------------------------------------------

/**
 * §21 (v1.2). `EXPIRED` has a precise definition and is not a synonym for "abandoned": an
 * attempt still `IN_PROGRESS` when its assignment `CLOSED`, or one voided by a counselor reset.
 *
 * Expired attempts are never scored and never feed recommendations — that is what makes "the
 * student's latest result" resolve unambiguously to a `SCORED` attempt everywhere else.
 */
export const ATTEMPT_STATUSES = ['IN_PROGRESS', 'SUBMITTED', 'SCORED', 'EXPIRED'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

// --- Recommendation (§13.6) ----------------------------------------------------------

/**
 * §27 ranks two kinds of thing with two different formulas, and this is the discriminator.
 *
 * A college is deliberately **not** a third value: §13.6 makes a recommended college a plain join
 * (`target_program_id → programs.college_id → colleges`) rather than a stored match, because a
 * college is not something a student is matched *to* — it is where the program they matched with
 * happens to be taught.
 */
export const MATCH_TYPES = ['CAREER', 'PROGRAM'] as const;
export type MatchType = (typeof MATCH_TYPES)[number];

// --- AI / Knowledge (§13.7) ------------------------------------------------------------

export const PROCESSING_STATUSES = ['UPLOADED', 'PROCESSING', 'COMPLETED', 'FAILED'] as const;
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

/**
 * §13.7 (v1.2): v1 uses only `GLOBAL`. `COUNSELOR_PRIVATE` is deferred to §63 — it shipped in
 * v1.1 with no retrieval-scoping rule, which made it a cross-tenant leak waiting to happen.
 * The value stays in the enum so restoring it later is not a migration.
 */
export const KNOWLEDGE_VISIBILITIES = ['GLOBAL', 'COUNSELOR_PRIVATE'] as const;
export type KnowledgeVisibility = (typeof KNOWLEDGE_VISIBILITIES)[number];

export const AI_REQUEST_TYPES = [
  'RECOMMENDATION_EXPLANATION',
  'ASSESSMENT_GENERATION',
  'CHAT',
] as const;
export type AiRequestType = (typeof AI_REQUEST_TYPES)[number];

/** §29 principle 6 — every gateway call lands as exactly one row, in one of these two states. */
export const AI_REQUEST_STATUSES = ['SUCCESS', 'FAILED'] as const;
export type AiRequestStatus = (typeof AI_REQUEST_STATUSES)[number];

/** §13.7 — GLOBAL is the only v1 scope; the column extends to finer scopes later (§63). */
export const AI_POLICY_SCOPES = ['GLOBAL'] as const;
export type AiPolicyScope = (typeof AI_POLICY_SCOPES)[number];

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

/**
 * How strongly a program leads to a career (migration 0041) — the source catalog's own taxonomy.
 * `direct`: the program's natural destination. `related`: a common path for its graduates.
 * `conditional`: reachable with an extra credential or licence. The formula's `linkWeights` say how
 * much each counts; `direct` counts fully, so every link made before 0041 scores exactly as before.
 */
export const LINK_RELATIONSHIPS = ['direct', 'related', 'conditional'] as const;
export type LinkRelationship = (typeof LINK_RELATIONSHIPS)[number];
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

/**
 * How an instrument's items are dealt to a student (migration 0037).
 *
 * `SEQUENTIAL` is the authored `order_number`; `RANDOM` shuffles the items **once per attempt**,
 * at `start`, and stores the result on `assessment_attempts.question_order`. Order is not a scoring
 * input anywhere — the engine reads `assessment_answers.score` joined to `question_dimensions`,
 * neither of which knows the sequence — so this is a delivery setting on the *template*, editable
 * after publication, rather than part of a frozen version's content.
 *
 * **Items only.** Answer choices are never shuffled: a Likert scale whose anchors moved between
 * questions would stop being a scale. §8A fixes their order positive-first, and `question_options.
 * order_number` is the single place that decides it.
 */
export const PRESENTATION_MODES = ['SEQUENTIAL', 'RANDOM'] as const;
export type PresentationMode = (typeof PRESENTATION_MODES)[number];

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
 * Migration 0014 — **how** an assignment came to exist, not who it reaches.
 *
 * Every assignment still names exactly one class either way, so enrollment, authorization and the
 * §44 fan-out are untouched. `GLOBAL` marks the rows written by one administrative act across every
 * active class; `CLASS` marks the ordinary pick-a-class assignment a counselor makes.
 */
export const ASSIGNMENT_SCOPES = ['GLOBAL', 'CLASS'] as const;
export type AssignmentScope = (typeof ASSIGNMENT_SCOPES)[number];

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
 * Where a knowledge entry came from (migration 0022).
 *
 * This replaced `file_type`, which could only be `pdf | docx` — and that column was the whole
 * reason the corpus stayed empty: knowledge could only enter the system as a file somebody
 * uploaded. The values are ordered by how the content was authored, not by format:
 *
 *   * `pdf` / `docx` — an uploaded file, extracted in the admin's browser (§33 v1.5).
 *   * `text` — a pasted note, or an uploaded `.txt`/`.md` (no parser needed either way).
 *   * `qa` — one admin-authored question and its authoritative answer. The highest-value input:
 *     it embeds close to how a student actually phrases the question, and it is what Gate 1
 *     returns verbatim with no model call at all.
 *   * `catalog` — generated from a `careers` or `programs` row this system already holds, so
 *     every recommendation target has grounding *about itself* without anyone uploading anything.
 */
export const KNOWLEDGE_SOURCE_TYPES = ['pdf', 'docx', 'text', 'qa', 'catalog'] as const;
export type KnowledgeSourceType = (typeof KNOWLEDGE_SOURCE_TYPES)[number];

/**
 * The catalog things a `catalog` entry can be about (migration 0022; `college` added 2026-09-09).
 *
 * `college` is the subject the corpus was missing. Location and the list of offerings lived only
 * inside each *program* entry, whose subject is the program — so "where is Holy Name University?"
 * and "what colleges in Cebu offer BS Computer Science?" retrieved career passages and were
 * refused, while "tell me about BS Accountancy at Holy Name University" answered correctly from a
 * chunk containing the very address the first question asked for. A question about an institution
 * needs a passage whose subject is that institution.
 *
 * `entity_type` is an unconstrained TEXT column, so widening this list is a code change and not a
 * migration.
 */
// `guide` added 2026-09-13 (AI-COVERAGE-PLAN.md Phase 3): a Guidance corpus entry, keyed by slug.
export const KNOWLEDGE_ENTITY_TYPES = ['career', 'program', 'college', 'guide'] as const;
export type KnowledgeEntityType = (typeof KNOWLEDGE_ENTITY_TYPES)[number];

/** The source types an admin may author or edit in place — the rest are derived or uploaded. */
export const AUTHORED_SOURCE_TYPES = ['text', 'qa'] as const;

/**
 * §13.7 (v1.2): v1 uses only `GLOBAL`. `COUNSELOR_PRIVATE` is deferred to §63 — it shipped in
 * v1.1 with no retrieval-scoping rule, which made it a cross-tenant leak waiting to happen.
 * The value stays in the enum so restoring it later is not a migration.
 */
export const KNOWLEDGE_VISIBILITIES = ['GLOBAL', 'COUNSELOR_PRIVATE'] as const;
export type KnowledgeVisibility = (typeof KNOWLEDGE_VISIBILITIES)[number];

/**
 * How a question left the unanswered backlog (migration 0031).
 *
 * `ANSWERED` carries a `document_id` and expires with it — archive or fail that entry and the
 * question comes back, because it is genuinely unanswered again. `DISMISSED` carries no document
 * and so cannot expire: it is the judgement "nobody will ever write an entry for this", which is
 * the only honest disposition for the gibberish and test questions that otherwise accumulate in
 * the backlog forever. Reversible either way — the row is deleted to reopen the question.
 */
export const QUESTION_RESOLUTIONS = ['ANSWERED', 'DISMISSED'] as const;
export type QuestionResolution = (typeof QUESTION_RESOLUTIONS)[number];

// --- Platform (§13.8) ------------------------------------------------------------------

/**
 * §13.8 — the four notification categories. §44's five notification kinds map onto them:
 * results-ready and draft-ready are ASSESSMENT, recommendations-ready is RECOMMENDATION,
 * assignment-created is CLASS (it reaches a student *because of* a class they are in), and
 * knowledge-document-processed is ACCOUNT — §44 addresses it to the uploading admin about
 * their own action, and §13.8 offers no closer value (a resolved silence, not an invention).
 */
export const NOTIFICATION_CATEGORIES = [
  'ASSESSMENT',
  'RECOMMENDATION',
  'CLASS',
  'ACCOUNT',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const AI_REQUEST_TYPES = [
  'RECOMMENDATION_EXPLANATION',
  'ASSESSMENT_GENERATION',
  // **Reserved, not used by any v1 code path** (L1). It stays here to mirror the CHECK
  // constraint in migration 0008 (an immutable, already-applied migration lists it), and to
  // hold the slot for a future chat feature. Nothing writes an ai_requests row of this type.
  'CHAT',
] as const;
export type AiRequestType = (typeof AI_REQUEST_TYPES)[number];

/**
 * §29 principle 6 — every gateway call lands as exactly one row, and that row now carries a
 * **lifecycle** rather than only an outcome (migration 0015).
 *
 * `PENDING` is written by the endpoint that enqueues a background generation, before the queue
 * message is sent; `PROCESSING` by the consumer that picks it up. Both exist so that "in flight"
 * is a fact in the database instead of being inferred from a missing row — which is what let a
 * dropped message poll as PENDING forever. `SUCCESS` and `FAILED` are terminal.
 *
 * A synchronous caller (the §30 explanation path) writes one terminal row and never occupies the
 * middle two states. The lifecycle is available, not compulsory.
 */
export const AI_REQUEST_STATUSES = ['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED'] as const;
export type AiRequestStatus = (typeof AI_REQUEST_STATUSES)[number];

/** The two states a row can be *stuck* in — what the deadline and the nightly sweep look for. */
export const AI_REQUEST_IN_FLIGHT_STATUSES = ['PENDING', 'PROCESSING'] as const;

/** §13.7 — GLOBAL is the only v1 scope; the column extends to finer scopes later (§63). */
export const AI_POLICY_SCOPES = ['GLOBAL'] as const;
export type AiPolicyScope = (typeof AI_POLICY_SCOPES)[number];

/**
 * The two roles a stored chat transcript contains (migration 0019).
 *
 * There is deliberately no `system` value. The system prompt is assembled at call time from the
 * prompt module plus the active AI policy (§32) precisely so that it is editable in one place; a
 * stored copy per message would be a stale duplicate of something meant to change.
 */
export const CHAT_ROLES = ['user', 'assistant'] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];

/**
 * Which gate produced an assistant message (migration 0029).
 *
 * Recorded rather than inferred. The panel used to derive "this was not generated" from
 * `ai_request_id IS NULL`, which was already wrong for a Gate 1 answer — an admin's own words are
 * the *best* answer this system gives, not a degraded one — and became unrecoverable once two
 * ungrounded-adjacent tiers existed: "generated, no sources" would mean either "from the student's
 * own computed results" or "from the model's general knowledge", and a student is entitled to know
 * which of those they are reading.
 *
 * Ordered from most grounded to least, which is also the order the gates run in.
 */
export const CHAT_ANSWER_KINDS = ['CURATED', 'KNOWLEDGE', 'WEB', 'GENERAL', 'CANNED'] as const;
export type ChatAnswerKind = (typeof CHAT_ANSWER_KINDS)[number];

/**
 * The "Request to add to knowledge" lifecycle on a chat answer (migration 0030).
 *
 * `OFFERED` is written when the assistant refuses for want of coverage — the state that puts the
 * button on screen. `REQUESTED` is the student having pressed it, and is what ranks the admin's
 * backlog: a question two students asked to have answered outranks one the pipeline merely failed.
 *
 * NULL is every other message, and is not a claim about them — a refusal written before this
 * column existed simply does not offer the button.
 */
export const KNOWLEDGE_REQUEST_STATES = ['OFFERED', 'REQUESTED'] as const;
export type KnowledgeRequestState = (typeof KNOWLEDGE_REQUEST_STATES)[number];

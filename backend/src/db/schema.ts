import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import type {
  AiPolicyScope,
  AiRequestStatus,
  AiRequestType,
  AssessmentCategory,
  AssessmentOwnership,
  AssignmentStatus,
  AttemptStatus,
  CatalogStatus,
  ClassStatus,
  EnrollmentStatus,
  KnowledgeVisibility,
  MatchType,
  ProcessingStatus,
  ProgramStatus,
  QuestionSource,
  QuestionType,
  ScoringAlgorithm,
  Strand,
  TemplateStatus,
  UserRole,
  UserStatus,
  VersionStatus,
} from '@/db/enums';

/**
 * The single typed definition of every table (FULLPLAN §16) — there are no per-model
 * classes; Drizzle's inferred row types (`typeof users.$inferSelect`) are what Eloquent
 * models used to be.
 *
 * This file must stay a faithful mirror of `migrations/` — Drizzle is used as a query
 * builder here, never as a migration generator, because §57 requires the schema be
 * written once as plain SQL.
 *
 * Timestamps are ISO-8601 UTC strings rather than Drizzle's `timestamp` mode: D1 stores
 * them as TEXT either way, and keeping them as strings means what the API serializes is
 * exactly what the database holds, with no timezone reinterpretation in between.
 */

const timestamp = (column: string) => text(column);

/**
 * The two JSON column shapes (§12 permits JSON only for configuration/formula data, never for
 * business fields — so these two, and nothing else).
 */

/** `assessment_dimensions.interpretation_ranges` (§22) — the banding that turns 84.0 into "High". */
export interface InterpretationRange {
  min: number;
  max: number;
  label: string;
}

/**
 * `assessment_versions.scoring_config` (§24) — **the entire extension point of the scoring
 * engine.** A third instrument is added by writing one of these, never by writing new code.
 *
 * `composite_weights` and `composite_ranges` are read only by `WEIGHTED_COMPOSITE`. For SCCT
 * (§23) the weights are SE 0.40, OE 0.30, GO 0.30, keyed by dimension `code`, and the ranges are
 * the bands that turn the Career Confidence Index into the sentence in `overall_summary`
 * ("Moderately High Career Confidence"). Those bands are the *instrument's* claim about what a
 * number means, so they are data on the version — not a constant in the scorer.
 */
export interface ScoringConfig {
  algorithm: ScoringAlgorithm;
  composite_weights?: Record<string, number>;
  composite_ranges?: InterpretationRange[];
}

const createdAt = () =>
  text('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`);

const updatedAt = () =>
  text('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`);

// --- Identity & Access (§13.1) -------------------------------------------------------

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey().notNull(),
    name: text('name').notNull(),
    email: text('email'),
    /** PBKDF2-SHA256 hash (§38). Always NULL for students — passwordless by design. */
    password: text('password'),
    role: text('role').$type<UserRole>().notNull(),
    status: text('status').$type<UserStatus>().notNull().default('pending'),
    mustChangePassword: integer('must_change_password', { mode: 'boolean' })
      .notNull()
      .default(false),
    emailVerifiedAt: timestamp('email_verified_at'),
    lastLoginAt: timestamp('last_login_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => [
    uniqueIndex('users_email_unique').on(table.email),
    index('users_role_index').on(table.role),
    index('users_status_index').on(table.status),
  ],
);

export const counselorProfiles = sqliteTable(
  'counselor_profiles',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    phone: text('phone'),
    employeeNumber: text('employee_number'),
    specialization: text('specialization'),
    bio: text('bio'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('counselor_profiles_user_id_unique').on(table.userId)],
);

export const studentProfiles = sqliteTable(
  'student_profiles',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    firstName: text('first_name').notNull(),
    /** Nullable (v1.2): a mononym is a legitimate name, not a validation error (§16). */
    lastName: text('last_name'),
    birthdate: text('birthdate'),
    gender: text('gender'),
    gradeLevel: text('grade_level'),
    strand: text('strand').$type<Strand>(),
    gwa: real('gwa'),
    mathGrade: real('math_grade'),
    scienceGrade: real('science_grade'),
    englishGrade: real('english_grade'),
    guardianName: text('guardian_name'),
    guardianContact: text('guardian_contact'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('student_profiles_user_id_unique').on(table.userId)],
);

// --- Infrastructure (§13.1 — not part of the 28-table domain count) ------------------

export const apiTokens = sqliteTable(
  'api_tokens',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the opaque bearer token. The plaintext is never stored (§38). */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at'),
    lastUsedAt: timestamp('last_used_at'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('api_tokens_token_hash_unique').on(table.tokenHash),
    index('api_tokens_user_id_index').on(table.userId),
  ],
);

export const passwordResetTokens = sqliteTable('password_reset_tokens', {
  email: text('email').primaryKey().notNull(),
  tokenHash: text('token_hash').notNull(),
  createdAt: createdAt(),
});

// --- Class & Enrollment (§13.2) ------------------------------------------------------

export const classes = sqliteTable(
  'classes',
  {
    id: text('id').primaryKey().notNull(),
    counselorId: text('counselor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    academicYear: text('academic_year').notNull(),
    gradeLevel: text('grade_level'),
    /** Generated at creation, never accepted as client input (§38). */
    joinCode: text('join_code').notNull(),
    joinCodeExpiresAt: timestamp('join_code_expires_at'),
    status: text('status').$type<ClassStatus>().notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => [
    uniqueIndex('classes_join_code_unique').on(table.joinCode),
    index('classes_counselor_id_index').on(table.counselorId),
    index('classes_status_index').on(table.status),
  ],
);

/**
 * No `createdAt`/`updatedAt` — `joinedAt`/`removedAt` are the lifecycle timestamps. The one
 * sanctioned exception to the §12 timestamp rule (ratified v1.2).
 */
export const classStudents = sqliteTable(
  'class_students',
  {
    id: text('id').primaryKey().notNull(),
    classId: text('class_id')
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Unique per class, not globally (§13.2). */
    username: text('username').notNull(),
    status: text('status').$type<EnrollmentStatus>().notNull().default('active'),
    joinedAt: text('joined_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    removedAt: timestamp('removed_at'),
  },
  (table) => [
    uniqueIndex('class_students_class_student_unique').on(table.classId, table.studentId),
    uniqueIndex('class_students_class_username_unique').on(table.classId, table.username),
    index('class_students_student_id_index').on(table.studentId),
  ],
);

// --- Academic Catalog (§13.3) --------------------------------------------------------

/**
 * A real table since v1.1 — it was denormalized text on `programs` in v1.0 and drifted
 * (misspellings, inconsistent naming across many rows). Promoting it is why §27 can derive a
 * recommended college as a plain join rather than by matching strings.
 */
export const colleges = sqliteTable(
  'colleges',
  {
    id: text('id').primaryKey().notNull(),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').$type<CatalogStatus>().notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => [index('colleges_status_index').on(table.status), index('colleges_name_index').on(table.name)],
);

export const programs = sqliteTable(
  'programs',
  {
    id: text('id').primaryKey().notNull(),
    collegeId: text('college_id')
      .notNull()
      .references(() => colleges.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    departmentName: text('department_name'),
    description: text('description'),
    /** NULL is a claim — "no strand requirement" — which §27 scores as 100, not as a gap. */
    recommendedStrand: text('recommended_strand').$type<Strand>(),
    status: text('status').$type<ProgramStatus>().notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => [
    index('programs_college_id_index').on(table.collegeId),
    index('programs_status_index').on(table.status),
    index('programs_college_code_index').on(table.collegeId, table.code),
  ],
);

export const careers = sqliteTable(
  'careers',
  {
    id: text('id').primaryKey().notNull(),
    title: text('title').notNull(),
    description: text('description'),
    salaryRange: text('salary_range'),
    employmentOutlook: text('employment_outlook'),
    /** Up to three distinct RIASEC letters, dominant first (`lib/holland.ts`). NULL is valid. */
    typicalRiasecCode: text('typical_riasec_code'),
    status: text('status').$type<CatalogStatus>().notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => [index('careers_status_index').on(table.status), index('careers_title_index').on(table.title)],
);

/**
 * Three columns, exactly as §13.3 specifies — **no timestamps**. Unlike `class_students`,
 * which is an enrollment a real student lived through, this row records no event: it is set
 * membership, and unlinking hard-deletes it.
 *
 * The unique index is a *scoring* invariant, not a bookkeeping one: §27 averages over every
 * linked career, so a duplicate link would give one career two votes.
 */
export const programCareers = sqliteTable(
  'program_careers',
  {
    id: text('id').primaryKey().notNull(),
    programId: text('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
    careerId: text('career_id')
      .notNull()
      .references(() => careers.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('program_careers_program_career_unique').on(table.programId, table.careerId),
    index('program_careers_program_id_index').on(table.programId),
    index('program_careers_career_id_index').on(table.careerId),
  ],
);

// --- Assessment (§13.4) --------------------------------------------------------------

/**
 * The instrument. **Nothing downstream ever points at a template** — assignments and attempts
 * always name a specific `assessment_version_id`, which is what stops an edit today from
 * rewriting what a student was told last year (§12).
 */
export const assessmentTemplates = sqliteTable(
  'assessment_templates',
  {
    id: text('id').primaryKey().notNull(),
    creatorId: text('creator_id')
      .notNull()
      .references(() => users.id),
    /** RIASEC/SCCT can never be AI-generated or AI-edited (§5) — checked in the policy first. */
    category: text('category').$type<AssessmentCategory>().notNull(),
    title: text('title').notNull(),
    description: text('description'),
    ownership: text('ownership').$type<AssessmentOwnership>().notNull().default('GLOBAL'),
    status: text('status').$type<TemplateStatus>().notNull().default('DRAFT'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => [
    index('assessment_templates_creator_id_index').on(table.creatorId),
    index('assessment_templates_category_index').on(table.category),
    index('assessment_templates_status_index').on(table.status),
  ],
);

/** Once `PUBLISHED`, this row and every question/option/mapping beneath it is frozen (§12). */
export const assessmentVersions = sqliteTable(
  'assessment_versions',
  {
    id: text('id').primaryKey().notNull(),
    assessmentTemplateId: text('assessment_template_id')
      .notNull()
      .references(() => assessmentTemplates.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    instructions: text('instructions'),
    durationMinutes: integer('duration_minutes'),
    /** `{ algorithm, composite_weights? }` — §24's entire extension point. */
    scoringConfig: text('scoring_config', { mode: 'json' })
      .$type<ScoringConfig>()
      .notNull()
      .default({ algorithm: 'HOLLAND_CODE_TOP3' }),
    status: text('status').$type<VersionStatus>().notNull().default('DRAFT'),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('assessment_versions_template_number_unique').on(
      table.assessmentTemplateId,
      table.versionNumber,
    ),
    index('assessment_versions_template_id_index').on(table.assessmentTemplateId),
    index('assessment_versions_status_index').on(table.status),
    index('assessment_versions_created_by_index').on(table.createdBy),
  ],
);

/**
 * Template-scoped, which is the whole reason the **dimension freeze rule** (§12, v1.2) has to
 * exist on its own: version immutability does not reach these rows, yet `question_dimensions`,
 * `dimension_scores` and the Holland-code derivation all hang off them.
 */
export const assessmentDimensions = sqliteTable(
  'assessment_dimensions',
  {
    id: text('id').primaryKey().notNull(),
    assessmentTemplateId: text('assessment_template_id')
      .notNull()
      .references(() => assessmentTemplates.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** `[{ min, max, label }]` (§22). Frozen after first publish — a slid band rewrites history. */
    interpretationRanges: text('interpretation_ranges', { mode: 'json' })
      .$type<InterpretationRange[]>(),
    /** **Scoring data, not display order** — §22's Holland-code tie-break reads it (§24). */
    orderNumber: integer('order_number').notNull().default(1),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('assessment_dimensions_template_code_unique').on(
      table.assessmentTemplateId,
      table.code,
    ),
    index('assessment_dimensions_template_id_index').on(table.assessmentTemplateId),
  ],
);

export const assessmentQuestions = sqliteTable(
  'assessment_questions',
  {
    id: text('id').primaryKey().notNull(),
    assessmentVersionId: text('assessment_version_id')
      .notNull()
      .references(() => assessmentVersions.id, { onDelete: 'cascade' }),
    questionText: text('question_text').notNull(),
    questionType: text('question_type').$type<QuestionType>().notNull(),
    /** Sent to the player as a heading. Groups 60 items without revealing what one item scores. */
    sectionLabel: text('section_label'),
    orderNumber: integer('order_number').notNull(),
    required: integer('required', { mode: 'boolean' }).notNull().default(true),
    source: text('source').$type<QuestionSource>().notNull().default('MANUAL'),
    /** FK → `ai_requests.id` once that Phase 5a table exists; no REFERENCES yet (see 0005). */
    sourceAiRequestId: text('source_ai_request_id'),
    createdAt: createdAt(),
  },
  (table) => [
    index('assessment_questions_version_id_index').on(table.assessmentVersionId),
    index('assessment_questions_version_order_index').on(
      table.assessmentVersionId,
      table.orderNumber,
    ),
  ],
);

export const questionOptions = sqliteTable(
  'question_options',
  {
    id: text('id').primaryKey().notNull(),
    questionId: text('question_id')
      .notNull()
      .references(() => assessmentQuestions.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    value: text('value').notNull(),
    /** **Never serialized to a student** (§37) — see `serializeQuestion`. */
    score: real('score').notNull(),
    orderNumber: integer('order_number').notNull(),
  },
  (table) => [index('question_options_question_id_index').on(table.questionId)],
);

/**
 * **The confirmation gate** (§25). `confirmedAt IS NULL` blocks publish — and it is only ever
 * NULL for an AI-proposed mapping, because a human typing one in the builder has it set at
 * insert time. This row is what decides *what a question measures and how strongly*, which is
 * the one thing AI could change invisibly.
 */
export const questionDimensions = sqliteTable(
  'question_dimensions',
  {
    id: text('id').primaryKey().notNull(),
    questionId: text('question_id')
      .notNull()
      .references(() => assessmentQuestions.id, { onDelete: 'cascade' }),
    dimensionId: text('dimension_id')
      .notNull()
      .references(() => assessmentDimensions.id, { onDelete: 'cascade' }),
    weight: real('weight').notNull().default(1),
    confirmedAt: timestamp('confirmed_at'),
    confirmedBy: text('confirmed_by').references(() => users.id),
  },
  (table) => [
    uniqueIndex('question_dimensions_question_dimension_unique').on(
      table.questionId,
      table.dimensionId,
    ),
    index('question_dimensions_question_id_index').on(table.questionId),
    index('question_dimensions_dimension_id_index').on(table.dimensionId),
    index('question_dimensions_confirmed_at_index').on(table.confirmedAt),
  ],
);

/** A **version**, never a template (§13.4) — and it must be `PUBLISHED` (a draft is a 422). */
export const assessmentAssignments = sqliteTable(
  'assessment_assignments',
  {
    id: text('id').primaryKey().notNull(),
    assessmentVersionId: text('assessment_version_id')
      .notNull()
      .references(() => assessmentVersions.id),
    classId: text('class_id')
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    assignedBy: text('assigned_by')
      .notNull()
      .references(() => users.id),
    deadline: timestamp('deadline'),
    status: text('status').$type<AssignmentStatus>().notNull().default('ACTIVE'),
    createdAt: createdAt(),
  },
  (table) => [
    index('assessment_assignments_version_id_index').on(table.assessmentVersionId),
    index('assessment_assignments_class_id_index').on(table.classId),
    index('assessment_assignments_status_index').on(table.status),
    index('assessment_assignments_assigned_by_index').on(table.assignedBy),
  ],
);

// --- Attempt & Results (§13.5) --------------------------------------------------------
//
// **No soft deletes anywhere in this module** (§12). This chain is permanent historical
// evidence — what a student was asked, what they said, what the system concluded. An attempt
// that should not count becomes EXPIRED; nothing here is ever removed.

export const assessmentAttempts = sqliteTable(
  'assessment_attempts',
  {
    id: text('id').primaryKey().notNull(),
    assignmentId: text('assignment_id')
      .notNull()
      .references(() => assessmentAssignments.id, { onDelete: 'cascade' }),
    /** Denormalized (§13.5): the attempt must resolve to its version even after the assignment closes. */
    assessmentVersionId: text('assessment_version_id')
      .notNull()
      .references(() => assessmentVersions.id),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id),
    status: text('status').$type<AttemptStatus>().notNull().default('IN_PROGRESS'),
    startedAt: text('started_at').notNull(),
    submittedAt: timestamp('submitted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Mirrors the migration's **partial** unique index (live states only) — a plain unique on
    // (assignment, student) would make the counselor reset impossible, because the EXPIRED row
    // still occupies the pair. Drizzle is a query builder here, not the migration source, so
    // this declaration is documentation; the migration is what D1 enforces.
    index('assessment_attempts_assignment_id_index').on(table.assignmentId),
    index('assessment_attempts_student_id_index').on(table.studentId),
    index('assessment_attempts_version_id_index').on(table.assessmentVersionId),
    index('assessment_attempts_status_index').on(table.status),
    index('assessment_attempts_student_status_index').on(table.studentId, table.status),
  ],
);

export const assessmentAnswers = sqliteTable(
  'assessment_answers',
  {
    id: text('id').primaryKey().notNull(),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => assessmentAttempts.id, { onDelete: 'cascade' }),
    questionId: text('question_id')
      .notNull()
      .references(() => assessmentQuestions.id),
    selectedOptionId: text('selected_option_id').references(() => questionOptions.id),
    answerText: text('answer_text'),
    /**
     * **Snapshotted server-side from the chosen option** (§13.5), never client-supplied. It is
     * also why a scored attempt is re-derivable years later: the engine reads this frozen value,
     * never a live join through `question_options`.
     */
    score: real('score').notNull(),
    answeredAt: text('answered_at').notNull(),
  },
  (table) => [
    uniqueIndex('assessment_answers_attempt_question_unique').on(table.attemptId, table.questionId),
    index('assessment_answers_attempt_id_index').on(table.attemptId),
    index('assessment_answers_question_id_index').on(table.questionId),
  ],
);

/**
 * **An absent row means "not measured", which is not the same claim as zero** (§24). When every
 * question on a dimension was optional and skipped, no row is written — a stored 0.00 would be
 * sorted into a Holland Code as a real dimension and averaged into a recommendation as a real
 * number. Nothing in the scoring path may backfill a zero here.
 */
export const dimensionScores = sqliteTable(
  'dimension_scores',
  {
    id: text('id').primaryKey().notNull(),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => assessmentAttempts.id, { onDelete: 'cascade' }),
    dimensionId: text('dimension_id')
      .notNull()
      .references(() => assessmentDimensions.id),
    rawScore: real('raw_score').notNull(),
    normalizedScore: real('normalized_score').notNull(),
    interpretation: text('interpretation'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('dimension_scores_attempt_dimension_unique').on(table.attemptId, table.dimensionId),
    index('dimension_scores_attempt_id_index').on(table.attemptId),
    index('dimension_scores_dimension_id_index').on(table.dimensionId),
  ],
);

export const assessmentResults = sqliteTable(
  'assessment_results',
  {
    id: text('id').primaryKey().notNull(),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => assessmentAttempts.id, { onDelete: 'cascade' }),
    /** **Display only** (§23, v1.2). Part VII recomputes the index from `dimension_scores`. */
    overallSummary: text('overall_summary'),
    /** "IAS" for RIASEC; NULL for SCCT and for an ungraded CUSTOM assessment. */
    resultCode: text('result_code'),
    generatedAt: text('generated_at').notNull(),
  },
  (table) => [uniqueIndex('assessment_results_attempt_id_unique').on(table.attemptId)],
);

// --- Recommendation (§13.6) ----------------------------------------------------------

/**
 * The deterministic half of a recommendation. Every column here is computed by §27's arithmetic
 * and is reproducible from the same inputs (§26) — nothing a model said reaches this table.
 */
export const recommendations = sqliteTable(
  'recommendations',
  {
    id: text('id').primaryKey().notNull(),
    /** The **RIASEC** result this was computed from — see the migration for why RIASEC and not SCCT. */
    assessmentResultId: text('assessment_result_id')
      .notNull()
      .references(() => assessmentResults.id, { onDelete: 'cascade' }),
    /** Denormalized: every read of this table is "this student's recommendations". */
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    matchType: text('match_type').$type<MatchType>().notNull(),
    targetCareerId: text('target_career_id').references(() => careers.id, { onDelete: 'cascade' }),
    targetProgramId: text('target_program_id').references(() => programs.id, {
      onDelete: 'cascade',
    }),
    matchScore: real('match_score').notNull(),
    /** 1 = best **within its own type**. A career's 69.1 and a program's 76.1 are not comparable. */
    ranking: integer('ranking').notNull(),
    reason: text('reason').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // Mirrors the migration. This is what makes regeneration idempotent rather than duplicative:
    // §26 promises the same inputs produce the same ranking, so a second run for the same result
    // must not leave two rank-1 careers behind.
    uniqueIndex('recommendations_result_type_ranking_unique').on(
      table.assessmentResultId,
      table.matchType,
      table.ranking,
    ),
    index('recommendations_student_id_index').on(table.studentId),
    index('recommendations_assessment_result_id_index').on(table.assessmentResultId),
    index('recommendations_target_career_id_index').on(table.targetCareerId),
    index('recommendations_target_program_id_index').on(table.targetProgramId),
  ],
);

/**
 * The AI half — a separate table on purpose (§13.6). This is the one place in the schema where the
 * deterministic/AI boundary is structural rather than conventional. Phase 5a writes it; nothing
 * does yet.
 */
export const recommendationExplanations = sqliteTable(
  'recommendation_explanations',
  {
    id: text('id').primaryKey().notNull(),
    recommendationId: text('recommendation_id')
      .notNull()
      .references(() => recommendations.id, { onDelete: 'cascade' }),
    explanationText: text('explanation_text').notNull(),
    aiModel: text('ai_model').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('recommendation_explanations_recommendation_id_unique').on(table.recommendationId),
  ],
);

// --- AI / Knowledge (§13.7) ------------------------------------------------------------

/**
 * The retrieval corpus for the §30 RAG pipeline. The raw file lives in R2 (extraction happens
 * in the admin's browser — §33 v1.5, the Free plan has no server-side CPU home for a parser);
 * the text lives in `knowledge_chunks`; the embeddings live in Vectorize, never here.
 */
export const knowledgeDocuments = sqliteTable(
  'knowledge_documents',
  {
    id: text('id').primaryKey().notNull(),
    uploadedBy: text('uploaded_by')
      .notNull()
      .references(() => users.id),
    fileName: text('file_name').notNull(),
    fileType: text('file_type').$type<'pdf' | 'docx'>().notNull(),
    /** The R2 object key — the original is retained to settle any extraction dispute. */
    storagePath: text('storage_path').notNull(),
    processingStatus: text('processing_status').$type<ProcessingStatus>().notNull(),
    visibility: text('visibility').$type<KnowledgeVisibility>().notNull(),
    /**
     * Archived, never hard-deleted (§13.7 v1.2). Archiving removes the chunks' vectors from
     * Vectorize — the exclusion is structural, not a query-time filter that could be
     * forgotten (§30) — while the rows stay for `ai_requests.input_context` provenance.
     */
    archivedAt: text('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('knowledge_documents_uploaded_by_index').on(table.uploadedBy),
    index('knowledge_documents_processing_status_index').on(table.processingStatus),
  ],
);

export const knowledgeChunks = sqliteTable(
  'knowledge_chunks',
  {
    id: text('id').primaryKey().notNull(),
    documentId: text('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
    chunkNumber: integer('chunk_number').notNull(),
    content: text('content').notNull(),
    /** NULL until the embedding batch lands — the idempotency check for `GenerateEmbeddingJob`. */
    vectorId: text('vector_id'),
    tokenCount: integer('token_count'),
    createdAt: createdAt(),
  },
  (table) => [
    index('knowledge_chunks_document_id_index').on(table.documentId),
    uniqueIndex('knowledge_chunks_document_number_unique').on(table.documentId, table.chunkNumber),
  ],
);

/**
 * One row per `AiGatewayService` call, success or failure, no exceptions (§29 principle 6).
 * A quota-exhausted call is a FAILED row like any other model failure (§30 v1.5).
 */
export const aiRequests = sqliteTable(
  'ai_requests',
  {
    id: text('id').primaryKey().notNull(),
    /** Nullable: a system-triggered request (the queued explanation job) has no acting user. */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    requestType: text('request_type').$type<AiRequestType>().notNull(),
    /** Retrieved chunk ids + prompt variables — what the model was shown, recoverable later. */
    inputContext: text('input_context', { mode: 'json' }).$type<Record<string, unknown>>(),
    responseText: text('response_text'),
    model: text('model'),
    tokensUsed: integer('tokens_used'),
    latencyMs: integer('latency_ms'),
    status: text('status').$type<AiRequestStatus>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('ai_requests_user_id_index').on(table.userId),
    index('ai_requests_user_created_index').on(table.userId, table.createdAt),
  ],
);

/**
 * The admin-editable half of every prompt (§32): `instructions` and `restrictions` are
 * appended to both pipelines' system prompts at generation time. Deliberately minimal — not
 * a prompt CMS (§63); the prompts themselves are versioned files in the repository.
 */
export const aiPolicies = sqliteTable(
  'ai_policies',
  {
    id: text('id').primaryKey().notNull(),
    scope: text('scope').$type<AiPolicyScope>().notNull(),
    instructions: text('instructions'),
    restrictions: text('restrictions'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    updatedBy: text('updated_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('ai_policies_updated_by_index').on(table.updatedBy)],
);

// --- Platform (§13.8) ----------------------------------------------------------------

/**
 * Append-only (§13.8). `AuditService` is the sole writer and nothing anywhere issues an
 * UPDATE or DELETE against this table — the immutability is a code rule, since SQLite
 * cannot express it.
 */
export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey().notNull(),
    /** Nullable: system actions, and failed joins where no user was ever resolved. */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    module: text('module').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    oldValues: text('old_values', { mode: 'json' }).$type<Record<string, unknown>>(),
    newValues: text('new_values', { mode: 'json' }).$type<Record<string, unknown>>(),
    ipAddress: text('ip_address'),
    createdAt: createdAt(),
  },
  (table) => [
    index('audit_logs_user_id_index').on(table.userId),
    index('audit_logs_action_index').on(table.action),
    index('audit_logs_created_at_index').on(table.createdAt),
  ],
);

export type User = typeof users.$inferSelect;
export type CounselorProfile = typeof counselorProfiles.$inferSelect;
export type StudentProfile = typeof studentProfiles.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type ClassRoom = typeof classes.$inferSelect;
export type ClassStudent = typeof classStudents.$inferSelect;
export type College = typeof colleges.$inferSelect;
export type Program = typeof programs.$inferSelect;
export type Career = typeof careers.$inferSelect;
export type ProgramCareer = typeof programCareers.$inferSelect;
export type AssessmentTemplate = typeof assessmentTemplates.$inferSelect;
export type AssessmentVersion = typeof assessmentVersions.$inferSelect;
export type AssessmentDimension = typeof assessmentDimensions.$inferSelect;
export type AssessmentQuestion = typeof assessmentQuestions.$inferSelect;
export type QuestionOption = typeof questionOptions.$inferSelect;
export type QuestionDimension = typeof questionDimensions.$inferSelect;
export type AssessmentAssignment = typeof assessmentAssignments.$inferSelect;
export type AssessmentAttempt = typeof assessmentAttempts.$inferSelect;
export type AssessmentAnswer = typeof assessmentAnswers.$inferSelect;
export type DimensionScore = typeof dimensionScores.$inferSelect;
export type AssessmentResult = typeof assessmentResults.$inferSelect;
export type Recommendation = typeof recommendations.$inferSelect;
export type RecommendationExplanation = typeof recommendationExplanations.$inferSelect;
export type KnowledgeDocument = typeof knowledgeDocuments.$inferSelect;
export type KnowledgeChunk = typeof knowledgeChunks.$inferSelect;
export type AiRequest = typeof aiRequests.$inferSelect;
export type AiPolicy = typeof aiPolicies.$inferSelect;

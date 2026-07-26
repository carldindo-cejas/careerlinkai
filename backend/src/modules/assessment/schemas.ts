import { z } from 'zod';

import { QUESTION_TYPES, SCORING_ALGORITHMS, STRANDS } from '@/db/enums';

/**
 * The assessment module's write contracts (FULLPLAN §37, `docs/api/phase-3-assessment-engine.md`).
 */

/**
 * Grades are bounded **60–100**, and this is real validation rather than decoration.
 *
 * §27 *scores* a GWA — `academic_fit = ((gwa - 75) / 20) × 100` — rather than sanity-checking it.
 * A typo'd `9.2` would sail through, clamp to 0, and quietly wreck every program recommendation
 * the student ever sees, with nothing anywhere reporting an error. **This endpoint is the only
 * place in the system that can catch it.**
 */
const grade = z
  .number()
  .min(60, 'A grade must be at least 60.')
  .max(100, 'A grade cannot exceed 100.');

/**
 * `strand` is the strict two-value enum (§13.1, v1.2).
 *
 * "STEM" is a *track within* Academic and is rejected. §27 is built on exactly two branches, and
 * offering four options that silently map down to two would be a lie about what the engine can
 * actually tell apart.
 */
export const updateStudentProfileSchema = z
  .object({
    birthdate: z.string().date().nullable(),
    gender: z.string().max(30).nullable(),
    grade_level: z.string().max(20).nullable(),
    strand: z.enum(STRANDS).nullable(),
    gwa: grade.nullable(),
    math_grade: grade.nullable(),
    science_grade: grade.nullable(),
    english_grade: grade.nullable(),
    guardian_name: z.string().max(150).nullable(),
    guardian_contact: z.string().max(30).nullable(),
  })
  .partial()
  // `first_name` / `last_name` are absent on purpose — they belong to the counselor's roster
  // (§16), and `.strict()` is what turns "we do not read that field" into "that field is
  // rejected", so an attempt to rename oneself is an error rather than a silent no-op.
  .strict();

export type UpdateStudentProfileInput = z.infer<typeof updateStudentProfileSchema>;

/**
 * **No `score` field, deliberately** (§13.5). The server snapshots it from the chosen option; a
 * client that could supply its own score would be scoring its own assessment. `.strict()` means a
 * client that tries is refused rather than ignored.
 */
export const saveAnswerSchema = z
  .object({
    question_id: z.string().uuid(),
    selected_option_id: z.string().uuid(),
  })
  .strict();

export type SaveAnswerInput = z.infer<typeof saveAnswerSchema>;

/** **A version, never a template** (§13.4) — and the service additionally requires it be PUBLISHED. */
export const createAssignmentSchema = z
  .object({
    assessment_version_id: z.string().uuid(),
    deadline: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;

/**
 * In practice this endpoint exists to **close** an assignment — which is not a status flip: it
 * expires every attempt still in progress underneath it (§21).
 */
export const updateAssignmentSchema = z
  .object({
    status: z.enum(['CLOSED']),
  })
  .strict();

export type UpdateAssignmentInput = z.infer<typeof updateAssignmentSchema>;

// --- The builder + generation contracts (Phase 5b, §20/§31) ----------------------------------

/**
 * The taxonomy fields every assessment now carries (migration 0014).
 *
 * **`scoring_ids` is required and non-empty at the schema, while the compatibility rule is not.**
 * That split is deliberate: "you must choose a scoring method" is a fact about the shape of the
 * request and belongs here, whereas "Percentage Scores is not valid for an Interest inventory" is a
 * fact about *rows in `assessment_type_scorings`* — Zod cannot read the database, and duplicating
 * the matrix here as a hard-coded map is exactly the drift the join table exists to prevent. The
 * Service checks it (`AssessmentTaxonomyService.assertCompatible`) and answers with the same 422
 * shape, keyed on `scoring_ids`, so the form does not have to care which layer refused it.
 */
const taxonomyFields = {
  assessment_type_id: z.string().uuid('Choose an assessment type.'),
  scoring_ids: z
    .array(z.string().uuid())
    .min(1, 'Choose at least one scoring method.')
    .max(15, 'There are only 15 scoring methods.'),
};

/**
 * `category` is a literal `'CUSTOM'`, not the three-value enum, and that is the point: RIASEC
 * and SCCT are the two globally-curated instruments (§4, seeded through `seed-instruments`), so
 * "create a second RIASEC" is not a request this API can mean. `.strict()` turns the attempt
 * into a 422 rather than a silently ignored field.
 */
export const createTemplateSchema = z
  .object({
    category: z.literal('CUSTOM'),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable().optional(),
    ...taxonomyFields,
  })
  .strict();

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

/**
 * Editing an assessment's description of itself.
 *
 * `category` and `ownership` are deliberately absent: a CUSTOM template cannot become RIASEC (§4),
 * and re-homing someone's private instrument is not an edit. `.strict()` makes either attempt a 422
 * rather than a field that is quietly dropped.
 */
export const updateTemplateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable().optional(),
    ...taxonomyFields,
  })
  .strict();

export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;

// --- The administrator's assessment list (prompt-driven, v1.5) --------------------------------

/** Sortable columns — an allow-list, so `?sort=` can never name an arbitrary column. */
export const ASSESSMENT_SORTS = ['title', 'type', 'status', 'created_at', 'updated_at'] as const;
export type AssessmentSort = (typeof ASSESSMENT_SORTS)[number];

/**
 * The list's `Status` filter, which is **derived rather than stored**: an assessment is "Published"
 * when some version of it is, and the template's own `status` column only distinguishes archived
 * from not. Offering the raw column here would let an administrator filter by DRAFT/ACTIVE — two
 * values that mean nothing on this screen — instead of by the thing the column actually shows.
 */
export const ASSESSMENT_STATUS_FILTERS = ['PUBLISHED', 'UNPUBLISHED', 'ARCHIVED'] as const;

/** `UNASSIGNED` is the third real state and is not in the prompt's two — a filter that cannot express it would hide it. */
export const ASSESSMENT_ASSIGNMENT_FILTERS = ['GLOBAL', 'CLASS', 'UNASSIGNED'] as const;

export const listAssessmentsQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  assessment_type_id: z.string().uuid().optional(),
  status: z.enum(ASSESSMENT_STATUS_FILTERS).optional(),
  assignment: z.enum(ASSESSMENT_ASSIGNMENT_FILTERS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  // Clamped at 100, as §20 clamps the catalog and the address hierarchy.
  per_page: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(ASSESSMENT_SORTS).default('title'),
  direction: z.enum(['asc', 'desc']).default('asc'),
});

export type ListAssessmentsQuery = z.infer<typeof listAssessmentsQuerySchema>;

/**
 * Assigning an assessment (prompt-driven, v1.5) — globally, or to particular classes.
 *
 * A **discriminated union**, not a scope plus an optional array: `{ scope: 'GLOBAL', class_ids: [...] }`
 * is an incoherent request, and the two shapes make it unrepresentable rather than merely ignored.
 * GLOBAL carries no class list at all — its target is "every active class", resolved server-side at
 * the moment of the act, because a client-supplied list of "all classes" is a snapshot that is wrong
 * the moment a class is created.
 *
 * `assessment_version_id` is optional and defaults to the newest published version: the admin list
 * offers one Assign button per assessment, and making them name a version there would be asking a
 * question whose only sensible answer the server already knows.
 */
export const assignAssessmentSchema = z
  .discriminatedUnion('scope', [
    z
      .object({
        scope: z.literal('GLOBAL'),
        assessment_version_id: z.string().uuid().optional(),
        deadline: z.string().datetime({ offset: true }).nullable().optional(),
      })
      .strict(),
    z
      .object({
        scope: z.literal('CLASS'),
        class_ids: z.array(z.string().uuid()).min(1, 'Choose at least one class.').max(200),
        assessment_version_id: z.string().uuid().optional(),
        deadline: z.string().datetime({ offset: true }).nullable().optional(),
      })
      .strict(),
  ]);

export type AssignAssessmentInput = z.infer<typeof assignAssessmentSchema>;

/** Dimension codes are short author-facing handles ("TM", "FOCUS") — the §31 Mode B vocabulary. */
export const addDimensionsSchema = z
  .object({
    dimensions: z
      .array(
        z
          .object({
            code: z.string().trim().min(1).max(20),
            name: z.string().trim().min(1).max(100),
            description: z.string().trim().max(1000).nullable().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

export type AddDimensionsInput = z.infer<typeof addDimensionsSchema>;

export const createVersionSchema = z
  .object({
    instructions: z.string().trim().max(4000).nullable().optional(),
    duration_minutes: z.number().int().min(1).max(600).nullable().optional(),
    /** §24's whole extension point. CUSTOM scored surveys default to the weighted composite. */
    scoring_algorithm: z.enum(SCORING_ALGORITHMS).default('WEIGHTED_COMPOSITE'),
  })
  .strict();

export type CreateVersionInput = z.infer<typeof createVersionSchema>;

/** The manual editor's write shape — mirrors the service's `CreateQuestionInput`, snake_case. */
export const addQuestionsSchema = z
  .object({
    questions: z
      .array(
        z
          .object({
            question_text: z.string().trim().min(1).max(1000),
            question_type: z.enum(QUESTION_TYPES),
            section_label: z.string().trim().max(100).nullable().optional(),
            required: z.boolean().optional(),
            options: z
              .array(
                z
                  .object({
                    label: z.string().trim().min(1).max(200),
                    value: z.string().trim().min(1).max(200),
                    score: z.number().finite(),
                  })
                  .strict(),
              )
              .min(2, 'Every question needs at least 2 options.'),
            /** Dimension **codes** — the author's vocabulary, resolved by the service. */
            dimension_codes: z.array(z.string().trim().min(1)).max(6).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(60),
  })
  .strict();

export type AddQuestionsInput = z.infer<typeof addQuestionsSchema>;

export const updateQuestionSchema = z
  .object({
    question_text: z.string().trim().min(1).max(1000).optional(),
    required: z.boolean().optional(),
  })
  .strict();

export type UpdateQuestionInput = z.infer<typeof updateQuestionSchema>;

/** §31 Mode A: the browser already extracted (the §33 utility, shared on purpose). */
export const generateFromDocumentSchema = z
  .object({
    extracted_text: z.string().trim().min(1),
  })
  .strict();

/** §31 Mode B: a typed description; the template's own dimensions are the target set. */
export const generateFromDescriptionSchema = z
  .object({
    description: z.string().trim().min(1).max(4000),
  })
  .strict();

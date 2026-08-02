import { z } from 'zod';

import { QUESTION_TYPES, SCORING_ALGORITHMS } from '@/db/enums';

/**
 * The assessment module's write contracts (FULLPLAN §37, `docs/api/phase-3-assessment-engine.md`).
 */

/**
 * Grades are bounded **60–100**, and this is real validation rather than decoration.
 *
 * §27 *scores* a subject average — `academic_fit = ((average - 75) / 20) × 100` — rather than
 * sanity-checking it. A typo'd `9.2` would sail through, clamp to 0, and quietly wreck every
 * program recommendation the student ever sees, with nothing anywhere reporting an error. **This
 * endpoint is the only place in the system that can catch it.**
 */
const grade = z
  .number()
  .min(60, 'A grade must be at least 60.')
  .max(100, 'A grade cannot exceed 100.');

/**
 * The student-editable half of the profile.
 *
 * ## Three fields are conspicuously absent
 *
 * `first_name` / `last_name` belong to the counselor's roster (§16) — a student renaming
 * themselves would break the roster the counselor confirmed and the username derived from it.
 *
 * `gwa` is gone entirely (prompt-driven, 2026-07-27). §27's academic components now read the mean
 * of the three subject grades below.
 *
 * `.strict()` is what turns "we do not read that field" into "that field is **rejected**", so an
 * attempt to send any of them is a 422 rather than a silent no-op. That matters most for the two
 * fields below.
 *
 * ## Grade level and strand are ids, and only when nothing else supplies them
 *
 * Both are now FKs into the §13.1 lookups (migration 0017), and both are **derived from the class
 * the counselor enrolled the student in**. A student whose class carries a value may not change it
 * — `StudentProfileService.update` refuses with a 422 rather than ignoring the field, because
 * silently discarding an edit a student watched themselves make is the data-loss bug the profile
 * screen's own comments warn about. Passing them here is only legal when no class supplies them.
 *
 * The raw `strand` **string** is not accepted at any privilege level: `student_profiles.strand` is
 * a derived mirror of `shs_strands.name` with exactly one writer (§13.1 note in `schema.ts`), and
 * a second way to set it is precisely how a mirror becomes a second opinion.
 */
export const updateStudentProfileSchema = z
  .object({
    birthdate: z.string().date().nullable(),
    gender: z.string().max(30).nullable(),
    grade_level_id: z.string().uuid().nullable(),
    shs_strand_id: z.string().uuid().nullable(),
    math_grade: grade.nullable(),
    science_grade: grade.nullable(),
    english_grade: grade.nullable(),
    guardian_name: z.string().max(150).nullable(),
    guardian_contact: z.string().max(30).nullable(),
  })
  .partial()
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
export const ASSESSMENT_SORTS = [
  'title',
  'type',
  'status',
  'created_at',
  'updated_at',
  /** v1.6 — derived from the versions' `published_at`, not a column. See `AssessmentAdminService`. */
  'published_at',
] as const;
export type AssessmentSort = (typeof ASSESSMENT_SORTS)[number];

/**
 * A date bound that accepts **either** a full ISO-8601 timestamp **or** a bare `YYYY-MM-DD`,
 * normalizing the latter to the requested edge of that UTC day.
 *
 * The same shape the audit viewer settled on (`modules/platform/routes.ts`, M7), and for the same
 * two reasons. A date picker emits `2026-03-01`, so requiring a timestamp would push the
 * `T00:00:00Z` suffix into the frontend — one transcription per screen, each free to get it wrong.
 * And a `to` bound naively read as midnight **excludes the whole day it names**, which is never what
 * someone typing "to 1 March" meant; snapping it to `23:59:59.999` is what makes the range inclusive
 * at both ends, as a UI labelled "from … to …" promises.
 */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function dateBound(edge: 'start' | 'end') {
  return z
    .string()
    .trim()
    .refine(
      (value) => DATE_ONLY_PATTERN.test(value) || z.iso.datetime().safeParse(value).success,
      { message: 'Use an ISO-8601 date (YYYY-MM-DD) or timestamp.' },
    )
    .transform((value) =>
      DATE_ONLY_PATTERN.test(value)
        ? `${value}${edge === 'start' ? 'T00:00:00.000Z' : 'T23:59:59.999Z'}`
        : value,
    )
    .optional();
}

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
  /**
   * The three date ranges (v1.6). Separate `_from`/`_to` pairs rather than one field plus a
   * "which date?" selector, because they compose: "created in January but published in March" is a
   * real question about an instrument that sat in review, and a single-axis filter cannot ask it.
   */
  created_from: dateBound('start'),
  created_to: dateBound('end'),
  updated_from: dateBound('start'),
  updated_to: dateBound('end'),
  published_from: dateBound('start'),
  published_to: dateBound('end'),
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

/**
 * The answer set — **one declaration, read by both write paths, because they had drifted.**
 *
 * The add path capped nothing while the update path capped the array at 20, so bulk-add accepted an
 * option list the editor could then never save (ASSESSMENT-FIX §8). Two copies of a rule are two
 * rules; this is one.
 *
 * `value` is the *stored answer key* and it is unique per question — migration 0021 makes
 * `question_options (question_id, value)` a unique index. Checking it here as well as in the
 * database is what turns the loser of that collision into a 422 the author can act on rather than
 * the raw constraint 500 an uncaught SQLite error becomes (§6, and H4's general rule).
 */
const questionOptionsSchema = z
  .array(
    z
      .object({
        label: z.string().trim().min(1).max(200),
        value: z.string().trim().min(1).max(200),
        score: z.number().finite(),
      })
      .strict(),
  )
  .min(2, 'Every question needs at least 2 options.')
  .max(20)
  .refine((options) => new Set(options.map((option) => option.value)).size === options.length, {
    message: 'Two options cannot share the same value — the value is the answer key.',
  });

/**
 * The manual editor's write shape — mirrors the service's `CreateQuestionInput`, snake_case.
 *
 * **`question_text` has no `.min(1)`, deliberately** (ASSESSMENT-FIX §1). The builder's UX is
 * insert-a-stub-then-autosave-into-it: clicking "Add question" writes a blank item and the author
 * types into it, which requires a blank draft question to be a legal server state. It was not, and
 * every "Add" click 422'd. A blank item is refused at **publish** instead, where the question being
 * asked is "is this instrument finished" rather than "may this draft exist" — see
 * `AssessmentBuilderService.publish`.
 */
export const addQuestionsSchema = z
  .object({
    questions: z
      .array(
        z
          .object({
            question_text: z.string().trim().max(1000),
            question_type: z.enum(QUESTION_TYPES),
            section_label: z.string().trim().max(100).nullable().optional(),
            required: z.boolean().optional(),
            options: questionOptionsSchema,
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

/**
 * Editing one question in place — the v1.6 builder's auto-save.
 *
 * **Every field is optional and `.strict()` still applies**, which is exactly what an auto-save
 * needs: the editor sends only what the author actually changed, so toggling Required is a
 * two-field request rather than a round trip carrying the whole item back. `options` and
 * `dimension_codes`, when present, are the *complete* new set — the service replaces rather than
 * merges (see `updateQuestion` on why a diff would be ambiguous).
 *
 * `section_label` is `.nullable()` on purpose: an author clearing a section heading has to be able
 * to say so, and under `.optional()` alone "absent" and "cleared" would be the same request.
 *
 * `question_text` accepts the empty string for the same reason `addQuestionsSchema` does, and the
 * consequence of it not doing so was worse here (ASSESSMENT-FIX §2): an author who selected the
 * question text and deleted it sent `question_text: ''`, got a 422, and the failed patch went back
 * into the auto-save queue — where it rode along with every subsequent save and re-failed, so every
 * edit to *any other field* on that question failed too until they happened to retype the text.
 */
export const updateQuestionSchema = z
  .object({
    question_text: z.string().trim().max(1000).optional(),
    question_type: z.enum(QUESTION_TYPES).optional(),
    section_label: z.string().trim().max(100).nullable().optional(),
    required: z.boolean().optional(),
    options: questionOptionsSchema.optional(),
    dimension_codes: z.array(z.string().trim().min(1)).max(6).optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, {
    message: 'Send at least one field to change.',
  });

export type UpdateQuestionInput = z.infer<typeof updateQuestionSchema>;

/**
 * The drag-and-drop save — **the whole order, never a delta**.
 *
 * A move-this-item-to-position-N request would need the server to reconcile it against an order the
 * client may already have drifted from; sending the resulting sequence makes the request idempotent
 * and its meaning independent of what the server currently holds. The service refuses a list that
 * does not name every question in the version exactly once, so a partial save cannot silently
 * reshuffle the items it forgot.
 */
export const reorderQuestionsSchema = z
  .object({
    question_ids: z.array(z.string().uuid()).min(1).max(200),
  })
  .strict();

export type ReorderQuestionsInput = z.infer<typeof reorderQuestionsSchema>;

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

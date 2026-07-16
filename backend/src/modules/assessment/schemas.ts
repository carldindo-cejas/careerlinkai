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
  })
  .strict();

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

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

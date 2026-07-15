import { z } from 'zod';

import { STRANDS } from '@/db/enums';

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

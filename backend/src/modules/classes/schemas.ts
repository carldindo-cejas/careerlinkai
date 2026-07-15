import { z } from 'zod';

import { CLASS_STATUSES } from '@/db/enums';

/**
 * Class & roster validation (FULLPLAN §17). Validation rules only — business rules
 * (collisions, ownership, join-code lifecycle) live in the Services.
 *
 * `join_code` is absent from every schema here, deliberately: it is generated server-side and
 * is not an input anywhere, so a payload carrying one is silently ignored rather than
 * honoured (§38).
 */

/** Roster batches cap at 200 names per request (ratified v1.2, §16). */
const ROSTER_BATCH_MAX = 200;

export const createClassSchema = z.object({
  name: z.string().trim().min(1, 'A class name is required.').max(150),
  academic_year: z.string().trim().min(1, 'An academic year is required.').max(20),
  grade_level: z.string().trim().max(20).nullish(),
});

export const updateClassSchema = z
  .object({
    name: z.string().trim().min(1).max(150),
    academic_year: z.string().trim().min(1).max(20),
    grade_level: z.string().trim().max(20).nullable(),
    status: z.enum(CLASS_STATUSES),
  })
  .partial();

export const previewRosterSchema = z.object({
  names: z
    .array(z.string().trim().min(1, 'A name cannot be blank.').max(150))
    .min(1, 'Paste at least one name.')
    .max(ROSTER_BATCH_MAX, `Paste at most ${ROSTER_BATCH_MAX} names at a time.`),
});

/**
 * The reviewed list coming back from the counselor.
 *
 * `last_name` is nullable because **a mononym is a name, not an error** (§13.1, v1.2): a
 * one-word line previews with `last_name: null` and must confirm exactly as previewed. The
 * counselor is never asked to invent a surname the student does not have.
 */
export const confirmRosterSchema = z.object({
  students: z
    .array(
      z.object({
        first_name: z.string().trim().min(1, 'A first name is required.').max(100),
        last_name: z.string().trim().max(100).nullish(),
        username: z
          .string()
          .trim()
          .min(1, 'A username is required.')
          .max(50)
          .regex(
            /^[a-z0-9][a-z0-9._-]*$/,
            'Use lowercase letters, numbers, dots, hyphens and underscores; start with a letter or number.',
          ),
      }),
    )
    .min(1, 'Confirm at least one student.')
    .max(ROSTER_BATCH_MAX, `Confirm at most ${ROSTER_BATCH_MAX} students at a time.`),
});

export const listClassesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateClassInput = z.infer<typeof createClassSchema>;
export type UpdateClassInput = z.infer<typeof updateClassSchema>;
export type PreviewRosterInput = z.infer<typeof previewRosterSchema>;
export type ConfirmRosterInput = z.infer<typeof confirmRosterSchema>;

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

/**
 * `grade_level_id` and `shs_strand_id` replaced the free-text `grade_level` (migration 0017).
 *
 * They are not merely a tidier input: a class's two values are **the source** of every enrolled
 * student's grade level and strand, so a counselor typing "Gr 11" here used to produce a profile
 * field that §27 could not read and a student could not correct. Ids from the §13.1 lookups make
 * the derivation a join.
 *
 * Both are nullish at creation. A counselor who has not decided yet gets a class whose students
 * keep their own editable values, which is the honest intermediate state — the alternative is
 * refusing to create a class until a strand is chosen, and the strand is not what a class is for.
 */
export const createClassSchema = z.object({
  name: z.string().trim().min(1, 'A class name is required.').max(150),
  academic_year: z.string().trim().min(1, 'An academic year is required.').max(20),
  grade_level_id: z.string().uuid().nullish(),
  shs_strand_id: z.string().uuid().nullish(),
});

export const updateClassSchema = z
  .object({
    name: z.string().trim().min(1).max(150),
    academic_year: z.string().trim().min(1).max(20),
    grade_level_id: z.string().uuid().nullable(),
    shs_strand_id: z.string().uuid().nullable(),
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
  /**
   * Admin-only narrowing, added by P3-6 (audit F5): the classes belonging to one counselor.
   *
   * A counselor's own list is already scoped to them by `ClassService.list`, so this changes
   * nothing for that caller — it exists because an administrator handing a departing counselor's
   * classes to a replacement needs to see *that counselor's* classes, and "every class in the
   * school, find the nine that are theirs" is not a workflow.
   */
  counselor_id: z.string().uuid().optional(),
});

/**
 * `PATCH /admin/classes/:id` — reassignment, and **only** reassignment (audit F5, plan P3-6).
 *
 * A separate schema from `updateClassSchema` rather than a field added to it, because these are
 * two different acts with two different authorities. Renaming a class or archiving it is something
 * its own counselor does; handing it to somebody else is an administrative transfer of ownership,
 * and `counselor_id` must not become writable on the route a counselor can reach — a counselor who
 * could set it could quietly give away (or take) a class and its students' results.
 *
 * That is why `counselor_id` is absent from `createClassSchema` too: a class's owner is the
 * counselor who created it (§13.2), and this endpoint is the only thing in the system that moves it.
 */
export const reassignClassSchema = z.object({
  counselor_id: z.string().uuid('Choose a counselor to hand this class to.'),
});

export type CreateClassInput = z.infer<typeof createClassSchema>;
export type UpdateClassInput = z.infer<typeof updateClassSchema>;
export type ReassignClassInput = z.infer<typeof reassignClassSchema>;
export type PreviewRosterInput = z.infer<typeof previewRosterSchema>;
export type ConfirmRosterInput = z.infer<typeof confirmRosterSchema>;

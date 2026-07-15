import { z } from 'zod';

import { CATALOG_STATUSES, PROGRAM_STATUSES, STRANDS } from '@/db/enums';
import { parseHollandCode } from '@/lib/holland';

/**
 * Academic catalog validation (FULLPLAN §17, §13.3).
 *
 * Validation rules only. The uniqueness rules — a college name, a program code within its
 * college, a career title — are **not** here: they are live-row lookups against the database
 * (a soft-deleted row keeps its name forever, so they cannot be DB constraints either), and
 * they live in the Service with the rest of the business rules.
 */

/**
 * `status` is deliberately **absent** from the college and career create schemas. A new
 * college or career is always `active`; archiving one is an explicit PATCH, not something a
 * create call can do in passing. Programs are the exception — see `createProgramSchema`.
 */
export const createCollegeSchema = z.object({
  name: z.string().trim().min(1, 'A college name is required.').max(200),
  description: z.string().trim().nullish(),
});

export const updateCollegeSchema = z
  .object({
    name: z.string().trim().min(1, 'A college name is required.').max(200),
    description: z.string().trim().nullable(),
    status: z.enum(CATALOG_STATUSES),
  })
  .partial();

/**
 * The program code is **uppercased here, in the schema** — before the Service's uniqueness
 * check runs, not after. It has to be: that check is a string comparison, so `"bscs"` checked
 * against a stored `"BSCS"` would find nothing, pass, and land a second BSCS in the same
 * college. Normalising downstream of the check would be too late.
 */
const programCode = z
  .string()
  .trim()
  .min(1, 'A program code is required.')
  .max(30)
  .transform((code) => code.toUpperCase());

/**
 * `college_id` is accepted **nowhere** — not here and not in the update schema. The parent
 * comes from the route. A body naming a different college is ignored rather than honoured,
 * precisely so that neither a create nor an edit can move a program to another institution:
 * doing so would silently rewrite the college §27 derives for every recommendation already
 * pointing at that program.
 *
 * `status` *is* settable here, unlike on colleges and careers, because a program has a real
 * third state: `draft` is one the admin has entered but is not offering (§27 ranks only
 * `active`), so choosing it at creation is a meaningful act.
 *
 * `recommended_strand: null` is a **claim**, not a blank — §27 reads it as "no strand
 * requirement" and scores a full 100 for every student. It is not "unknown".
 */
export const createProgramSchema = z.object({
  code: programCode,
  name: z.string().trim().min(1, 'A program name is required.').max(200),
  department_name: z.string().trim().max(200).nullish(),
  description: z.string().trim().nullish(),
  recommended_strand: z.enum(STRANDS).nullish(),
  status: z.enum(PROGRAM_STATUSES).optional(),
});

export const updateProgramSchema = z
  .object({
    code: programCode,
    name: z.string().trim().min(1, 'A program name is required.').max(200),
    department_name: z.string().trim().max(200).nullable(),
    description: z.string().trim().nullable(),
    recommended_strand: z.enum(STRANDS).nullable(),
    status: z.enum(PROGRAM_STATUSES),
  })
  .partial();

/**
 * The Holland code is validated *and normalized* by the schema, so the Service and the
 * database only ever see a canonical `"IEC"` — or `null`. `""` normalises to `null` rather
 * than passing through, because §27 would otherwise iterate a zero-letter code.
 */
const hollandCode = z
  .string()
  .nullish()
  .transform((value, ctx) => {
    const result = parseHollandCode(value);

    if (!result.ok) {
      ctx.addIssue({ code: 'custom', message: result.message ?? 'Invalid Holland code.' });

      return z.NEVER;
    }

    return result.value;
  });

export const createCareerSchema = z.object({
  title: z.string().trim().min(1, 'A career title is required.').max(150),
  description: z.string().trim().nullish(),
  salary_range: z.string().trim().max(100).nullish(),
  employment_outlook: z.string().trim().max(100).nullish(),
  typical_riasec_code: hollandCode,
});

export const updateCareerSchema = z
  .object({
    title: z.string().trim().min(1, 'A career title is required.').max(150),
    description: z.string().trim().nullable(),
    salary_range: z.string().trim().max(100).nullable(),
    employment_outlook: z.string().trim().max(100).nullable(),
    typical_riasec_code: hollandCode,
    status: z.enum(CATALOG_STATUSES),
  })
  .partial();

export const attachCareerSchema = z.object({
  career_id: z.string().trim().min(1, 'A career is required.'),
});

/**
 * `per_page` is clamped to 100 (§20). The careers picker legitimately wants the whole catalog
 * in one request; nothing wants fifty thousand rows.
 */
export const listCatalogQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateCollegeInput = z.infer<typeof createCollegeSchema>;
export type UpdateCollegeInput = z.infer<typeof updateCollegeSchema>;
export type CreateProgramInput = z.infer<typeof createProgramSchema>;
export type UpdateProgramInput = z.infer<typeof updateProgramSchema>;
export type CreateCareerInput = z.infer<typeof createCareerSchema>;
export type UpdateCareerInput = z.infer<typeof updateCareerSchema>;
export type AttachCareerInput = z.infer<typeof attachCareerSchema>;

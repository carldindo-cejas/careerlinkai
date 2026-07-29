import { z } from 'zod';

import { CATALOG_STATUSES, PROGRAM_STATUSES, STRANDS } from '@/db/enums';
import { isGoogleMapsUrl } from '@/lib/google-maps';
import { parseHollandCode } from '@/lib/holland';

/**
 * An optional foreign-key field: a non-empty id, `null` to clear it, or absent to leave it. The
 * *existence and parentage* of the id is checked in the Service against live rows (a schema cannot
 * know whether a barangay belongs to the chosen town) — this only guarantees the shape.
 */
const optionalId = z.string().trim().min(1).nullable();

/**
 * A Google Maps URL, or nothing. `''` normalises to `null` (a valid "no map"), a non-maps link is a
 * 422 with a message, and — crucially — an **absent** field stays `undefined` rather than becoming
 * `null`. That distinction is load-bearing on PATCH: a status-only update must not silently wipe the
 * map link, so the Service only writes `map_link` when the key was actually present. The `.optional()`
 * *outside* the transform is what preserves `undefined`; a `.nullish()` *inside* it would run the
 * transform on the absent value and coerce it to `null`. The authority is `lib/google-maps.ts`.
 */
const googleMapsLink = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => value.length === 0 || isGoogleMapsUrl(value), {
    message: 'Enter a valid Google Maps link (e.g. https://maps.app.goo.gl/…).',
  })
  .transform((value) => (value.length === 0 ? null : value))
  .nullable()
  .optional();

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
/**
 * The school-address fields (migration 0012). All four are optional — a college can be entered
 * before its location is — and each is an id into the §0011 hierarchy. The Service validates that
 * the chain is contiguous (no province without its region) and correctly parented (the province
 * actually belongs to the region), because only a live-row lookup can know that.
 */
const collegeAddress = {
  region_id: optionalId.optional(),
  province_id: optionalId.optional(),
  town_id: optionalId.optional(),
  barangay_id: optionalId.optional(),
};

export const createCollegeSchema = z.object({
  name: z.string().trim().min(1, 'A college name is required.').max(200),
  description: z.string().trim().nullish(),
  ...collegeAddress,
  map_link: googleMapsLink,
});

export const updateCollegeSchema = z
  .object({
    name: z.string().trim().min(1, 'A college name is required.').max(200),
    description: z.string().trim().nullable(),
    status: z.enum(CATALOG_STATUSES),
    ...collegeAddress,
    map_link: googleMapsLink,
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
  /**
   * Which canonical program this offering *is* (migration 0018). **Omitted** means "work it out
   * from the code" — the normal path, and why an admin adding a program never has to visit the
   * canonical page first. An explicit `null` means "we have not decided", which is a different and
   * legitimate state; an id pins it.
   */
  program_catalog_id: z.string().uuid().nullish(),
});

export const updateProgramSchema = z
  .object({
    code: programCode,
    name: z.string().trim().min(1, 'A program name is required.').max(200),
    department_name: z.string().trim().max(200).nullable(),
    description: z.string().trim().nullable(),
    recommended_strand: z.enum(STRANDS).nullable(),
    status: z.enum(PROGRAM_STATUSES),
    program_catalog_id: z.string().uuid().nullable(),
  })
  .partial();

/** The canonical-program admin surface (migration 0018, `/admin/canonical-programs`). */
export const createCanonicalProgramSchema = z.object({
  // Not `programCode`: a canonical code is normalized by the Service (upper-cased, punctuation
  // stripped) rather than validated into a shape, so that 'bs-cs' typed here and 'BSCS' typed on a
  // program form reach the same row.
  code: z.string().trim().min(1, 'A code is required.').max(30),
  name: z.string().trim().min(1, 'A name is required.').max(200),
  description: z.string().trim().nullish(),
});

export const updateCanonicalProgramSchema = z
  .object({
    code: z.string().trim().min(1).max(30),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().nullable(),
    status: z.enum(CATALOG_STATUSES),
  })
  .partial();

export const mergeCanonicalProgramSchema = z.object({
  /** The entry that survives. The one named in the URL is the one absorbed and retired. */
  target_id: z.string().uuid(),
});

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

/**
 * A single salary bound: a positive whole number of pesos, or nothing. The `min < max` and
 * both-or-neither rules are cross-field, so they live in the object-level refinement below rather
 * than here. A hard ceiling keeps a fat-fingered `4000000000` out of an INTEGER column.
 */
const salaryAmount = z
  .number({ message: 'Enter a whole peso amount.' })
  .int('Enter a whole peso amount.')
  .positive('Salary must be a positive amount.')
  .max(100_000_000, 'That salary looks too large.')
  .nullable();

/**
 * The two cross-field salary rules (§17), applied to whichever create/update shape carries them:
 * a career declares both bounds or neither, and the maximum must exceed the minimum. A lone bound
 * is a half-finished range, so it is refused with the message pointing at the missing field.
 */
function refineSalary(
  value: { salary_min?: number | null; salary_max?: number | null },
  ctx: z.RefinementCtx,
): void {
  const hasMin = value.salary_min !== undefined && value.salary_min !== null;
  const hasMax = value.salary_max !== undefined && value.salary_max !== null;

  if (hasMin !== hasMax) {
    ctx.addIssue({
      code: 'custom',
      path: [hasMin ? 'salary_max' : 'salary_min'],
      message: 'Enter both a minimum and a maximum salary, or leave both blank.',
    });

    return;
  }

  if (hasMin && hasMax && value.salary_min! >= value.salary_max!) {
    ctx.addIssue({
      code: 'custom',
      path: ['salary_max'],
      message: 'Maximum salary must be greater than the minimum.',
    });
  }
}

export const createCareerSchema = z
  .object({
    title: z.string().trim().min(1, 'A career title is required.').max(150),
    description: z.string().trim().nullish(),
    salary_min: salaryAmount.optional(),
    salary_max: salaryAmount.optional(),
    employment_outlook_id: optionalId.optional(),
    typical_riasec_code: hollandCode,
  })
  .superRefine(refineSalary);

export const updateCareerSchema = z
  .object({
    title: z.string().trim().min(1, 'A career title is required.').max(150),
    description: z.string().trim().nullable(),
    salary_min: salaryAmount,
    salary_max: salaryAmount,
    employment_outlook_id: optionalId,
    typical_riasec_code: hollandCode,
    status: z.enum(CATALOG_STATUSES),
  })
  .partial()
  .superRefine(refineSalary);

export const attachCareerSchema = z.object({
  career_id: z.string().trim().min(1, 'A career is required.'),
});

/**
 * A free-text list filter. `''` normalises to `undefined` rather than passing through as an empty
 * string, because `?search=` is what a cleared search box sends and "match everything" is the
 * intent — a Service asked to filter on `''` would `LIKE '%%'`, which happens to be the same
 * answer for the wrong reason and stops being so the moment a column is nullable.
 */
const searchTerm = z
  .string()
  .trim()
  .max(200)
  .optional()
  .transform((value) => (value === undefined || value === '' ? undefined : value));

/**
 * Sortable columns — an allow-list, so `?sort=` can never name an arbitrary column (the same rule
 * `ADDRESS_SORTS` follows).
 *
 * `name` is the *display* name of whatever is being listed: `colleges.name`, `careers.title`,
 * `program_catalog.name`. One vocabulary across the three lists, resolved to a column by each
 * Service method, so the frontend's toolbar does not need a per-resource dialect.
 */
export const CATALOG_SORTS = ['name', 'created_at'] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];

/** Canonical programs add `code`, which is a first-class identifier there rather than a detail. */
export const CANONICAL_PROGRAM_SORTS = ['name', 'code', 'created_at'] as const;
export type CanonicalProgramSort = (typeof CANONICAL_PROGRAM_SORTS)[number];

/**
 * The list query shared by colleges, careers and canonical programs (§20, audit F3/F4).
 *
 * `per_page` is clamped to 100 (§20). **Nothing is expected to ask for the whole catalog any
 * more:** the careers picker used to request `per_page: 100` and call that "all of them", which
 * was true at 16 careers, false at 101, and silently so — it is a server-backed typeahead now,
 * and this cap is a cap rather than a de-facto contract.
 */
export const listCatalogQuerySchema = z.object({
  search: searchTerm,
  status: z.enum(CATALOG_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(CATALOG_SORTS).default('name'),
  direction: z.enum(['asc', 'desc']).default('asc'),
});

export const listCanonicalProgramQuerySchema = listCatalogQuerySchema.extend({
  sort: z.enum(CANONICAL_PROGRAM_SORTS).default('name'),
});

/** The query-string keys `parseQuery` must lift for the list endpoints above. */
export const LIST_CATALOG_QUERY_KEYS = [
  'search',
  'status',
  'page',
  'per_page',
  'sort',
  'direction',
] as const;

export type ListCatalogQuery = z.infer<typeof listCatalogQuerySchema>;
export type ListCanonicalProgramQuery = z.infer<typeof listCanonicalProgramQuerySchema>;

export type CreateCollegeInput = z.infer<typeof createCollegeSchema>;
export type UpdateCollegeInput = z.infer<typeof updateCollegeSchema>;
export type CreateProgramInput = z.infer<typeof createProgramSchema>;
export type UpdateProgramInput = z.infer<typeof updateProgramSchema>;
export type CreateCareerInput = z.infer<typeof createCareerSchema>;
export type UpdateCareerInput = z.infer<typeof updateCareerSchema>;
export type AttachCareerInput = z.infer<typeof attachCareerSchema>;

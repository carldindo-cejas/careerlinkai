import { z } from 'zod';

/**
 * Philippine Address validation (migration 0011).
 *
 * As in the catalog module, uniqueness is *not* expressed here — it is a live-row lookup in the
 * Service (a soft-deleted row keeps its name, so it cannot be a plain Zod rule), backed by the
 * partial unique index in the migration. What lives here is shape: a name is required and bounded,
 * a code is optional.
 */

/**
 * One row of a bulk import. `name` is the only required field — the paste workflow is "one place
 * per line" — while `code` is the optional PSGC, accepted for programmatic seeding but normally
 * absent from a hand-pasted list. Empty strings normalize to `undefined` rather than passing
 * through, so a blank code never lands as `""`.
 */
const bulkItemSchema = z.object({
  name: z.string().trim().min(1, 'A name is required.').max(200),
  code: z
    .string()
    .trim()
    .max(50)
    .optional()
    .transform((value) => (value === undefined || value === '' ? undefined : value)),
});

/**
 * The bulk-import body: a non-empty list of items. Capped at 1000 per request — a single D1
 * multi-row insert stays well inside the Worker's subrequest budget, and a paste larger than a
 * province's worth of towns should be chunked by the caller rather than risking one oversized
 * statement. The parent (region/province/town) comes from the route, never the body.
 */
export const bulkImportSchema = z.object({
  items: z
    .array(bulkItemSchema)
    .min(1, 'Add at least one item.')
    .max(1000, 'Import at most 1000 items at a time.'),
});

/** Sortable columns — an allow-list, so `?sort=` can never inject an arbitrary column. */
export const ADDRESS_SORTS = ['name', 'code', 'created_at'] as const;
export type AddressSort = (typeof ADDRESS_SORTS)[number];

/**
 * The list query for every level: free-text `search` (matched against name and code),
 * `page`/`per_page` (clamped to 100, as §20 clamps the catalog), and `sort`/`direction`.
 */
export const listAddressQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(ADDRESS_SORTS).default('name'),
  direction: z.enum(['asc', 'desc']).default('asc'),
});

export type BulkImportInput = z.infer<typeof bulkImportSchema>;
export type ListAddressQuery = z.infer<typeof listAddressQuerySchema>;

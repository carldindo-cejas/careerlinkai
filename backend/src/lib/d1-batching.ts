import { getTableColumns } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';

/**
 * Multi-row INSERTs against D1's parameter ceiling (FULLPLAN §42).
 *
 * **D1 binds at most 100 parameters per statement**, and a multi-row INSERT binds one parameter per
 * column *per row*. So the limit is never a row count — it is a row count divided by the width of
 * the table, and RIASEC's 300 option rows in one INSERT is ~1,800 parameters and fails with
 * `too many SQL variables`. That is a fact about the statement's shape and says nothing about the
 * data, which is why the fix is chunking rather than a smaller feature.
 *
 * This module exists because the arithmetic was previously done three times with hand-counted
 * widths, and one of them rotted exactly the way a hand-counted constant does: migration 0014 added
 * `scope` to `assessment_assignments`, both copies of its width stayed at `7`, and a global
 * assignment quietly began binding 14 × 8 = 112 parameters per statement. It failed only once a
 * single act targeted **thirteen or more classes** — so it passed every test and every small
 * deployment while being broken at exactly the scale the feature was added for.
 *
 * `chunkForInsert` takes the **table** rather than a number. Add a column and the arithmetic
 * follows; there is nothing left to forget to update.
 */

export const D1_MAX_BOUND_PARAMS = 100;

/** How many parameters one row of this table binds. Read off the schema, never counted by hand. */
export function columnCount(table: SQLiteTable): number {
  return Object.keys(getTableColumns(table)).length;
}

/** Split rows into statement-sized batches for `table`. */
export function chunkForInsert<T>(rows: T[], table: SQLiteTable): T[][] {
  return chunkByWidth(rows, columnCount(table));
}

/**
 * The same, for a width the caller already knows.
 *
 * Prefer `chunkForInsert`. This exists for the one case it cannot serve: rows whose width is not a
 * whole table (a partial insert), where the caller genuinely does know better.
 */
export function chunkByWidth<T>(rows: T[], columnsPerRow: number): T[][] {
  const size = Math.max(1, Math.floor(D1_MAX_BOUND_PARAMS / columnsPerRow));
  const chunks: T[][] = [];

  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }

  return chunks;
}

/**
 * The **read** side of the same ceiling: `WHERE id IN (…)` binds one parameter per id.
 *
 * Everything above this line is about INSERT width, and that framing is exactly how the read path
 * was missed. `inArray(column, ids)` is not a wide statement — it is a *long* one — but it draws on
 * the identical 100-parameter budget, and an `inArray` over a list that grows with the catalog
 * crosses it silently the day the catalog does.
 *
 * That is not hypothetical. Audit item P0-1 grew the catalog from 16 programs to 309 to make the
 * ranking discriminate between students; `scorableCareersForMany` then bound 309 parameters in one
 * `IN`, threw `too many SQL variables`, and the `AssessmentCompleted` listener swallowed it exactly
 * as designed. Every student who completed both instruments on the deployed Worker received **zero
 * recommendations** — the product's central feature, disabled by its own catalog, with no error
 * anywhere a human would look. Miniflare enforces no parameter limit, so all 807 tests passed.
 *
 * Use this for any `inArray` whose list is not bounded by a small constant, then merge the results.
 * A list bounded by construction (the 60 questions of one attempt, one class's roster, a status
 * enum) does not need it.
 *
 * **`reserved` is not padding.** An `IN` clause is never the only thing its statement binds — the
 * two call sites that prompted this also bind `status = 'active'`, and a chunk sized to exactly the
 * ceiling would put them at 101 parameters and fail for the sake of one predicate. The default
 * leaves room for a handful of them, matching the headroom `ROWS_PER_INSERT` already keeps, so that
 * adding a filter to one of these queries does not silently reintroduce the bug.
 */
export function chunkIds<T>(ids: T[], reserved = 10): T[][] {
  const size = Math.max(1, D1_MAX_BOUND_PARAMS - reserved);
  const chunks: T[][] = [];

  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }

  return chunks;
}

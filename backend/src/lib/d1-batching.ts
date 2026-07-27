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

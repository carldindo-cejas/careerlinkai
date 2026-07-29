import { sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

/**
 * Free-text list filtering (§20's list surfaces: catalog, knowledge, address).
 *
 * One helper, because every list that grows past a screen needs the same two things and gets
 * them subtly wrong in different ways otherwise.
 */

/**
 * Escape the caller's own `%`, `_` and `\` so a search **term** is matched literally.
 *
 * Without this, a search is a pattern language the user did not know they were writing:
 * `100%` matches every title starting "100", and a lone `_` matches everything. Neither is a
 * security hole — the term is still a bound parameter, so this is not injection — but both are
 * wrong answers, and the `_` case is the one a user hits by accident while typing a code.
 *
 * The escape character is declared explicitly by `contains()` below; SQLite has no default one,
 * so escaping without `ESCAPE` would leave the backslashes in the pattern as literals to match.
 */
export function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * A case-insensitive "contains" predicate for one column.
 *
 * `LIKE` is used rather than `LOWER(col) LIKE LOWER(?)` because SQLite's `LIKE` is **already**
 * case-insensitive for ASCII, which is the whole of this catalog (college names, career titles,
 * programme codes). It is *not* case-insensitive above ASCII — `Ñ` will not match `ñ` — and that
 * is a real limit worth naming rather than papering over: the fix is `PRAGMA case_sensitive_like`
 * plus ICU, neither of which D1 exposes. Wrapping both sides in `LOWER()` would fix the `ñ` and
 * lose the index on every column it touched, for a catalog that today contains no such title.
 */
export function contains(column: SQLiteColumn, term: string): SQL {
  return sql`${column} LIKE ${`%${escapeLikeTerm(term)}%`} ESCAPE '\\'`;
}

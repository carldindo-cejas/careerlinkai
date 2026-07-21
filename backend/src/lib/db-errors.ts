import { ApiError } from '@/lib/envelope';

/**
 * Turning D1 constraint violations into the §19 errors they should have been (audit H4).
 *
 * Every check-then-insert in the codebase (`assert…Free`, `liveAttempt`, the roster confirm, …)
 * is a *pre-check*: it wins the common case and returns a friendly field-level 422, but two
 * genuinely concurrent writers both pass the pre-check and exactly one loses at the unique index.
 * The index is what actually holds the invariant; the loser just needs the same 422 the pre-check
 * would have given, not the raw 500 an uncaught SQLite error becomes. Two tabs, a double-click, or
 * forty students in a lab are normal, expected concurrency — not a server fault.
 */

/**
 * D1 surfaces a constraint violation as an `Error` carrying SQLite's `UNIQUE constraint failed`
 * text — but **not always on the top-level `.message`.** Drizzle (0.45) wraps a failed statement
 * in a `DrizzleQueryError` whose own message is `Failed query: insert into …`; the SQLite text
 * lives on `.cause`. So this walks the `cause` chain rather than reading `error.message` alone.
 * (The original one-line version only inspected `.message`, which is why every catch-based race
 * translation silently fell back to a raw 500 whenever the pre-check did not get there first —
 * caught by the dimension-code race test in the Phase G hardening.)
 *
 * Matched narrowly on the specific SQLite phrase: a broader check would swallow unrelated failures
 * as a 422.
 */
export function isUniqueViolation(error: unknown): boolean {
  for (
    let current: unknown = error, depth = 0;
    current instanceof Error && depth < 5;
    depth += 1
  ) {
    if (/UNIQUE constraint failed/i.test(current.message)) {
      return true;
    }

    current = (current as { cause?: unknown }).cause;
  }

  return false;
}

/**
 * Re-throw a lost check-then-insert race as a 422 keyed on `field`; re-throw anything else
 * untouched, so a real fault is never masked as a validation error.
 */
export function translateUniqueViolation(
  error: unknown,
  field: string,
  message: string,
): never {
  if (isUniqueViolation(error)) {
    throw ApiError.validation({ [field]: [message] });
  }

  throw error;
}

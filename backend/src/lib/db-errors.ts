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
 * D1 surfaces a constraint violation as a plain `Error` whose message carries SQLite's text —
 * there is no typed error class to `instanceof` against, so the string is the only signal
 * available. Matched narrowly: a broader check would swallow unrelated failures as a 422.
 */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
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

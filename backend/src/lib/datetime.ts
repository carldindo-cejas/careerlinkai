/**
 * All timestamps are ISO-8601 UTC strings (see the note in src/db/schema.ts) — SQLite
 * stores them as TEXT, and lexical comparison on that format is chronological, which is
 * what lets expiry checks be plain SQL `<` comparisons.
 */

export function now(): string {
  return new Date().toISOString();
}

export function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

export function daysFromNow(days: number): string {
  return hoursFromNow(days * 24);
}

/** True when `timestamp` is in the past. A NULL expiry means "never expires". */
export function isExpired(timestamp: string | null): boolean {
  return timestamp !== null && new Date(timestamp).getTime() <= Date.now();
}

import type { Env } from '@/env';

/**
 * Typed accessors for the numeric `[vars]` (FULLPLAN §48).
 *
 * Wrangler's TOML `[vars]` are strings, and a var that is missing or unparseable is a
 * deployment error, not something to paper over with a silent default — a student token
 * that never expires because `STUDENT_TOKEN_TTL_HOURS` was typo'd would be a security bug
 * that no test would catch.
 */
/**
 * The vars that carry a number. Narrower than `keyof Env` on purpose: that would also admit
 * the bindings, and `requireNumber(env, 'DB')` is not a thing anyone should be able to write.
 */
type NumericVar =
  | 'STUDENT_JOIN_CODE_TTL_DAYS'
  | 'STUDENT_TOKEN_TTL_HOURS'
  | 'ASSESSMENT_GENERATION_MAX_QUESTIONS';

function requireNumber(env: Env, key: NumericVar): number {
  const raw = env[key];
  const value = Number(raw);

  if (typeof raw !== 'string' || raw.trim() === '' || !Number.isFinite(value)) {
    throw new Error(`Environment var ${key} must be a number, got: ${raw}`);
  }

  return value;
}

/** Default lifetime of a class join code, in days (§13.2). */
export function studentJoinCodeTtlDays(env: Env): number {
  return requireNumber(env, 'STUDENT_JOIN_CODE_TTL_DAYS');
}

/** Lifetime of a student's bearer token, in hours — hours, not days (§38). */
export function studentTokenTtlHours(env: Env): number {
  return requireNumber(env, 'STUDENT_TOKEN_TTL_HOURS');
}

/** Hard cap on questions in one AI-generated batch (§34). */
export function assessmentGenerationMaxQuestions(env: Env): number {
  return requireNumber(env, 'ASSESSMENT_GENERATION_MAX_QUESTIONS');
}

/**
 * Staff tokens are long-lived relative to student tokens: a counselor works a full day in
 * the app, and §38 pins expiry only for students. Kept here so both flows read their TTL
 * from one place.
 */
export const STAFF_TOKEN_TTL_HOURS = 24 * 7;

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
  | 'STAFF_TOKEN_TTL_HOURS'
  | 'ASSESSMENT_GENERATION_MAX_QUESTIONS'
  | 'API_RATE_LIMIT_PER_MINUTE';

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
 * Lifetime of a staff bearer token, in hours (L4).
 *
 * Staff tokens are long-lived relative to student tokens: a counselor works a full day in the app,
 * and §38 pins expiry only for students. This used to be a hardcoded `24 * 7` constant while the
 * student TTL was a var — an inconsistency that meant changing it needed a code deploy, not a var
 * edit. Now both flows read their TTL from a `[vars]` entry (default 168 = 7 days).
 */
export function staffTokenTtlHours(env: Env): number {
  return requireNumber(env, 'STAFF_TOKEN_TTL_HOURS');
}

/**
 * The S2 general API budget: requests per minute per authenticated user (plan P3-4).
 *
 * **This one throws on every authenticated request if the var is missing**, which is a far wider
 * blast radius than the four above — so `scripts/platform-gates.mjs` asserts it is declared in all
 * three wrangler scopes, statically, on every push. That is the deal this module's header describes
 * (a missing var is a deployment error, not a silent default) with the check moved early enough to
 * be worth having: an environment that forgot it fails the gate rather than the deploy, and fails
 * the deploy rather than the school day.
 *
 * A silent fallback was considered and rejected for the usual reason — the fallback that gets
 * chosen is either so high it is not a limit or so low it breaks a lab of forty, and either way
 * nobody finds out which until it matters.
 */
export function apiRateLimitPerMinute(env: Env): number {
  return requireNumber(env, 'API_RATE_LIMIT_PER_MINUTE');
}

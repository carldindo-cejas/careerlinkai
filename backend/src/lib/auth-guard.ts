import type { AuthGuardDO } from '@/do/auth-guard';
import type { Env } from '@/env';

/**
 * Client-side helpers for `AuthGuardDO` (FULLPLAN §38 v1.5, Phase 4.5) — the instance
 * naming, the §38 limits, and the shared counter-state shape live here, in one place, so a
 * typo cannot silently address a second, empty guard.
 *
 * This module deliberately contains **no crypto**: the derivation lives behind the DO
 * boundary (`src/do/auth-guard.ts`), and services only ever hold a stub. KV is no longer
 * on any auth path (deviation D19, closed here) — it remains bound for future caching
 * only.
 */

export interface RateLimitState {
  /** How many failures are currently recorded against the instance. */
  attempts: number;
  /** True once `attempts` has reached the limit and the window is still open. */
  locked: boolean;
  /** Seconds until the window expires. 0 when not locked. */
  retryAfterSeconds: number;
}

/** §38: 5 failures per email → 15 minutes. */
export const LOGIN_LOCKOUT_LIMIT = 5;
export const LOGIN_LOCKOUT_WINDOW_SECONDS = 15 * 60;

/** §38: 10 **failed** attempts per (class code, IP) → 15 minutes. Successes are never charged. */
export const JOIN_THROTTLE_LIMIT = 10;
export const JOIN_THROTTLE_WINDOW_SECONDS = 15 * 60;

/**
 * §34/§41: 10 AI requests per minute per user, enforced at the API layer before anything is
 * generated or queued. Unlike the two above, every attempt is charged — this is a usage
 * limiter guarding a hard daily neuron quota (§45), not a failure counter.
 */
export const AI_REQUEST_LIMIT = 10;
export const AI_REQUEST_WINDOW_SECONDS = 60;

/**
 * M2: 3 forgot-password requests per email per hour. A usage limiter (every request is charged),
 * because an *unauthenticated* caller drives it — each request otherwise overwrote the pending
 * reset token (denying a legitimate reset) and wrote an audit row + a token row. It was the only
 * credential endpoint with no counter.
 */
export const FORGOT_PASSWORD_LIMIT = 3;
export const FORGOT_PASSWORD_WINDOW_SECONDS = 60 * 60;

/**
 * Audit C4: 5 recommendation regenerations per student per 10 minutes. A usage limiter — every
 * attempt is charged, allowed or not.
 *
 * Regeneration calls no model and costs no neurons, so this is not an AI budget: it guards **D1**.
 * One run scans the rankable catalog and then replaces the student's whole set in a batched
 * delete-plus-insert, which on the Free plan's daily row limits is the most expensive thing a
 * student can trigger at will. Five in ten minutes is far above any legitimate use (the button
 * exists for the rare case where generation failed) and far below what would matter.
 *
 * Deliberately **not** the AI limiter's counter, for the reason the forgot-password throttle is not
 * the login lockout's: sharing an instance would let one feature's usage lock a user out of an
 * unrelated one.
 */
export const RECOMMENDATION_REGENERATE_LIMIT = 5;
export const RECOMMENDATION_REGENERATE_WINDOW_SECONDS = 10 * 60;

/**
 * One instance per staff account (§38 v1.5): the object that derives the account's hash is
 * the object that counts its failures, so the count is exact and brute force against one
 * account is serialized by construction.
 */
export function staffAuthGuard(env: Env, email: string): DurableObjectStub<AuthGuardDO> {
  return env.AUTH_DO.get(env.AUTH_DO.idFromName(email.trim().toLowerCase()));
}

/**
 * One instance per `(class_code, IP)` pair (§38): the IP in the name is what stops an
 * outside attacker from freezing a class out of its own code, and a whole class joining
 * from one lab IP is safe because only failures are ever charged.
 */
export function joinThrottleGuard(
  env: Env,
  classCode: string,
  ip: string | null,
): DurableObjectStub<AuthGuardDO> {
  const name = `join:${classCode.trim().toUpperCase()}:${ip ?? 'unknown'}`;

  return env.AUTH_DO.get(env.AUTH_DO.idFromName(name));
}

/** One instance per user for the §41 AI request limit — same counter, different charging rule. */
export function aiRateLimitGuard(env: Env, userId: string): DurableObjectStub<AuthGuardDO> {
  return env.AUTH_DO.get(env.AUTH_DO.idFromName(`ai:${userId}`));
}

/**
 * One instance per email for the forgot-password throttle (M2). **A different instance from the
 * login lockout on the same email** (`forgot:` prefix), so a reset request never charges the login
 * counter and a login failure never charges this one — the two limits are independent by
 * construction, exactly as the join throttle is kept apart from the lockout.
 */
export function forgotPasswordGuard(env: Env, email: string): DurableObjectStub<AuthGuardDO> {
  return env.AUTH_DO.get(env.AUTH_DO.idFromName(`forgot:${email.trim().toLowerCase()}`));
}

/**
 * One instance per **student** for the regeneration throttle (audit C4), keyed on whose
 * recommendations are being rebuilt rather than on who asked.
 *
 * That distinction is the point. A counselor regenerating for a student charges the *student's*
 * counter, so a counselor with sixty students is not throttled after five of them — while a student
 * cannot escape their own limit by getting a counselor to press the button for them either. The
 * resource being protected is the work done per student, so the student is the correct key.
 */
export function recommendationRegenerateGuard(
  env: Env,
  studentId: string,
): DurableObjectStub<AuthGuardDO> {
  return env.AUTH_DO.get(env.AUTH_DO.idFromName(`regen:${studentId}`));
}

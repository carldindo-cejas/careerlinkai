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

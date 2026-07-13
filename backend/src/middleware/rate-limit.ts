/**
 * KV-backed rate limiting (FULLPLAN §38, §41).
 *
 * Two distinct uses, deliberately kept as one primitive:
 *
 *   * **Staff login lockout** — 5 failed attempts on an email → 15-minute lock. Counted on
 *     failure only, so a user who mistypes twice and then succeeds is not penalised.
 *   * **Student join throttle** (Step 2) — 10 *failed* attempts per `(class_code, IP)` in
 *     15 minutes. Successes are never charged: an entire class joining from one school lab
 *     shares a public IP, and charging successes would lock the 11th student out of their
 *     own class (ratified v1.2).
 *
 * Both therefore need "count a failure" and "read the count" as separate operations,
 * rather than a single middleware that charges every request — which is why this exposes
 * functions a Service calls, not a `use()` middleware.
 *
 * KV is eventually consistent. For a lockout counter that is acceptable and stated: the
 * worst case is an attacker distributed across colos getting a few extra attempts inside
 * the propagation window, against a control whose purpose is slowing bulk guessing, not
 * being a transactional counter. The audit log — not this counter — is the evidence trail.
 */

export interface RateLimitState {
  /** How many failures are currently recorded against the key. */
  attempts: number;
  /** True once `attempts` has reached the limit and the window is still open. */
  locked: boolean;
  /** Seconds until the window expires. 0 when not locked. */
  retryAfterSeconds: number;
}

interface Counter {
  attempts: number;
  /** Epoch ms at which the window expires. */
  expiresAt: number;
}

async function readCounter(kv: KVNamespace, key: string): Promise<Counter | null> {
  const raw = await kv.get<Counter>(key, 'json');

  if (!raw || raw.expiresAt <= Date.now()) {
    return null;
  }

  return raw;
}

function state(counter: Counter | null, limit: number): RateLimitState {
  if (!counter) {
    return { attempts: 0, locked: false, retryAfterSeconds: 0 };
  }

  const locked = counter.attempts >= limit;

  return {
    attempts: counter.attempts,
    locked,
    retryAfterSeconds: locked ? Math.max(1, Math.ceil((counter.expiresAt - Date.now()) / 1000)) : 0,
  };
}

/** Read the current state of a key without charging it. */
export async function checkRateLimit(
  kv: KVNamespace,
  key: string,
  limit: number,
): Promise<RateLimitState> {
  return state(await readCounter(kv, key), limit);
}

/**
 * Charge one failure against a key and return the resulting state.
 *
 * The window is fixed, not sliding: it starts at the first failure and is not extended by
 * later ones, so a locked-out user is always released after at most `windowSeconds`.
 */
export async function recordFailure(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitState> {
  const existing = await readCounter(kv, key);

  const counter: Counter = existing
    ? { attempts: existing.attempts + 1, expiresAt: existing.expiresAt }
    : { attempts: 1, expiresAt: Date.now() + windowSeconds * 1000 };

  await kv.put(key, JSON.stringify(counter), {
    // KV's own TTL floor is 60s; the window is the authority, this is just cleanup.
    expirationTtl: Math.max(60, Math.ceil((counter.expiresAt - Date.now()) / 1000)),
  });

  return state(counter, limit);
}

/** Clear a key — used after a successful login, so a lock never outlives the credential. */
export async function clearRateLimit(kv: KVNamespace, key: string): Promise<void> {
  await kv.delete(key);
}

// --- Key builders — one place, so a typo cannot silently create a second counter. -----

/** §38: 5 failures per email → 15 minutes. */
export const LOGIN_LOCKOUT_LIMIT = 5;
export const LOGIN_LOCKOUT_WINDOW_SECONDS = 15 * 60;

export function loginLockoutKey(email: string): string {
  return `lockout:login:${email.trim().toLowerCase()}`;
}

/** §38: 10 failures per (class code, IP) → 15 minutes. Wired up in Phase 3.5 Step 2. */
export const JOIN_THROTTLE_LIMIT = 10;
export const JOIN_THROTTLE_WINDOW_SECONDS = 15 * 60;

export function joinThrottleKey(classCode: string, ip: string): string {
  return `throttle:join:${classCode.trim().toUpperCase()}:${ip}`;
}

import { DurableObject } from 'cloudflare:workers';

import type { RateLimitState } from '@/lib/auth-guard';

/**
 * `AuthGuardDO` — password derivation and security counters (FULLPLAN §38, v1.5; Phase 4.5).
 *
 * ## Why a Durable Object
 *
 * A **free** Worker gets 10 ms of CPU per invocation and that limit cannot be raised
 * (`CPU limits are not supported for the Free plan`, code 100328). §38's 600,000-iteration
 * PBKDF2 does not fit: on the Step 5 staging deploy, `/auth/login` derived once and
 * *intermittently* survived; `/auth/change-password` derives twice and reliably died with
 * error 1102 — which the browser reported as a CORS failure, because a Worker killed
 * mid-request emits no headers at all. The deployed system then ran at 100,000 iterations
 * (deviation D14), six times cheaper to attack than the plan requires.
 *
 * A **Durable Object gets the standard 30-second CPU budget per invocation on every plan,
 * including Free** (verified against Cloudflare's docs 2026-07-14). Moving the derivation
 * here closes D14 at zero cost and zero security compromise: OWASP's PBKDF2-SHA256
 * recommendation is met again, and no plan upgrade is involved. SQLite-backed, because that
 * is the only kind the Free plan allows — and the recommended kind anyway.
 *
 * ## Why the counters live in the same object
 *
 * The §38 staff lockout and the §38 join throttle were KV-backed (deviation D19), and KV is
 * the wrong consistency model for a security counter three times over: it is eventually
 * consistent (~60 s to propagate between edge locations, so five rapid failures spread
 * across two colos may never sum to five), it allows only 1 write/second per key, and the
 * Free plan caps it at **1,000 writes/day account-wide** — a quota an attacker can exhaust
 * to blind the counter entirely. A DO instance is strongly consistent and has none of those
 * failure modes.
 *
 * One instance exists per staff email (`idFromName(email.toLowerCase())`) and per
 * `(class_code, IP)` pair (`idFromName('join:' + code + ':' + ip)`) — see
 * `src/lib/auth-guard.ts` for the naming helpers, which are the only place those strings
 * are built. Because the instance that performs a staff account's derivation is the
 * instance that counts its failures, the count is exact *and* brute-force attempts against
 * one account are serialized by construction (`blockConcurrencyWhile` below).
 *
 * ## The boundary rule
 *
 * **No code outside this module ever calls `crypto.subtle.deriveBits`.** The platform gate
 * (`scripts/platform-gates.mjs`, Phase 4.5 Step 2) enforces that by scanning `src/`.
 * Services reach derivation only through the DO stub, so the CPU cost lands on the DO's
 * 30-second budget, never on the Worker's 10 ms.
 */

/**
 * The §38 work factor, **restored to 600,000** (Phase 4.5 closes D14).
 *
 * The iteration count is stored inside every hash (`pbkdf2$iterations$salt$hash`), so
 * raising it invalidated nothing: hashes written at 100,000 during the D14 window keep
 * verifying at their own recorded cost, while every new hash is written at 600,000. That
 * property was designed in from Step 1 and this is the moment it was designed for.
 */
const PBKDF2_ITERATIONS = 600_000;

/**
 * The Workers **production** runtime refuses PBKDF2 above 100,000 iterations per
 * `deriveBits()` call, on every plan (deviation D15, ratified):
 *
 *   NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported
 *
 * workerd under Miniflare does not enforce this cap — a single 600,000-iteration call
 * passed 371 tests and 500'd on the edge (Phase 3.5 Step 5). The chain below reaches the
 * full work factor through calls that each stay at or under the cap, and
 * `test/unit/auth-guard.test.ts` spies on `deriveBits` to assert on **what is asked of the
 * platform**, which is the only shape of test that can catch this class of bug offline.
 */
const PBKDF2_MAX_ITERATIONS_PER_CALL = 100_000;

const PBKDF2_KEY_BITS = 256;
const SALT_BYTES = 16;

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

/**
 * Derive `iterations` worth of PBKDF2-SHA256 work, in rounds that each stay under the
 * platform's per-call ceiling (see PBKDF2_MAX_ITERATIONS_PER_CALL).
 *
 * Round *n* is keyed on round *n-1*'s output, so the rounds cannot be computed in parallel
 * or skipped: testing one password candidate costs the full `iterations` regardless of how
 * the work was split across calls. The salt is the same in every round — it is what makes
 * the chain specific to this one hash, and re-salting per round would buy nothing. A count
 * at or below the cap collapses to a single call, so such a hash is an ordinary PBKDF2
 * hash and stays verifiable as one.
 */
async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  let input: BufferSource = encoder.encode(password);
  let derived = new Uint8Array();
  let remaining = iterations;

  while (remaining > 0) {
    const rounds = Math.min(remaining, PBKDF2_MAX_ITERATIONS_PER_CALL);

    const keyMaterial = await crypto.subtle.importKey('raw', input, 'PBKDF2', false, [
      'deriveBits',
    ]);

    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: rounds },
      keyMaterial,
      PBKDF2_KEY_BITS,
    );

    derived = new Uint8Array(bits);
    input = derived;
    remaining -= rounds;
  }

  return derived;
}

/**
 * Hash a password into `pbkdf2$iterations$salt$hash`.
 *
 * Exported for the test suite and for fixtures; production code reaches it only through
 * `AuthGuardDO.hash()`. The `iterations` parameter exists so a test can write a
 * legacy-cost hash (the D14-era 100,000) and prove it still verifies — production callers
 * never pass it.
 */
export async function hashPassword(
  password: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await deriveKey(password, salt, iterations);

  return `pbkdf2$${iterations}$${toBase64(salt)}$${toBase64(derived)}`;
}

/** Constant-time comparison — a length-or-content early return would leak the hash byte by byte. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let difference = 0;

  for (let i = 0; i < a.length; i += 1) {
    difference |= a[i]! ^ b[i]!;
  }

  return difference === 0;
}

/**
 * Verify a password against a stored `pbkdf2$iterations$salt$hash` string — at the hash's
 * **own recorded cost**, which is what lets 100,000-iteration hashes from the D14 window
 * keep working while new ones are written at 600,000.
 *
 * A malformed or absent hash returns false rather than throwing: students have
 * `password IS NULL` permanently (§38), so "no password to verify" is an expected state
 * on this path, not an exceptional one.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) {
    return false;
  }

  const [scheme, iterationsRaw, saltRaw, hashRaw] = stored.split('$');

  if (scheme !== 'pbkdf2' || !iterationsRaw || !saltRaw || !hashRaw) {
    return false;
  }

  const iterations = Number(iterationsRaw);

  if (!Number.isInteger(iterations) || iterations <= 0) {
    return false;
  }

  const derived = await deriveKey(password, fromBase64(saltRaw), iterations);

  return timingSafeEqual(derived, fromBase64(hashRaw));
}

/** The failure counter, as stored. `expiresAt` is epoch ms — the window is fixed, not sliding. */
interface Counter {
  attempts: number;
  expiresAt: number;
}

const COUNTER_KEY = 'failures';

function toState(counter: Counter | null, limit: number): RateLimitState {
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

export class AuthGuardDO extends DurableObject {
  /**
   * Hash a password at the full §38 work factor.
   *
   * `blockConcurrencyWhile` is what makes the §38 claim "brute force is serialized per
   * account" literally true rather than aspirational: a DO delivers events concurrently at
   * await points, and a derivation is nothing but await points — without the block, ten
   * concurrent guesses against one account would interleave their rounds and pay the wall
   * clock only once. With it, the instance does one derivation at a time, so an attacker's
   * guesses against a single account queue up behind each other.
   */
  async hash(password: string): Promise<string> {
    return this.ctx.blockConcurrencyWhile(() => hashPassword(password));
  }

  /** Verify a password at the hash's own recorded cost. Serialized like `hash()`. */
  async verify(password: string, stored: string | null): Promise<boolean> {
    return this.ctx.blockConcurrencyWhile(() => verifyPassword(password, stored));
  }

  /** Read the counter without charging it. */
  async check(limit: number): Promise<RateLimitState> {
    return toState(await this.readCounter(), limit);
  }

  /**
   * Charge one failure and return the resulting state.
   *
   * The window is fixed, not sliding: it starts at the first failure and is not extended
   * by later ones, so a locked-out user is always released after at most `windowSeconds`.
   * Charging is **failures only** by construction — success paths call `clear()`, never
   * this (§38, ratified v1.2).
   */
  async recordFailure(limit: number, windowSeconds: number): Promise<RateLimitState> {
    const existing = await this.readCounter();

    const counter: Counter = existing
      ? { attempts: existing.attempts + 1, expiresAt: existing.expiresAt }
      : { attempts: 1, expiresAt: Date.now() + windowSeconds * 1000 };

    await this.ctx.storage.put(COUNTER_KEY, counter);

    return toState(counter, limit);
  }

  /** Clear the counter — after a success or a reset, so a lock never outlives the credential. */
  async clear(): Promise<void> {
    await this.ctx.storage.delete(COUNTER_KEY);
  }

  private async readCounter(): Promise<Counter | null> {
    const counter = await this.ctx.storage.get<Counter>(COUNTER_KEY);

    if (!counter || counter.expiresAt <= Date.now()) {
      // An expired window is over; deleting it here keeps the instance's storage at zero
      // in the steady state rather than accreting one dead counter per bad afternoon.
      if (counter) {
        await this.ctx.storage.delete(COUNTER_KEY);
      }

      return null;
    }

    return counter;
  }
}

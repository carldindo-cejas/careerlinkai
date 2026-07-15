import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from '@/do/auth-guard';

/**
 * The §38 derivation, at the **restored 600,000-iteration work factor** (Phase 4.5 closes
 * D14). These are the one place in the codebase where "it works" and "it is correct"
 * genuinely differ — a password check that returns true is not evidence the hash is strong —
 * so the parameters themselves are asserted, not just the round trip.
 */

describe('hashPassword / verifyPassword', () => {
  it('produces the pbkdf2$iterations$salt$hash format at the §38 600,000 iterations', async () => {
    // 600,000 again, for free: the derivation runs inside AuthGuardDO, whose 30-second CPU
    // budget holds on every plan including Workers Free. The 100,000 this asserted during
    // the D14 window was a concession, and the concession is over.
    const hash = await hashPassword('CorrectHorse1');
    const [scheme, iterations, salt, digest] = hash.split('$');

    expect(scheme).toBe('pbkdf2');
    expect(Number(iterations)).toBe(600_000);
    expect(salt).toBeTruthy();
    expect(digest).toBeTruthy();
  });

  it('salts every hash, so the same password never hashes twice the same way', async () => {
    const first = await hashPassword('CorrectHorse1');
    const second = await hashPassword('CorrectHorse1');

    expect(first).not.toBe(second);
    await expect(verifyPassword('CorrectHorse1', first)).resolves.toBe(true);
    await expect(verifyPassword('CorrectHorse1', second)).resolves.toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('CorrectHorse1');

    await expect(verifyPassword('correcthorse1', hash)).resolves.toBe(false);
    await expect(verifyPassword('', hash)).resolves.toBe(false);
  });

  it('returns false rather than throwing for a NULL hash — the permanent state of a student', async () => {
    await expect(verifyPassword('anything', null)).resolves.toBe(false);
  });

  it('returns false for a malformed stored hash instead of crashing the request', async () => {
    await expect(verifyPassword('anything', 'bcrypt$12$whatever')).resolves.toBe(false);
    await expect(verifyPassword('anything', 'garbage')).resolves.toBe(false);
    await expect(verifyPassword('anything', 'pbkdf2$0$c2FsdA==$aGFzaA==')).resolves.toBe(false);
  });

  it('keeps verifying a hash written during the D14 window, at its own stored cost', async () => {
    // Every deployed staff account's hash was written at 100,000 iterations while D14 was
    // open. Restoring the constant to 600,000 must break none of them: the cost lives in
    // the string, not in the verifier, which is the property the whole migration rests on.
    const legacy = await hashPassword('CorrectHorse1', 100_000);

    expect(legacy.split('$')[1]).toBe('100000');
    await expect(verifyPassword('CorrectHorse1', legacy)).resolves.toBe(true);
  });

  it('verifies a hash at its own stored iteration count, so the cost can be raised later', async () => {
    // The verifier honours the number in the string — proven by the fact that changing that
    // number breaks the check, because it then performs a different derivation.
    const stored = await hashPassword('CorrectHorse1');
    const claimed = Number(stored.split('$')[1]);
    const rewritten = stored.replace(/^pbkdf2\$\d+\$/, `pbkdf2$${claimed + 100_000}$`);

    await expect(verifyPassword('CorrectHorse1', stored)).resolves.toBe(true);
    await expect(verifyPassword('CorrectHorse1', rewritten)).resolves.toBe(false);
  });
});

/**
 * The regression guard for the one bug in this project that **no test could catch by asserting
 * on a result**, because locally there is no wrong result to assert on.
 *
 * Cloudflare's production runtime refuses PBKDF2 above 100,000 iterations per `deriveBits()`
 * call, on every plan. workerd under Miniflare — which is what this suite runs in — does not
 * enforce that cap. So a single 600,000-iteration call passed here, 371 times, and 500'd on
 * the deployed Worker: staff login was completely broken on Cloudflare while the suite was
 * green (Phase 3.5 Step 5).
 *
 * The only thing a local test can check is therefore **what was asked of the platform**, not
 * what came back. These tests spy on `deriveBits` and assert on the request.
 */
describe('the Workers PBKDF2 iteration cap (§38 — found on the Step 5 staging deploy)', () => {
  /** Record the `iterations` of every PBKDF2 derivation performed inside `run`. */
  async function recordIterations(run: () => Promise<unknown>): Promise<number[]> {
    const requested: number[] = [];
    const original = crypto.subtle.deriveBits.bind(crypto.subtle) as (
      ...args: unknown[]
    ) => Promise<ArrayBuffer>;

    // Structurally typed rather than via lib.dom's `Pbkdf2Params` — @cloudflare/workers-types
    // does not ship those DOM names, and the only fields this spy reads are these two.
    crypto.subtle.deriveBits = (
      algorithm: { name: string; iterations?: number },
      ...rest: unknown[]
    ) => {
      if (algorithm.name === 'PBKDF2' && typeof algorithm.iterations === 'number') {
        requested.push(algorithm.iterations);
      }

      return original(algorithm, ...rest);
    };

    try {
      await run();
    } finally {
      crypto.subtle.deriveBits = original;
    }

    return requested;
  }

  it('never asks the platform for more than 100,000 iterations in one call, and the rounds sum to 600,000', async () => {
    const hashing = await recordIterations(() => hashPassword('CorrectHorse1'));

    expect(hashing.length).toBeGreaterThan(0);
    for (const iterations of hashing) {
      expect(iterations).toBeLessThanOrEqual(100_000);
    }

    // The §38 work factor is real work, not a number written into the string: the chained
    // rounds must add up to exactly what the hash claims.
    expect(hashing.reduce((sum, iterations) => sum + iterations, 0)).toBe(600_000);
  });

  it('never asks for more than the cap when VERIFYING either — the path that actually 500d', async () => {
    // Login derives on the *verify* side. That is the call the deployed Worker made and the
    // edge rejected, so it gets its own assertion rather than riding on the hash side's.
    const stored = await hashPassword('CorrectHorse1');
    const verifying = await recordIterations(() => verifyPassword('CorrectHorse1', stored));

    expect(verifying.length).toBeGreaterThan(0);
    for (const iterations of verifying) {
      expect(iterations).toBeLessThanOrEqual(100_000);
    }
  });

  it('does the work it says it did — the stored count is not a decoration', async () => {
    const stored = await hashPassword('CorrectHorse1');
    const claimed = Number(stored.split('$')[1]);

    const requested = await recordIterations(() => verifyPassword('CorrectHorse1', stored));
    const performed = requested.reduce((sum, iterations) => sum + iterations, 0);

    // The chain must actually cost what the hash claims. A hash that says 600000 while
    // having done 100000 would be a lie told to the next reader.
    expect(performed).toBe(claimed);
  });

  it('chains, rather than truncating, when the count exceeds the cap', async () => {
    const stored = await hashPassword('CorrectHorse1');
    const [, , salt] = stored.split('$');

    const requested = await recordIterations(async () => {
      // Verify against a stored count above the cap. It will not match the password — that
      // is fine and beside the point; we are asserting on what was *asked of the platform*.
      await verifyPassword('CorrectHorse1', `pbkdf2$600000$${salt}$${'A'.repeat(44)}`);
    });

    expect(requested).toEqual([100_000, 100_000, 100_000, 100_000, 100_000, 100_000]);
  });
});

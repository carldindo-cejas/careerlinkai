import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { hashPassword } from '@/do/auth-guard';
import {
  AI_REQUEST_LIMIT,
  AI_REQUEST_WINDOW_SECONDS,
  aiRateLimitGuard,
  joinThrottleGuard,
  LOGIN_LOCKOUT_LIMIT,
  LOGIN_LOCKOUT_WINDOW_SECONDS,
  staffAuthGuard,
} from '@/lib/auth-guard';
import { uuid } from '@/lib/crypto';

/**
 * `AuthGuardDO` behaviour, exercised through the real binding (FULLPLAN §38 v1.5, Phase 4.5).
 *
 * Miniflare hosts SQLite-backed Durable Objects in-process, so these tests cross the same
 * stub boundary production does — the derivation and the counters both live on the other
 * side of an RPC call, exactly as they do on the edge. What Miniflare does NOT enforce is
 * the Worker-side 10 ms CPU budget the DO exists to escape; that claim is only provable on
 * a deploy, which is why the Phase 4.5 exit demo drives `/auth/change-password` — the
 * double-derivation canary — on staging.
 */

/** A fresh instance per test: DO storage, like D1 storage, is not rolled back between tests. */
function freshStaffGuard() {
  return staffAuthGuard(env, `guard.${uuid().slice(0, 8)}@school.test`);
}

describe('AuthGuardDO derivation', () => {
  it('hashes at the §38 600,000 iterations and verifies its own output', async () => {
    const guard = freshStaffGuard();

    const hash = await guard.hash('CorrectHorse1');

    expect(hash.split('$')[1]).toBe('600000');
    await expect(guard.verify('CorrectHorse1', hash)).resolves.toBe(true);
    await expect(guard.verify('WrongHorse1', hash)).resolves.toBe(false);
  });

  it('verifies a 100,000-iteration hash from the D14 window — no deployed password breaks', async () => {
    const guard = freshStaffGuard();
    const legacy = await hashPassword('CorrectHorse1', 100_000);

    await expect(guard.verify('CorrectHorse1', legacy)).resolves.toBe(true);
  });

  it('returns false for NULL — a student, whose password never exists (§38)', async () => {
    await expect(freshStaffGuard().verify('anything', null)).resolves.toBe(false);
  });
});

describe('AuthGuardDO failure counter', () => {
  it('starts clean, charges failures only, and locks on the limit', async () => {
    const guard = freshStaffGuard();

    const initial = await guard.check(LOGIN_LOCKOUT_LIMIT);
    expect(initial).toEqual({ attempts: 0, locked: false, retryAfterSeconds: 0 });

    for (let i = 1; i < LOGIN_LOCKOUT_LIMIT; i += 1) {
      const state = await guard.recordFailure(
        LOGIN_LOCKOUT_LIMIT,
        LOGIN_LOCKOUT_WINDOW_SECONDS,
      );

      expect(state.attempts).toBe(i);
      expect(state.locked).toBe(false);
    }

    const locked = await guard.recordFailure(LOGIN_LOCKOUT_LIMIT, LOGIN_LOCKOUT_WINDOW_SECONDS);

    expect(locked.locked).toBe(true);
    expect(locked.retryAfterSeconds).toBeGreaterThan(0);
    expect(locked.retryAfterSeconds).toBeLessThanOrEqual(LOGIN_LOCKOUT_WINDOW_SECONDS);
  });

  it('clears completely — a lock never outlives the credential', async () => {
    const guard = freshStaffGuard();

    await guard.recordFailure(LOGIN_LOCKOUT_LIMIT, LOGIN_LOCKOUT_WINDOW_SECONDS);
    await guard.clear();

    const state = await guard.check(LOGIN_LOCKOUT_LIMIT);

    expect(state).toEqual({ attempts: 0, locked: false, retryAfterSeconds: 0 });
  });

  it('releases on its own once the window has passed — the window is fixed, not sliding', async () => {
    const guard = freshStaffGuard();

    // A window that is already over by the time it is read back.
    await guard.recordFailure(LOGIN_LOCKOUT_LIMIT, 0);

    const state = await guard.check(LOGIN_LOCKOUT_LIMIT);

    expect(state.attempts).toBe(0);
    expect(state.locked).toBe(false);
  });

  it('counts different instances independently — one per email, one per (code, IP) pair', async () => {
    const alpha = staffAuthGuard(env, `alpha.${uuid().slice(0, 8)}@school.test`);
    const beta = staffAuthGuard(env, `beta.${uuid().slice(0, 8)}@school.test`);

    await alpha.recordFailure(LOGIN_LOCKOUT_LIMIT, LOGIN_LOCKOUT_WINDOW_SECONDS);

    expect((await alpha.check(LOGIN_LOCKOUT_LIMIT)).attempts).toBe(1);
    expect((await beta.check(LOGIN_LOCKOUT_LIMIT)).attempts).toBe(0);
  });

  it('separates join-throttle instances by IP, so an attacker cannot freeze a class out of its own code', async () => {
    const code = `ABCD-${Math.floor(1000 + Math.random() * 9000)}`;
    const attacker = joinThrottleGuard(env, code, '198.51.100.7');
    const lab = joinThrottleGuard(env, code, '203.0.113.10');

    await attacker.recordFailure(10, 900);

    expect((await attacker.check(10)).attempts).toBe(1);
    expect((await lab.check(10)).attempts).toBe(0);
  });
});

describe('AuthGuardDO usage limiter — charge() (M1)', () => {
  /** A fresh AI-limiter instance per test — one per user in production (`ai:${userId}`). */
  function freshAiGuard() {
    return aiRateLimitGuard(env, uuid());
  }

  it('admits exactly `limit` requests, then locks — the Nth request is still allowed', async () => {
    const guard = freshAiGuard();

    // Every attempt is charged (a usage limiter, not a failure counter), and the request that
    // brings the count *to* the limit is admitted; only the one after it is rejected.
    for (let i = 1; i <= AI_REQUEST_LIMIT; i += 1) {
      const state = await guard.charge(AI_REQUEST_LIMIT, AI_REQUEST_WINDOW_SECONDS);

      expect(state.locked).toBe(false);
      expect(state.attempts).toBe(i);
    }

    const overflow = await guard.charge(AI_REQUEST_LIMIT, AI_REQUEST_WINDOW_SECONDS);

    expect(overflow.locked).toBe(true);
    expect(overflow.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('does not charge past the ceiling — a rejected request neither counts nor extends the window', async () => {
    const guard = freshAiGuard();

    for (let i = 0; i < AI_REQUEST_LIMIT; i += 1) {
      await guard.charge(AI_REQUEST_LIMIT, AI_REQUEST_WINDOW_SECONDS);
    }

    // Two rejected attempts must leave the stored count pinned at the limit, not climbing.
    await guard.charge(AI_REQUEST_LIMIT, AI_REQUEST_WINDOW_SECONDS);
    await guard.charge(AI_REQUEST_LIMIT, AI_REQUEST_WINDOW_SECONDS);

    expect((await guard.check(AI_REQUEST_LIMIT)).attempts).toBe(AI_REQUEST_LIMIT);
  });

  it('folds check-and-charge into one round trip, so concurrent requests cannot both slip under the cap (M1 TOCTOU)', async () => {
    const guard = freshAiGuard();

    // Fire the whole window's worth of charges concurrently. The old check()-then-recordFailure()
    // pair let two requests both read `attempts < limit` between the calls and overshoot; a single
    // blockConcurrencyWhile charge serializes them, so exactly `limit` are admitted.
    const results = await Promise.all(
      Array.from({ length: AI_REQUEST_LIMIT + 5 }, () =>
        guard.charge(AI_REQUEST_LIMIT, AI_REQUEST_WINDOW_SECONDS),
      ),
    );

    const admitted = results.filter((state) => !state.locked).length;

    expect(admitted).toBe(AI_REQUEST_LIMIT);
    expect((await guard.check(AI_REQUEST_LIMIT)).attempts).toBe(AI_REQUEST_LIMIT);
  });
});

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { hashPassword } from '@/do/auth-guard';
import {
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
      const state = await guard.recordFailure(LOGIN_LOCKOUT_LIMIT, LOGIN_LOCKOUT_WINDOW_SECONDS);

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

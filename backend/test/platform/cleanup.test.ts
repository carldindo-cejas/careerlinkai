import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { passwordResetTokens } from '@/db/schema';
import { runNightlyCleanup } from '@/jobs/cleanup';
import {
  api,
  backdateResetToken,
  backdateSignupRequest,
  countTokensFor,
  createStaffUser,
  db,
  expireTokensFor,
  findSignupRequest,
  login,
  setCounselorSignupEnabled,
} from '../helpers';

/**
 * The nightly Cron housekeeping (FULLPLAN §45 enhancement, audit M11).
 *
 * `runNightlyCleanup` is what the `scheduled` handler in `index.ts` calls. It sweeps the three
 * tables that otherwise accrete rows nothing removes — expired `api_tokens`, stale
 * `password_reset_tokens`, and abandoned `counselor_signup_requests` — and must leave everything
 * still within its lifetime untouched.
 */

function signupBody(email: string) {
  return {
    email,
    password: 'SweptAway1x',
    password_confirmation: 'SweptAway1x',
    first_name: 'Abandoned',
    last_name: 'Signup',
  };
}

async function resetTokenCount(email: string): Promise<number> {
  const rows = await db()
    .select()
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.email, email.toLowerCase()));

  return rows.length;
}

describe('runNightlyCleanup', () => {
  it('sweeps expired tokens and stale reset tokens, keeping the live ones', async () => {
    // One staff account whose only token is expired, one whose token is live.
    const expiredUser = await createStaffUser({ role: 'counselor' });
    await login(expiredUser);
    await expireTokensFor(expiredUser.id);

    const liveUser = await createStaffUser({ role: 'counselor' });
    await login(liveUser);

    // One reset request past its 60-minute TTL, one fresh.
    const staleReset = await createStaffUser({ role: 'counselor' });
    await api('POST', '/auth/forgot-password', { body: { email: staleReset.email } });
    await backdateResetToken(staleReset.email, 61);

    const freshReset = await createStaffUser({ role: 'counselor' });
    await api('POST', '/auth/forgot-password', { body: { email: freshReset.email } });

    const result = await runNightlyCleanup(env);

    // Swept: the expired token and the stale reset.
    expect(await countTokensFor(expiredUser.id)).toBe(0);
    expect(await resetTokenCount(staleReset.email)).toBe(0);

    // Kept: the live token and the fresh reset.
    expect(await countTokensFor(liveUser.id)).toBe(1);
    expect(await resetTokenCount(freshReset.email)).toBe(1);

    // And it counted what it removed (≥ our own rows — storage is shared across the file).
    expect(result.expiredTokens).toBeGreaterThanOrEqual(1);
    expect(result.staleResetTokens).toBeGreaterThanOrEqual(1);
  });

  /**
   * Abandoned counselor signups (migration 0034) — the third table, and the first one a public form
   * writes to.
   *
   * Note what this test does **not** claim: that the sweep is what expires a code. It is not —
   * `verify` refuses an expired code on its own, and has to, or the cron's schedule would silently
   * become the real TTL. This is garbage collection, so the fresh row surviving matters as much as
   * the old one going.
   */
  it('sweeps abandoned signups past the sweep window, keeping recent ones', async () => {
    await setCounselorSignupEnabled(true);

    const abandoned = 'abandoned.signup@school.test';
    const recent = 'recent.signup@school.test';

    await api('POST', '/auth/counselor-signup', {
      body: signupBody(abandoned),
      ip: '10.20.30.40',
    });
    await api('POST', '/auth/counselor-signup', {
      body: signupBody(recent),
      ip: '10.20.30.41',
    });

    // Past the hour-long sweep window, which is deliberately four times the 15-minute code TTL —
    // so a row is never deleted out from under a request still in flight.
    await backdateSignupRequest(abandoned, 61);

    const result = await runNightlyCleanup(env);

    expect(await findSignupRequest(abandoned)).toBeUndefined();
    expect(await findSignupRequest(recent)).toBeDefined();
    expect(result.staleSignupRequests).toBeGreaterThanOrEqual(1);
  });
});

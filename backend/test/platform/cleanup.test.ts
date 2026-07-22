import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { passwordResetTokens } from '@/db/schema';
import { runNightlyCleanup } from '@/jobs/cleanup';
import {
  api,
  backdateResetToken,
  countTokensFor,
  createStaffUser,
  db,
  expireTokensFor,
  login,
} from '../helpers';

/**
 * The nightly Cron housekeeping (FULLPLAN §45 enhancement, audit M11).
 *
 * `runNightlyCleanup` is what the `scheduled` handler in `index.ts` calls. It sweeps the two tables
 * that otherwise accrete rows nothing removes — expired `api_tokens` and stale
 * `password_reset_tokens` — and must leave everything still within its lifetime untouched.
 */

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
});

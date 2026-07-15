import { describe, expect, it } from 'vitest';

import { generateToken, hashToken, uuid } from '@/lib/crypto';

/**
 * The token and id primitives (§38, §12). Password hashing moved behind the `AuthGuardDO`
 * boundary in Phase 4.5 — its tests live in test/unit/auth-guard.test.ts (the derivation
 * parameters) and test/do/auth-guard.test.ts (the DO's behaviour).
 */

describe('bearer tokens', () => {
  it('mints a high-entropy token and stores only its SHA-256 hash', async () => {
    const { plaintext, hash } = await generateToken();

    expect(plaintext.length).toBeGreaterThanOrEqual(40);
    expect(plaintext).toMatch(/^[A-Za-z0-9_-]+$/); // base64url — safe in an Authorization header
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(plaintext);
  });

  it('hashes deterministically, so a presented token can be looked up by hash', async () => {
    const { plaintext, hash } = await generateToken();

    await expect(hashToken(plaintext)).resolves.toBe(hash);
  });

  it('never repeats', async () => {
    const tokens = await Promise.all(Array.from({ length: 25 }, () => generateToken()));
    const unique = new Set(tokens.map((token) => token.plaintext));

    expect(unique.size).toBe(25);
  });
});

describe('uuid', () => {
  it('is a v4 UUID (§12)', () => {
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

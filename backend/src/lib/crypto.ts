/**
 * Opaque bearer tokens and UUIDs (FULLPLAN §38, §12).
 *
 * Password hashing does **not** live here any more. Phase 4.5 moved the PBKDF2 chain behind
 * the `AuthGuardDO` boundary (`src/do/auth-guard.ts`), because a free Worker's 10 ms CPU
 * budget cannot hold §38's 600,000 iterations while a Durable Object's 30-second budget can
 * — see the header of that file, and deviations D14/D15/D19. Nothing outside the DO module
 * calls `crypto.subtle.deriveBits`; the platform gate enforces it.
 *
 * What remains here is cheap: token minting (a random read), token hashing (one SHA-256),
 * and UUIDs. None of it needs the DO's CPU budget, and the `authenticate` middleware runs
 * `hashToken` on every request — sending that through a DO would put a Durable Object round
 * trip on every authenticated call in the system for no benefit.
 */

const TOKEN_BYTES = 32; // → 43 base64url chars, comfortably over the §38 40-char floor.

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * A fresh opaque bearer token. The plaintext is returned once, to the caller that will
 * hand it to the client; only `hash` is ever persisted (§38).
 */
export async function generateToken(): Promise<{ plaintext: string; hash: string }> {
  const plaintext = toBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));

  return { plaintext, hash: await hashToken(plaintext) };
}

/** SHA-256, hex-encoded — the lookup key for `api_tokens.token_hash`. */
export async function hashToken(plaintext: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(plaintext)));
}

/** UUID v4 primary keys, per §12 — never auto-increment integers. */
export function uuid(): string {
  return crypto.randomUUID();
}

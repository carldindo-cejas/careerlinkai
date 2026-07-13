/**
 * Password hashing and opaque bearer tokens (FULLPLAN §38).
 *
 * PBKDF2-SHA256 via WebCrypto, not bcrypt/argon2: Workers has no native implementation of
 * either, and a pure-JS argon2 would be both slower and weaker in practice under the
 * Worker CPU limit. WebCrypto's PBKDF2 runs at full native speed.
 */

const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_KEY_BITS = 256;
const SALT_BYTES = 16;
const TOKEN_BYTES = 32; // → 43 base64url chars, comfortably over the §38 40-char floor.

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    keyMaterial,
    PBKDF2_KEY_BITS,
  );

  return new Uint8Array(bits);
}

/**
 * Hash a password into `pbkdf2$iterations$salt$hash`.
 *
 * The iteration count is stored *in* the hash so it can be raised later without
 * invalidating every existing hash — old hashes keep verifying at their original cost.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await deriveKey(password, salt, PBKDF2_ITERATIONS);

  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(derived)}`;
}

/** Constant-time comparison — a length-or-content early return would leak the hash byte by byte. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let difference = 0;

  for (let i = 0; i < a.length; i += 1) {
    difference |= (a[i] as number) ^ (b[i] as number);
  }

  return difference === 0;
}

/**
 * Verify a password against a stored `pbkdf2$iterations$salt$hash` string.
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

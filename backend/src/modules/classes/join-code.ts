/**
 * Class join codes (FULLPLAN §13.2, §38) — `ABCD-7284`.
 *
 * Four letters, a hyphen, four digits. The alphabet excludes **I, O, 0 and 1**: a student
 * types this by hand from a whiteboard, and a failed join deliberately reveals nothing about
 * *why* it failed (§38), so an `O` misread as a `0` would be an undebuggable dead end. That
 * costs two letters and two digits and buys a keyspace of 24⁴ × 8⁴ ≈ 1.36 billion, which is
 * ample against a code that also expires and is rate-limited by `(code, IP)`.
 */

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // 24 — no I, no O
const DIGITS = '23456789'; // 8 — no 0, no 1

/**
 * Pick one character uniformly.
 *
 * Rejection sampling rather than a plain `byte % alphabet.length`: 256 is not a multiple of
 * 24, so the modulo alone would make the first 16 letters measurably likelier than the rest.
 * The code is a security boundary — it does not get to have a lopsided distribution.
 */
function pick(alphabet: string, bytes: Uint8Array, cursor: { at: number }): string {
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;

  for (;;) {
    if (cursor.at >= bytes.length) {
      crypto.getRandomValues(bytes);
      cursor.at = 0;
    }

    const byte = bytes[cursor.at]!;
    cursor.at += 1;

    if (byte < limit) {
      return alphabet[byte % alphabet.length]!;
    }
  }
}

/** A fresh join code. Uniqueness against the table is the caller's job (`ClassService`). */
export function generateJoinCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const cursor = { at: 0 };

  let letters = '';
  let digits = '';

  for (let i = 0; i < 4; i += 1) {
    letters += pick(LETTERS, bytes, cursor);
  }

  for (let i = 0; i < 4; i += 1) {
    digits += pick(DIGITS, bytes, cursor);
  }

  return `${letters}-${digits}`;
}

/**
 * Normalise a code as typed by a student: trim, upper-case.
 *
 * No format validation and no repair (no "did you mean 0 → O"): the join endpoint answers
 * every failure identically (§38), and a `422` for a malformed code would answer — before
 * the attempt is even charged against the rate limit — exactly the question the endpoint is
 * built not to answer.
 */
export function normalizeJoinCode(code: string): string {
  return code.trim().toUpperCase();
}

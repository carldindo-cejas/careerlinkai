import { RIASEC_DIMENSIONS } from '@/db/enums';

/**
 * The Holland code rule (FULLPLAN §13.3, §27) — `careers.typical_riasec_code`.
 *
 * This is the field that makes a career scoreable. §27 reads it **positionally** against the
 * student's normalized RIASEC profile, weighting the letters `[0.5, 0.3, 0.2]`: the first
 * letter is the dominant type. Order is data, not formatting.
 *
 * Every constraint below exists because the engine would otherwise **misread** the value
 * rather than reject it — §27 has no way to tell a bad code from a good one:
 *
 * | Rule | Why |
 * |---|---|
 * | Letters from `R I A S E C` only | §27 looks each letter up against a dimension score. `X` has none. |
 * | At most 3 letters | The column is VARCHAR(6) per §13.3, but there are only three position weights. A fourth letter is read at an index with no weight and silently counts for nothing. |
 * | No repeated letter | `"IIE"` would weight Investigative at 0.5 + 0.3 = 0.8, scoring a one-dimensional student as a near-perfect match for a career they are not. |
 *
 * The column keeps its §13.3 width; the input does not. And none of this is expressible as a
 * SQLite CHECK — "no repeated letter" in particular — which is why it lives here, in the one
 * place both the create and the update path go through.
 */

/** Three position weights (§27), hence three letters. See `MAX_LETTERS`. */
export const MAX_HOLLAND_LETTERS = 3;

export interface HollandCodeResult {
  ok: boolean;
  /** The normalized code on success: uppercased, or `null` for "no code". */
  value: string | null;
  message?: string;
}

/**
 * Validate and normalize a Holland code.
 *
 * Case is not enforced on input — `"iec"` is accepted and **stored as `"IEC"`**. §27 compares
 * each letter against a dimension key, so the case is settled once on write rather than at
 * every read site.
 *
 * `null` is valid: a career with no Holland code is a legitimate catalog entry that simply
 * cannot be RIASEC-matched. An **empty string normalises to `null`** rather than passing
 * through — `""` would reach §27 as a zero-letter code to iterate over.
 */
export function parseHollandCode(input: string | null | undefined): HollandCodeResult {
  if (input === null || input === undefined) {
    return { ok: true, value: null };
  }

  const code = input.trim().toUpperCase();

  if (code === '') {
    return { ok: true, value: null };
  }

  if (code.length > MAX_HOLLAND_LETTERS) {
    return {
      ok: false,
      value: null,
      message: `A Holland code is at most ${MAX_HOLLAND_LETTERS} letters — only the first three are scored.`,
    };
  }

  const letters = code.split('');

  const alphabet: readonly string[] = RIASEC_DIMENSIONS;

  if (letters.some((letter) => !alphabet.includes(letter))) {
    return {
      ok: false,
      value: null,
      message: `A Holland code uses only the letters ${RIASEC_DIMENSIONS.join(', ')}.`,
    };
  }

  if (new Set(letters).size !== letters.length) {
    return {
      ok: false,
      value: null,
      message: 'A Holland code cannot repeat a letter.',
    };
  }

  return { ok: true, value: code };
}

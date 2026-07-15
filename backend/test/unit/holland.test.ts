import { describe, expect, it } from 'vitest';

import { parseHollandCode } from '@/lib/holland';

/**
 * The Holland code rule in isolation (FULLPLAN §13.3, §27).
 *
 * The HTTP-level contract is covered in test/catalog/careers.test.ts; this pins the rule
 * itself, because Phase 4 reads `typical_riasec_code` positionally and has no way to tell a
 * bad code from a good one. Every rejection below is a value the engine would otherwise
 * **misread** rather than refuse.
 */

describe('parseHollandCode', () => {
  it('accepts a canonical three-letter code', () => {
    expect(parseHollandCode('IEC')).toEqual({ ok: true, value: 'IEC' });
  });

  it('normalises case — the case is settled once, on write', () => {
    expect(parseHollandCode('iec').value).toBe('IEC');
    expect(parseHollandCode('iEc').value).toBe('IEC');
  });

  it('trims surrounding whitespace', () => {
    expect(parseHollandCode('  ICE  ').value).toBe('ICE');
  });

  it('preserves letter order, which is data and not formatting', () => {
    // §27 weights the positions [0.5, 0.3, 0.2], so "IEC" and "CEI" are different careers.
    expect(parseHollandCode('IEC').value).toBe('IEC');
    expect(parseHollandCode('CEI').value).toBe('CEI');
  });

  it('accepts one and two letter codes', () => {
    expect(parseHollandCode('S').value).toBe('S');
    expect(parseHollandCode('AS').value).toBe('AS');
  });

  it('treats null, undefined and the empty string as "no code"', () => {
    // `""` would otherwise reach §27 as a zero-letter code to iterate over.
    expect(parseHollandCode(null)).toEqual({ ok: true, value: null });
    expect(parseHollandCode(undefined)).toEqual({ ok: true, value: null });
    expect(parseHollandCode('')).toEqual({ ok: true, value: null });
    expect(parseHollandCode('   ')).toEqual({ ok: true, value: null });
  });

  it('rejects a letter outside R I A S E C — §27 has no dimension to look it up against', () => {
    expect(parseHollandCode('IXC').ok).toBe(false);
    expect(parseHollandCode('Z').ok).toBe(false);
    expect(parseHollandCode('I3C').ok).toBe(false);
  });

  /**
   * The column is VARCHAR(6) per §13.3, but there are only three position weights. A fourth
   * letter is read at an index with no weight and silently counts for nothing — so the input
   * is refused rather than accepted and quietly ignored at scoring time.
   */
  it('rejects a fourth letter', () => {
    const result = parseHollandCode('IECR');

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/at most 3 letters/i);
  });

  /**
   * "IIE" would weight Investigative at 0.5 + 0.3 = 0.8, scoring a one-dimensional student as
   * a near-perfect match for a career they are not.
   */
  it('rejects a repeated letter', () => {
    const result = parseHollandCode('IIE');

    expect(result.ok).toBe(false);
    expect(result.message).toBe('A Holland code cannot repeat a letter.');
  });

  it('rejects a repeat that differs only in case', () => {
    expect(parseHollandCode('iI').ok).toBe(false);
  });

  it('never returns a value on rejection', () => {
    // A caller that ignores `ok` must not be handed a half-parsed code to store.
    expect(parseHollandCode('IIE').value).toBeNull();
    expect(parseHollandCode('IECR').value).toBeNull();
  });
});

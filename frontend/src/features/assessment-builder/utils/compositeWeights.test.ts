import { describe, expect, it } from 'vitest';

import {
  balancePercents,
  bandFor,
  bandProblems,
  isBalanced,
  sampleComposite,
  toFractions,
  toPercent,
} from '@/features/assessment-builder/utils/compositeWeights';

const BANDS = [
  { min: 84, max: 100, label: 'Very High' },
  { min: 68, max: 84, label: 'High' },
  { min: 0, max: 68, label: 'Moderate' },
];

describe('composite weight arithmetic', () => {
  it('round-trips between stored fractions and displayed percentages', () => {
    expect(toPercent(0.4)).toBe(40);
    expect(toPercent(1 / 3)).toBe(33.3);
    expect(toFractions({ SE: 40, OE: 30, GO: 30 })).toEqual({ SE: 0.4, OE: 0.3, GO: 0.3 });
  });

  it('checks the total with float slack', () => {
    expect(isBalanced({ SE: 33.3, OE: 33.3, GO: 33.4 })).toBe(true);
    expect(isBalanced({ SE: 40, OE: 30, GO: 20 })).toBe(false);
  });

  it('balances to exactly 100, keeping the ratio and putting the leftover last', () => {
    const balanced = balancePercents({ SE: 1, OE: 1, GO: 1 }, ['SE', 'OE', 'GO']);

    expect(balanced).toEqual({ SE: 33.3, OE: 33.3, GO: 33.4 });
    expect(balancePercents({ SE: 80, OE: 60, GO: 60 }, ['SE', 'OE', 'GO'])).toEqual({
      SE: 40,
      OE: 30,
      GO: 30,
    });
    expect(balancePercents({}, ['SE', 'OE'])).toEqual({ SE: 50, OE: 50 });
  });

  it('computes the worked example the way the scorer does', () => {
    expect(sampleComposite({ SE: 80, OE: 60, GO: 50 }, { SE: 40, OE: 30, GO: 30 })).toBe(65);
    expect(sampleComposite({ SE: 80 }, { SE: 0 })).toBeNull();
  });

  it('gives a shared edge to the higher band', () => {
    expect(bandFor(BANDS, 84)).toBe('Very High');
    expect(bandFor([...BANDS].reverse(), 84)).toBe('Very High');
    expect(bandFor(BANDS, 50)).toBe('Moderate');
  });

  it('reports gaps, overlaps, bad ends and blank labels', () => {
    expect(bandProblems(BANDS)).toEqual([]);
    expect(bandProblems([{ min: 0, max: 40, label: 'a' }, { min: 50, max: 100, label: 'b' }])).toEqual([
      'Nothing covers 40–50.',
    ]);
    expect(bandProblems([{ min: 0, max: 60, label: 'a' }, { min: 50, max: 100, label: 'b' }])).toEqual([
      '"a" and "b" overlap.',
    ]);
    expect(bandProblems([{ min: 10, max: 90, label: 'a' }])).toHaveLength(2);
    expect(bandProblems([{ min: 0, max: 100, label: ' ' }])).toHaveLength(1);
  });
});

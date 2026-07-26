import { describe, expect, it } from 'vitest';

import { chunkForD1 } from '@/modules/address/address-service';

/**
 * `chunkForD1` — the pure arithmetic behind the bulk-import fix. D1 rejects any statement binding
 * more than 100 parameters, and a multi-row insert binds one per column per row; miniflare enforces
 * no such limit, so this unit test is the only place the ceiling is checked directly. The rule:
 * every emitted chunk must stay under the cap, and no row may be lost, duplicated or reordered.
 */

/** The two real row shapes: a region (six columns) and a parented level (seven). */
function regionRows(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `id-${i}`,
    code: null,
    name: `Region ${i}`,
    createdAt: 't',
    updatedAt: 't',
    deletedAt: null,
  }));
}

function provinceRows(n: number): Record<string, unknown>[] {
  return regionRows(n).map((row, i) => ({ ...row, regionId: `r-${i}` }));
}

describe('chunkForD1', () => {
  it('returns nothing for an empty set', () => {
    expect(chunkForD1([])).toEqual([]);
  });

  it('keeps a small set in a single chunk', () => {
    const rows = regionRows(5);
    const chunks = chunkForD1(rows);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(5);
  });

  it('splits a six-column set at 15 rows per chunk (90 / 6)', () => {
    const chunks = chunkForD1(regionRows(40));

    expect(chunks.map((chunk) => chunk.length)).toEqual([15, 15, 10]);
  });

  it('splits a seven-column set at 12 rows per chunk (90 / 7)', () => {
    const chunks = chunkForD1(provinceRows(30));

    expect(chunks.map((chunk) => chunk.length)).toEqual([12, 12, 6]);
  });

  it('never lets a chunk exceed the 100-parameter cap', () => {
    for (const rows of [regionRows(1000), provinceRows(1000)]) {
      const columns = Object.keys(rows[0]!).length;

      for (const chunk of chunkForD1(rows)) {
        expect(chunk.length * columns).toBeLessThanOrEqual(100);
      }
    }
  });

  it('loses, duplicates and reorders nothing', () => {
    const rows = provinceRows(101);
    const flattened = chunkForD1(rows).flat();

    expect(flattened).toEqual(rows);
  });

  it('still emits a single very wide row rather than dropping it', () => {
    const wide = [Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`c${i}`, i]))];
    const chunks = chunkForD1(wide);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(1);
  });
});

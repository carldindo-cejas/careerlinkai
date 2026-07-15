import { describe, expect, it } from 'vitest';

import { chunkForD1 } from '@/modules/recommendation/recommendation-service';

/**
 * The regression guard for the **third** platform limit this project shipped past (§27, Phase 4).
 *
 * D1 refuses a query binding more than **100 parameters**. A `recommendations` row binds 10 columns
 * and a full §27 set is 20 rows (top 10 careers + top 10 programs), so inserting it as one statement
 * binds 200 and D1 rejects the query.
 *
 * **Nothing local could catch it, twice over.** Miniflare's SQLite allows 999 bound variables, so the
 * oversized insert simply worked. And the *test* catalog is small — a couple of careers, a couple of
 * programs — so the insert never even reached 20 rows: the suite stayed under the cap by accident,
 * not by design. It took a real D1 and a real catalog, and it surfaced as a student getting a
 * correctly scored assessment and a blank recommendations screen, because `dispatch()` swallows a
 * listener's failure by design (a recommendation must never fail a submitted assessment).
 *
 * So, exactly as with the PBKDF2 iteration cap, the only thing a local test can pin is **what the
 * code asks of the platform**. `chunkForD1` is that question made explicit, and this is the test of
 * it. Asserting on a successful insert here would prove nothing at all — it proved nothing before.
 */
describe("D1's 100-bound-parameter limit (§27 — found on the staging deploy)", () => {
  const D1_MAX_BOUND_PARAMETERS = 100;
  const RECOMMENDATION_COLUMNS = 10;

  it('never builds an insert that binds more than D1 will accept', () => {
    // The worst case §27 can produce: TOP_N careers + TOP_N programs, all at once.
    const fullSet = Array.from({ length: 20 }, (_, i) => i);

    for (const chunk of chunkForD1(fullSet)) {
      expect(chunk.length * RECOMMENDATION_COLUMNS).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    }
  });

  it('leaves headroom, so adding one column does not silently break it again', () => {
    const fullSet = Array.from({ length: 20 }, (_, i) => i);

    for (const chunk of chunkForD1(fullSet)) {
      // +1 column on `recommendations` must not push any chunk over the ceiling. The failure mode
      // is invisible — an exception nobody sees and an empty screen — so it is worth the slack.
      expect(chunk.length * (RECOMMENDATION_COLUMNS + 1)).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
    }
  });

  it('loses no rows and preserves their order — the ranking is the point', () => {
    const rows = Array.from({ length: 20 }, (_, i) => i);

    expect(chunkForD1(rows).flat()).toEqual(rows);
  });

  it('handles the small and empty cases without producing an empty statement', () => {
    expect(chunkForD1([])).toEqual([]);
    expect(chunkForD1([1, 2, 3])).toEqual([[1, 2, 3]]);
  });
});

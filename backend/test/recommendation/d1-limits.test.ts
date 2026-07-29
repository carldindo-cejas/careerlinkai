import { describe, expect, it } from 'vitest';

import { D1_MAX_BOUND_PARAMS, chunkIds } from '@/lib/d1-batching';
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

/**
 * The **fourth**, and the same ceiling read from the other side (found on staging, 2026-07-28).
 *
 * Everything above guards the *width* of an INSERT. `WHERE id IN (…)` binds one parameter per id,
 * which is not wide but is arbitrarily long, and it draws on the identical 100-parameter budget.
 * `scorableCareersForMany` passed **every rankable program** to one `inArray`, so the statement's
 * size was the size of the catalog.
 *
 * That is why audit item P0-1 — growing the catalog from 16 programs to 309 precisely so the
 * ranking would discriminate between students — is what broke it. `generateFor` threw
 * `too many SQL variables`, the `AssessmentCompleted` listener swallowed the exception exactly as
 * designed, and every student who finished both instruments on the deployed Worker got a correctly
 * scored assessment and **zero recommendations**, with no error anywhere a human would look.
 *
 * The fix that made the catalog meaningful is the fix that disabled the feature the catalog is for.
 * Miniflare enforces no parameter limit, so all 807 tests passed throughout.
 */
describe("D1's 100-bound-parameter limit, on the read side (found on staging)", () => {
  /** The catalog as seed 0004 leaves it, and a deliberately larger one. */
  const CATALOG_SIZES = [309, 1_000];

  it('never builds an IN clause that binds more than D1 will accept', () => {
    for (const size of CATALOG_SIZES) {
      const ids = Array.from({ length: size }, (_, i) => `program-${i}`);

      for (const chunk of chunkIds(ids)) {
        expect(chunk.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
      }
    }
  });

  it('leaves room for the other bindings the same statement carries', () => {
    // `scorableCareersForMany` also binds `careers.status = 'active'`, and `offeringCountsFor`
    // binds a status too. A chunk sized to exactly 100 would be over the cap the moment any
    // predicate joins it — which is how a query that "obviously fits" does not.
    const ids = Array.from({ length: 309 }, (_, i) => `program-${i}`);

    for (const chunk of chunkIds(ids)) {
      expect(chunk.length + 2).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    }
  });

  it('loses no ids — a dropped chunk is a program that silently stops being ranked', () => {
    const ids = Array.from({ length: 309 }, (_, i) => `program-${i}`);

    expect(chunkIds(ids).flat()).toEqual(ids);
    expect(new Set(chunkIds(ids).flat()).size).toBe(ids.length);
  });

  it('handles the small and empty cases', () => {
    expect(chunkIds([])).toEqual([]);
    expect(chunkIds(['a', 'b'])).toEqual([['a', 'b']]);
  });
});

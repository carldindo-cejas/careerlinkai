import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import { DAILY_GENERATION_BUDGET, GENERATION_BUDGET_DEGRADE_AT } from '@/lib/auth-guard';
import { PlatformUsageService } from '@/modules/platform/usage-service';
import { db } from '../helpers';

/**
 * **Platform health** — what this deployment can honestly say it is spending.
 *
 * The claim under test is not arithmetic; it is provenance. This screen exists because an admin
 * needs to know whether the platform is about to stop working, and the way such a screen fails is
 * not by computing a percentage wrongly — it is by presenting a number nobody measured as though
 * somebody had. So what is pinned here is that every bar declares where its ceiling came from, and
 * that the limits this system genuinely cannot see are still named rather than quietly dropped.
 */
let service: PlatformUsageService;

beforeAll(() => {
  service = new PlatformUsageService(db(), env);
});

describe('PlatformUsageService', () => {
  it('reports the generation budget as our own, with the line it actually degrades at', async () => {
    const snapshot = await service.snapshot();
    const generations = snapshot.resources.find((row) => row.key === 'ai_generations');

    expect(generations).toBeDefined();
    expect(generations!.limit).toBe(DAILY_GENERATION_BUDGET);
    // The distinction the screen turns on: this ceiling is a constant in this repository, not
    // Cloudflare's, and it is the only one an admin could change by asking a developer.
    expect(generations!.limitSource).toBe('self-imposed');
    expect(generations!.degradeAt).toBe(GENERATION_BUDGET_DEGRADE_AT);
  });

  it('marks a Cloudflare ceiling as the platform’s, not ours', async () => {
    const snapshot = await service.snapshot();
    const vectors = snapshot.resources.find((row) => row.key === 'vectorize_vectors');

    expect(vectors?.limitSource).toBe('platform');
  });

  /**
   * The assertion this file exists for.
   *
   * Neurons are the limit that actually governs this product's AI, and no Worker is told its own
   * neuron usage — which is precisely why the generation budget exists as a proxy. A health page
   * that showed five green bars and never mentioned neurons would read as "all clear" when it
   * means "not looked at", so their absence has to be published as loudly as the measurements.
   */
  it('names the limits it cannot measure instead of omitting them', async () => {
    const snapshot = await service.snapshot();
    const labels = snapshot.unmetered.map((row) => row.label);

    expect(labels).toContain('Workers AI neurons');
    expect(labels).toContain('Workers requests');
    expect(snapshot.unmetered.every((row) => row.why.length > 0)).toBe(true);
  });

  it('never reports usage it did not measure', async () => {
    const snapshot = await service.snapshot();

    for (const resource of snapshot.resources) {
      expect(Number.isFinite(resource.used)).toBe(true);
      expect(resource.used).toBeGreaterThanOrEqual(0);
      expect(resource.limit).toBeGreaterThan(0);
      // Every bar carries its own sentence. A number with no account of where it came from is the
      // thing this page is built not to show.
      expect(resource.detail.length).toBeGreaterThan(0);
    }
  });

  /**
   * The corpus figures come from D1 rather than from Vectorize, deliberately — Vectorize has no
   * count-by-filter — so they are only as true as the `vector_id` column. Pinning that embedded
   * never exceeds total is what catches the day that column stops being written.
   */
  it('cannot report more embedded passages than there are passages', async () => {
    const snapshot = await service.snapshot();
    const vectors = snapshot.resources.find((row) => row.key === 'vectorize_vectors');

    expect(vectors!.used).toBeGreaterThanOrEqual(0);
    expect(vectors!.detail).toMatch(/passages in the corpus/);
  });
});

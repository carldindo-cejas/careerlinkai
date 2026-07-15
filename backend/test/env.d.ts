import type { D1Migration } from 'cloudflare:test';

import type { Env as WorkerEnv } from '@/env';

/**
 * The bindings a test sees through `cloudflare:test`'s `env`.
 *
 * `@cloudflare/vitest-pool-workers` types that object as `Cloudflare.Env` — the global
 * interface `wrangler types` would generate — so the Worker's own `Env` (src/env.ts, which
 * stays the single hand-written definition of the bindings) is merged into it here, plus
 * the `TEST_MIGRATIONS` binding vitest.config.ts injects for test/setup.ts.
 */
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

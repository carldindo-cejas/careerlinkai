import path from 'node:path';

import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Tests run inside the real Workers runtime (workerd) against real local D1/KV/R2 bindings
 * (FULLPLAN §49) — a feature test therefore exercises the same router, middleware and SQL
 * dialect as production, and the bindings come from wrangler.toml rather than a mock.
 *
 * The migrations are read at config time and handed to the test worker as a binding, so
 * `applyD1Migrations()` in test/setup.ts can build a fresh schema for the isolated storage
 * stack each test runs against.
 *
 * API note: `@cloudflare/vitest-pool-workers` v0.18 (Vitest 4) replaced the old
 * `defineWorkersConfig` + `test.poolOptions.workers` shape with the `cloudflareTest()` Vite
 * plugin, and dropped the `isolatedStorage` / `singleWorker` switches — per-test isolated
 * storage is now the built-in behaviour rather than something to opt into.
 *
 * **The config is `wrangler.test.toml`, not `wrangler.toml`** — the same Worker minus the `AI`
 * and `VECTORIZE` bindings, which have no local emulation and therefore open a real connection
 * to the Cloudflare API before a single assertion runs. Pointing the pool at the production
 * config meant an expired `wrangler login` token took the whole suite from green to "no tests",
 * and would have forced CI to hold a live API token to run tests that never call Cloudflare.
 * See the header of wrangler.test.toml. The suite is hermetic: it runs offline.
 */
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.test.toml' },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    test: {
      setupFiles: ['./test/setup.ts'],
      // PBKDF2 (§38) costs real CPU on purpose, and an auth test pays it several times over —
      // fixtures, logins, rotations. Vitest's 5s default times those out. The right response is a
      // timeout that fits the work, not a weaker hash in tests: lowering the iteration count here
      // would mean the suite stops exercising the parameters production actually runs.
      //
      // Raised 30s → 60s in Step 3, when the §38 lockout test (five *failed* logins plus a success,
      // each paying the full derivation — a fast rejection would be a timing oracle telling an
      // attacker the email exists) began tipping over 30s as the suite grew and the workers started
      // competing for cores. The test was never wrong; the budget was.
      //
      // Raised 60s → 120s in **Phase 4**, and this time it is not the hash. `test/recommendation/`
      // needs a student who has completed *both* RIASEC and SCCT before a single recommendation
      // exists, and completing an assessment means POSTing every answer individually through the
      // real HTTP surface: 60 requests, then 30. ~90 round trips per fully-assessed student is the
      // cost of testing the thing that actually ships rather than a service call in a vacuum. (The
      // fixtures are shared within that file to keep it from being ~90 round trips *per test*.)
      testTimeout: 120_000,
      // Step 4's assessment fixtures install RIASEC (60 items) and SCCT (30) in `beforeAll`,
      // **through the real builder service and its publish gate** — which is the point of them
      // (§57). Phase 4 then added a `beforeAll` that drives a student through both instruments.
      // Vitest's 10s default is not a statement about whether that work is reasonable, only about
      // how long a hook usually takes. Same reasoning as `testTimeout`: fit the budget to the work.
      hookTimeout: 120_000,
    },
  };
});

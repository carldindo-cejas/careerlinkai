import path from 'node:path';

import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

/**
 * Tests run inside the real Workers runtime (workerd) against real local D1/KV bindings
 * (FULLPLAN §49) — a feature test therefore exercises the same router, middleware and SQL
 * dialect as production.
 *
 * The migrations are read at config time and handed to the test worker as a binding, so
 * `applyD1Migrations()` in test/setup.ts can build a fresh schema per isolated storage stack.
 */
export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));

  return {
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    test: {
      setupFiles: ['./test/setup.ts'],
      poolOptions: {
        workers: {
          singleWorker: true,
          isolatedStorage: true,
          wrangler: { configPath: './wrangler.toml' },
          miniflare: {
            bindings: { TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  };
});

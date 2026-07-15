import { applyD1Migrations, env } from 'cloudflare:test';

/**
 * Build the schema once, from the real migration files (FULLPLAN §49, §50).
 *
 * The tests run against the same plain-SQL migrations that ship to D1 — not a Drizzle-
 * generated schema — so a migration that is wrong (a missing CHECK, a forgotten index) is
 * wrong in the test suite too, which is the only place it can be caught before production.
 *
 * **Storage is shared between the tests in a file, not rolled back per test.** The
 * `isolatedStorage` option that used to provide that was removed in vitest-pool-workers
 * v0.18, so a test must never assume a globally empty table: identify your own rows (a
 * fixture's user id, its email) rather than asserting on "the only row in `audit_logs`".
 * Fixtures generate unique emails and UUIDs precisely so this stays safe.
 */
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

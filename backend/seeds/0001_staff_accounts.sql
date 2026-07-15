-- Seed 0001 — the two staff accounts the Phase 0 demo signs in with (FULLPLAN §57 Step 1).
--
-- There is no self-registration anywhere in this system (§5): the very first admin has to
-- come from somewhere, and this is it. Everyone else is created by an admin from here on.
--
-- Both accounts ship with a temporary password and `must_change_password = 1`, which is the
-- activation model §13.1 specifies: the forced rotation *is* the activation step, and until
-- it happens the token the temp password buys opens nothing else (see
-- middleware/ensure-password-changed.ts).
--
--   admin@careerlinkai.online      / ChangeMe123
--   counselor@careerlinkai.online  / ChangeMe123
--
-- The `password` values below are real PBKDF2-SHA256 hashes in the §38 format
-- `pbkdf2$iterations$salt$hash`, at the same 600,000 iterations src/lib/crypto.ts uses —
-- they were generated once and pasted here because SQL cannot derive a key.
--
-- ⚠️  These credentials are public: they live in the repository. That is acceptable for a
-- local database and for a staging bootstrap *because* the first login forces a rotation.
-- Before running this against production (`npm run db:seed:remote`), regenerate the hashes
-- with a private password — a committed hash is a published credential until it is changed.
--
-- ⚠️  A hash and the password it is *documented* as encoding can drift apart silently, and
-- has now done so twice. SQL cannot derive a PBKDF2 key, so this file is the one place in the
-- system where a credential is *asserted* rather than computed, and an assertion is only as
-- good as the last person who checked it:
--
--   1. (Browser pass) These hashes were found to encode the rotated local dev passwords, not
--      `ChangeMe123`, while every comment here and in PROGRESS.md said `ChangeMe123`.
--   2. (Step 5, staging deploy) The hashes were regenerated **again**, and are now written at
--      **100,000** iterations rather than §38's 600,000. Two separate Cloudflare limits forced
--      this, neither of which any local test can see (Miniflare enforces neither):
--        * the runtime refuses PBKDF2 above 100,000 iterations **per deriveBits() call**, and
--        * a **Free**-plan Worker's CPU limit cannot be raised, so the 600,000 iterations
--          §38 asks for exceeded it and killed /auth/change-password with error 1102.
--      See the long note in src/lib/crypto.ts, including how to restore §38 on a paid plan
--      (one line there, one in wrangler.toml — no stored hash breaks, because the cost is
--      recorded inside each hash).
--
-- If you ever change a hash below, verify it end to end (seed an empty database, then *log
-- in*) rather than trusting the comment. Better: do not change it by hand at all.
-- `scripts/bootstrap-staff.mjs` derives and verifies its hashes at run time, and its
-- `--verify-url` flag logs in against a live deployment to prove the claim. It is the only
-- supported way to seed a **remote** database — a committed hash is a published credential,
-- which is tolerable here (local only, and the first login forces a rotation) and is not
-- tolerable there.
--
-- Idempotent: re-running it leaves an already-seeded database untouched rather than failing
-- on the unique email index, so it is safe to apply to a database that may already be set up.
--
-- Timestamps are written as ISO-8601 UTC (`strftime`), not SQLite's bare `CURRENT_TIMESTAMP`:
-- the latter renders as `2026-07-13 14:11:05`, which every other row in this database is not,
-- and which JavaScript's `new Date()` reads as *local* time rather than UTC. Application code
-- writes ISO strings (src/lib/datetime.ts) and the API serializes `created_at` straight
-- through to the client, so a seeded row has to look exactly like an app-written one.

INSERT OR IGNORE INTO users (
    id, name, email, password, role, status, must_change_password, created_at, updated_at
) VALUES (
    'fa3a4f50-3b48-485d-b43a-59a302f4a67c',
    'CareerLinkAI Administrator',
    'admin@careerlinkai.online',
    'pbkdf2$100000$dL4+TG/DYOXZM9+TFCesdQ==$O6GHxX8wNmM+rzNJq+D9C7ORW7xgMbHItLte9QVUrD4=',
    'admin',
    'active',
    1,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

INSERT OR IGNORE INTO users (
    id, name, email, password, role, status, must_change_password, created_at, updated_at
) VALUES (
    'c10cbecf-ad28-41dc-8323-7198f00e218f',
    'Maria Santos',
    'counselor@careerlinkai.online',
    'pbkdf2$100000$Ll98+KmlGDLE9jtY9uSiEw==$leoTvmWL+Qc3F2/3Qu7gYyUkGZ3wVE9DpfV1SmD+BXE=',
    'counselor',
    'active',
    1,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

-- Every counselor has a profile row; the login response embeds it (`counselor_profile`), and
-- the frontend's User type expects it for this role.
INSERT OR IGNORE INTO counselor_profiles (
    id, user_id, first_name, last_name, phone, employee_number, specialization, created_at, updated_at
) VALUES (
    '055b0679-04c3-44dd-a5d0-21e6f6786114',
    'c10cbecf-ad28-41dc-8323-7198f00e218f',
    'Maria',
    'Santos',
    '+63 917 000 0000',
    'EMP-0001',
    'Career Guidance',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

-- Migration 0034 — counselor self-signup, and the switch that closes it
--
-- Prompt-driven (2026-09-11). Two tables that arrive together because neither is useful alone:
-- one holds a signup that has not been verified yet, the other holds the flag that decides whether
-- a signup may be started at all.
--
-- ## What was missing
--
-- Every counselor account in this system is minted by an administrator through
-- `POST /admin/counselors`, which generates a temporary password and shows it once (§13.1, §38).
-- That is the right shape for the first few accounts and it does not scale past them: onboarding a
-- school means an admin typing every counselor in by hand and then relaying a password out of band
-- to each of them. There has never been a way for a counselor to register themselves.
--
-- ## Why registration needs a switch, and why the switch is a row rather than a var
--
-- This deployment runs on the Cloudflare Free plan (FULLPLAN §45, ratified) and sends its mail
-- through a Resend free tier capped at 100 messages a day, shared with password resets. An open
-- registration form is therefore a lever anybody on the internet can pull against a budget the
-- whole product depends on — and an account that reaches `active` can read the results of every
-- student in a class it creates.
--
-- So registration is a thing an administrator turns on, and can turn off again in one click,
-- without a deploy and with a row in the audit log naming who did it. A `[vars]` entry in
-- wrangler.toml would have avoided this table and cost a `wrangler deploy` per flip — which, on an
-- afternoon when signups are being abused, is the difference between closing the door and waiting
-- on a build. It would also leave no trace of who closed it.
--
-- `app_settings` is deliberately a generic key/value table with a *registry in code*
-- (`APP_SETTINGS` in src/modules/platform/settings-service.ts) rather than one column per flag: a
-- new flag is then a constant and a migration-free deploy, while a typo'd key is a type error
-- rather than a silently-absent setting that reads as `false` forever.

CREATE TABLE app_settings (
    -- The key is the registry name in settings-service.ts. Nothing reads a key that is not there.
    key TEXT PRIMARY KEY NOT NULL,

    -- TEXT, not a typed column: the table is generic and the registry is what knows that
    -- `counselor_signup_enabled` is a boolean written as 'true'/'false'. One value shape per key,
    -- enforced in code where the key's meaning already lives.
    value TEXT NOT NULL,

    -- Who last changed it. NULL for the seeded default below, which no person chose.
    updated_by TEXT REFERENCES users(id),

    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- **Seeded off.** Deploying this feature must not open registration on careerlinkai.online by the
-- act of deploying it; an administrator turns it on deliberately, having decided they want it. A
-- missing row is also read as off (see `SettingsService.get`), so a failed seed fails closed.
INSERT INTO app_settings (key, value, updated_by, updated_at)
VALUES ('counselor_signup_enabled', 'false', NULL, CURRENT_TIMESTAMP);


-- ## Why an unverified signup is not a users row
--
-- The obvious implementation is to insert the counselor immediately with `status = 'pending'` and
-- flip it to `active` when the code is verified. It was rejected for two reasons, both of which
-- only show up once the form is public:
--
--   1. **It lets a stranger squat an email address.** `users_email_unique` covers soft-deleted rows
--      too, so a single unverified submission would permanently block the real owner of that
--      address from ever registering — and from being added by an admin either.
--   2. **It puts junk in the counselor list.** `/admin/counselors` reads `users` joined to
--      `counselor_profiles`; every abandoned signup would appear there as an account to deal with.
--
-- So a signup is staged here and becomes a `users` row only when the code is verified — at which
-- point `users_email_unique` is the thing that resolves a race between two people claiming the
-- same address, exactly as it does for admin creation (see `translateUniqueViolation`).
--
-- ## Why the password hash is already derived by the time this row is written
--
-- Because the alternative is holding a plaintext password in a table until somebody types a code,
-- which is not a trade worth discussing. The derivation happens at step 1, on the account's own
-- `AuthGuardDO` instance at the full §38 work factor, before the row is written.
--
-- That does mean an unauthenticated caller triggers a 600,000-iteration PBKDF2. `/auth/login`
-- already does exactly this for an unknown email (it verifies against a constant dummy hash so the
-- two cases are indistinguishable by stopwatch, H3), and the same two things bound it: the cost
-- lands on the Durable Object's 30-second budget rather than the Worker's 10 ms, and a per-IP
-- throttle is charged *before* the derivation is reached (`signupThrottleGuard`).

CREATE TABLE counselor_signup_requests (
    -- One live signup per address, upserted — the same shape as `password_reset_tokens`, and for
    -- the same reason: starting a second signup invalidates the first, so there is never a
    -- question of which of two codes is the live one. Stored trimmed and lower-cased.
    email TEXT PRIMARY KEY NOT NULL,

    -- SHA-256 of the six-digit code, through the same `hashToken` the reset flow uses. The
    -- plaintext code exists in exactly two places: the email, and the request that verifies it.
    -- A readable code in this column would make a D1 read equivalent to reading the mailbox.
    code_hash TEXT NOT NULL,

    -- Derived at step 1 (see above). Written into `users.password` verbatim at verification.
    password_hash TEXT NOT NULL,

    -- The profile the counselor filled in, held until there is a user to attach it to. Same
    -- columns and same nullability as `counselor_profiles`, because that is where they land.
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    phone TEXT,
    employee_number TEXT,
    specialization TEXT,
    bio TEXT,

    -- The TTL is read from here at verification (15 minutes) rather than enforced by a job: an
    -- expired row that has not been swept yet must already be refused, or the sweep becomes a
    -- security control and its schedule becomes the real expiry. The nightly cleanup
    -- (src/jobs/cleanup.ts) deletes them afterwards so the table does not grow without bound.
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The sweep's predicate. Small table, but the cleanup job runs against production nightly and a
-- scan is a scan.
CREATE INDEX counselor_signup_requests_created_at_index
    ON counselor_signup_requests (created_at);

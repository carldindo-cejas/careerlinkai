-- Migration 0018 — The canonical program catalog (prompt-driven extension, 2026-07-27)
--
-- `programs.college_id` is NOT NULL: a `programs` row *is* "this program, at this college". That is
-- the right model for everything built so far — an admin edits UP Diliman's BSCS, a student is
-- recommended UP Diliman's BSCS — but it leaves one question unanswerable: **"which colleges offer
-- BS Computer Science?"** There is no join for it, because the two BSCS rows (UP Diliman's and
-- DLSU's) share nothing but a string.
--
-- This migration promotes that string to a row, for the same reason v1.1 promoted `colleges` out of
-- a text column on `programs` (§13.3): so a relationship can be a join instead of a string match. A
-- `program_catalog` entry is the *program as a thing in the world* — "BS Computer Science" — and
-- each `programs` row becomes an offering of it by one college.
--
-- ## Why not just match on the string at query time
--
-- Because it drifts, immediately and invisibly. 'BSCS' / 'BS-CS' / 'BS CS' are one program three
-- ways, and a query that matched normalized codes would silently split them the first time an admin
-- typed a hyphen — with no error, no warning, and a student shown two colleges where five offer it.
-- With a real FK the grouping is a decision someone made and can correct on
-- `/admin/canonical-programs`; with string matching it is a coincidence nobody owns.
--
-- ## The backfill groups on the normalized code, and that is a starting point rather than an answer
--
-- Every existing `programs` row is linked to a canonical entry derived from its own code, upper-cased
-- with spaces, hyphens and dots removed. The canonical `name` is the alphabetically first name in
-- the group, chosen only because it is deterministic — §26's reproducibility rule applies to
-- migrations too. Where that guess is wrong the admin page is the fix, which is precisely why this
-- ships with one.
--
-- Conventions as everywhere else (§12, §15): UUID v4 PKs, TEXT columns, ISO-8601 UTC timestamps,
-- every FK indexed, soft delete via `deleted_at`.

CREATE TABLE program_catalog (
    id          TEXT PRIMARY KEY NOT NULL,
    -- The canonical code ('BSCS'). Unique and case-insensitive: the whole point is that one code
    -- names one program, so a second row for the same code is the bug this table exists to prevent.
    code        TEXT NOT NULL,
    -- The canonical name ('BS Computer Science'), which is what a student is shown.
    name        TEXT NOT NULL,
    description TEXT,
    -- `active` / `archived`, matching CATALOG_STATUSES (§13.3). There is no `draft`: a canonical
    -- program is a fact about the world, not something an admin stages before offering it.
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at  TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at  TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    deleted_at  TEXT
);

CREATE UNIQUE INDEX program_catalog_code_unique ON program_catalog (code COLLATE NOCASE);
CREATE INDEX program_catalog_name_index         ON program_catalog (name COLLATE NOCASE);
CREATE INDEX program_catalog_status_index       ON program_catalog (status);

-- Nullable and `ON DELETE SET NULL`: retiring a canonical entry must not delete the college's
-- actual program offering, and a program entered before anyone has decided what it canonically is
-- must still be savable. "Which colleges offer this?" simply has no answer for an unlinked row,
-- which the UI states rather than hides.
ALTER TABLE programs ADD COLUMN program_catalog_id TEXT REFERENCES program_catalog (id) ON DELETE SET NULL;

CREATE INDEX programs_program_catalog_id_index ON programs (program_catalog_id);

-- --- Backfill ----------------------------------------------------------------------------------
--
-- One canonical row per distinct normalized code across every `programs` row — soft-deleted ones
-- included, so that every row in the table ends up linked and "unlinked" stays a meaningful state
-- reserved for rows created after this migration.
--
-- The id is a generated UUID v4 rather than a fixed one, because unlike the reference data in 0014
-- and 0017 these rows depend on what a given database happens to contain. The expression is the
-- standard SQLite construction: version nibble pinned to 4, variant nibble drawn from 8/9/a/b.

INSERT INTO program_catalog (id, code, name, description, status, created_at, updated_at)
SELECT
    lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6))),
    normalized_code,
    canonical_name,
    NULL,
    'active',
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM (
    SELECT
        REPLACE(REPLACE(REPLACE(UPPER(TRIM(code)), ' ', ''), '-', ''), '.', '') AS normalized_code,
        -- Deterministic, not "best": MIN over the names in the group. Where the group holds two
        -- genuinely different names, the admin page is where that gets resolved.
        MIN(name) AS canonical_name
    FROM programs
    WHERE TRIM(code) <> ''
    GROUP BY normalized_code
);

UPDATE programs
SET program_catalog_id = (
    SELECT pc.id
    FROM program_catalog pc
    WHERE pc.code = REPLACE(REPLACE(REPLACE(UPPER(TRIM(programs.code)), ' ', ''), '-', ''), '.', '')
)
WHERE TRIM(code) <> '';

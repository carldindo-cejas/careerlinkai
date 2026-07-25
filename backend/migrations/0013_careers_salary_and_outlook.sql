-- Migration 0013 — Careers: split salary into min/max, promote employment outlook to a table
-- (prompt-driven extension, 2026-07-25)
--
-- Two changes to how a career records its economics, both replacing free text with structured data:
--
-- 1. `salary_range` (one string like "PHP 40,000 - 120,000/mo") becomes `salary_min` + `salary_max`,
--    two integers holding raw monthly PHP amounts. The UI formats `40000` as `40,000` while typing;
--    the database keeps numbers it can actually compare and range. The Service enforces
--    `min < max` and positivity (§17) — SQLite could express a CHECK, but the rule lives with the
--    rest of the catalog's validation, and both columns are nullable (a career may list no salary).
--
-- 2. `employment_outlook` (free text) becomes `employment_outlook_id`, an FK into a new
--    `employment_outlooks` lookup, for the same reason colleges were promoted out of a text column
--    in v1.1: a dropdown backed by a table cannot drift the way typed prose does ("High demand" vs
--    "high demand" vs "strong").
--
-- The lookup is **seeded here, in the migration**, not in a seed file: it is fixed reference data
-- the dropdown must find even in a fresh test database (tests apply migrations, not seeds — §49).
-- No soft delete on it — there is nothing to retire. Ids are fixed UUIDs so seed 0002 can reference
-- them. Timestamps are ISO-8601 UTC (`strftime`), matching what the app writes (src/lib/datetime.ts).

CREATE TABLE employment_outlooks (
    id            TEXT PRIMARY KEY NOT NULL,
    name          TEXT NOT NULL,
    -- Display order for the dropdown: Low → Moderate → High → Emerging, not alphabetical.
    display_order INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at    TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- Case-insensitive uniqueness, so "High Demand" and "high demand" cannot both exist.
CREATE UNIQUE INDEX employment_outlooks_name_unique ON employment_outlooks (name COLLATE NOCASE);

INSERT INTO employment_outlooks (id, name, display_order, created_at, updated_at) VALUES
('e0000001-0000-4000-8000-000000000001', 'Low Demand',      1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('e0000002-0000-4000-8000-000000000002', 'Moderate Demand', 2, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('e0000003-0000-4000-8000-000000000003', 'High Demand',     3, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('e0000004-0000-4000-8000-000000000004', 'Emerging Field',  4, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- New career columns. Nullable, no defaults — an existing career simply has no salary/outlook on
-- file until an admin sets one.
ALTER TABLE careers ADD COLUMN salary_min INTEGER;
ALTER TABLE careers ADD COLUMN salary_max INTEGER;
ALTER TABLE careers ADD COLUMN employment_outlook_id TEXT REFERENCES employment_outlooks (id) ON DELETE SET NULL;

CREATE INDEX careers_employment_outlook_id_index ON careers (employment_outlook_id);

-- The columns being replaced. Dropped last, after their successors exist, so a reader of this file
-- sees the migration is a genuine replacement and not two unrelated edits. Neither column is part of
-- an index, so the drop is clean (SQLite 3.35+ / D1 support ALTER TABLE DROP COLUMN).
ALTER TABLE careers DROP COLUMN salary_range;
ALTER TABLE careers DROP COLUMN employment_outlook;

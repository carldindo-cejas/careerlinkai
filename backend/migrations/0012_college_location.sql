-- Migration 0012 — College school address + Google Maps link (prompt-driven extension, 2026-07-25)
--
-- Adds a normalized school address to `colleges`: four nullable FKs into the §0011 hierarchy
-- (Region → Province → Town → Barangay) plus a validated Google Maps URL. Free-text location was
-- never an option for the same reason `colleges` itself stopped being a text column in v1.1 (§13.3)
-- — a pasted "Q.C." and "Quezon City" are one place one row apart, and cascading dropdowns need real
-- ids to cascade on.
--
-- The four FKs are `ON DELETE SET NULL`, not CASCADE: deleting a place must not delete the college
-- sitting in it. Address rows are soft-deleted anyway (§0011), so in practice the reference stays
-- resolvable; SET NULL is the backstop for a genuine hard delete. Every FK is indexed (§12, §15).
--
-- SQLite permits `ADD COLUMN ... REFERENCES` only when the column defaults to NULL, which these all
-- do — an existing college has no known location until an admin sets one.

ALTER TABLE colleges ADD COLUMN region_id   TEXT REFERENCES regions   (id) ON DELETE SET NULL;
ALTER TABLE colleges ADD COLUMN province_id TEXT REFERENCES provinces (id) ON DELETE SET NULL;
ALTER TABLE colleges ADD COLUMN town_id     TEXT REFERENCES towns     (id) ON DELETE SET NULL;
ALTER TABLE colleges ADD COLUMN barangay_id TEXT REFERENCES barangays (id) ON DELETE SET NULL;

-- A validated Google Maps URL for the campus. Nullable — the details page shows "No map available"
-- when absent. The validation (that it is actually a Google Maps link) is a Service rule, not a
-- CHECK: SQLite cannot parse a URL, and the rule belongs with the rest of §17's validation anyway.
ALTER TABLE colleges ADD COLUMN map_link TEXT;

CREATE INDEX colleges_region_id_index   ON colleges (region_id);
CREATE INDEX colleges_province_id_index ON colleges (province_id);
CREATE INDEX colleges_town_id_index     ON colleges (town_id);
CREATE INDEX colleges_barangay_id_index ON colleges (barangay_id);

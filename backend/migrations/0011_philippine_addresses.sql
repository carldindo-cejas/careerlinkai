-- Migration 0011 — Philippine Address Management (prompt-driven extension, 2026-07-25)
--
-- A normalized address hierarchy — Region → Province → Town/Municipality → Barangay — that will
-- power cascading dropdowns across the system (a student's home address, a school's location).
--
-- Not in FULLPLAN's original 28-table plan: added under the v1.5 Decision Rule (a user prompt may
-- extend the schema when it improves the system, provided it keeps the house conventions). It keeps
-- all of them: UUID v4 PKs, every FK indexed (§12, §15), soft deletes on business entities (§12),
-- TEXT columns throughout, ISO-8601 timestamps.
--
-- **One deliberate improvement on the catalog pattern (0004).** The catalog tables carry only a
-- plain index on their unique-ish columns and enforce uniqueness with a Service pre-check alone,
-- precisely because a soft-deleted row keeps its name forever and a full UNIQUE index would let one
-- deleted "Manila" permanently block the real one. A **partial** unique index — `WHERE deleted_at IS
-- NULL` — has neither problem: it enforces "no two *live* siblings share a name" at the database,
-- while a soft-deleted duplicate sits harmlessly outside the index. `COLLATE NOCASE` makes it the
-- case-insensitive rule the Service checks ("Manila" == "manila"), so the index is the real
-- guarantee and the Service pre-check exists only to turn the loser of a race into a friendly skip
-- rather than a 500 (the same isUniqueViolation translation used across the codebase).
--
-- `code` is the optional PSGC (Philippine Standard Geographic Code) — nullable, plain-indexed for
-- lookup, never unique (it is frequently absent from a pasted list, and NULLs are not comparable).

CREATE TABLE regions (
    id         TEXT PRIMARY KEY NOT NULL,
    -- Optional PSGC region code, e.g. "13" (NCR). Nullable: a bulk paste is usually names only.
    code       TEXT,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    deleted_at TEXT
);

-- The uniqueness guarantee, scoped to live rows and case-insensitive: two live regions cannot share
-- a name, but soft-deleting one frees the name for re-use. See the header for why this is a partial
-- index rather than the catalog's plain-index-plus-pre-check.
CREATE UNIQUE INDEX regions_name_live_unique ON regions (name COLLATE NOCASE) WHERE deleted_at IS NULL;
CREATE INDEX regions_name_index ON regions (name);
CREATE INDEX regions_code_index ON regions (code);

CREATE TABLE provinces (
    id         TEXT PRIMARY KEY NOT NULL,
    -- Parent from the route, never the body — a province cannot be moved between regions (0004's
    -- rule for programs, for the same reason: it would silently re-parent everything beneath it).
    region_id  TEXT NOT NULL REFERENCES regions (id) ON DELETE CASCADE,
    code       TEXT,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    deleted_at TEXT
);

-- Uniqueness is scoped to the parent: two regions may each legitimately contain a differently-placed
-- name, so the live-unique rule is (region_id, name), not name alone.
CREATE UNIQUE INDEX provinces_region_name_live_unique
    ON provinces (region_id, name COLLATE NOCASE) WHERE deleted_at IS NULL;
CREATE INDEX provinces_region_id_index ON provinces (region_id);
CREATE INDEX provinces_name_index ON provinces (name);
CREATE INDEX provinces_code_index ON provinces (code);

CREATE TABLE towns (
    id          TEXT PRIMARY KEY NOT NULL,
    province_id TEXT NOT NULL REFERENCES provinces (id) ON DELETE CASCADE,
    code        TEXT,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at  TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    deleted_at  TEXT
);

CREATE UNIQUE INDEX towns_province_name_live_unique
    ON towns (province_id, name COLLATE NOCASE) WHERE deleted_at IS NULL;
CREATE INDEX towns_province_id_index ON towns (province_id);
CREATE INDEX towns_name_index ON towns (name);
CREATE INDEX towns_code_index ON towns (code);

CREATE TABLE barangays (
    id         TEXT PRIMARY KEY NOT NULL,
    town_id    TEXT NOT NULL REFERENCES towns (id) ON DELETE CASCADE,
    code       TEXT,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    deleted_at TEXT
);

CREATE UNIQUE INDEX barangays_town_name_live_unique
    ON barangays (town_id, name COLLATE NOCASE) WHERE deleted_at IS NULL;
CREATE INDEX barangays_town_id_index ON barangays (town_id);
CREATE INDEX barangays_name_index ON barangays (name);
CREATE INDEX barangays_code_index ON barangays (code);

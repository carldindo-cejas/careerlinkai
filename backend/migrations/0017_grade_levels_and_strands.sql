-- Migration 0017 — Grade level & SHS strand as lookups, derived from the class
-- (prompt-driven extension, 2026-07-27)
--
-- Two things happen here, and the second is the reason for the first.
--
--   1. `student_profiles.grade_level` (free text) and `student_profiles.strand` (a TEXT+CHECK
--      enum) are replaced as *inputs* by FKs into two new lookups, `grade_levels` and
--      `shs_strands`.
--   2. `classes` gains the same two FKs, because a student's grade level and strand are now
--      **derived from the class the counselor enrolled them in** rather than typed by the student.
--
-- ## Why the old text columns survive, and why that is not the drift this project keeps warning about
--
-- `student_profiles.strand` is read by §27 (`strandAlignment`) and compared directly against
-- `programs.recommended_strand`, which is still a TEXT enum. Rather than rewrite the matching
-- engine — the one file in this system with a hand-computed worked example (§28) that a defence
-- panel checks — the text columns stay as a **derived mirror** of the FK.
--
-- The usual objection to a denormalized copy is that two writable representations drift. That
-- cannot happen here, because after this migration there is exactly **one writer**:
-- `StudentProfileService` writes `shs_strand_id` and copies `shs_strands.name` into `strand` in
-- the same statement, and nothing else may touch either (the Zod schema no longer accepts a raw
-- strand string from a student at all). The mirror is a materialized join, not a second opinion.
--
-- ## Why `shs_strands` holds the two *track* values and not the seven strands a student would name
--
-- Ratified during implementation. §13.1 collapsed strand to a strict two-value enum in v1.2 and
-- §27 is built on exactly two branches; `programs.recommended_strand` carries the same two values.
-- Seeding STEM/ABM/HUMSS/GAS/TVL/Sports/Arts here would offer a student a distinction the engine
-- cannot act on — which the profile screen's own comment already calls "a lie about what the engine
-- can tell apart". The lookup is therefore a faithful normalization of what exists, and `code` is
-- the extension point: adding the seven strands later is seven INSERTs plus a `track` column, not a
-- migration of every profile row.
--
-- `name` is deliberately **identical to the existing enum strings** ('Academic',
-- 'Technical-Professional'). That is what makes the mirror a copy rather than a translation, and
-- what lets the backfill below be a plain join.
--
-- ## Grade levels
--
-- Seeded with Grade 11 and Grade 12 only — the exact two options the profile screen has always
-- offered, and the only two that can carry an SHS strand at all. `classes.grade_level` free text
-- that says anything else backfills to NULL and the counselor re-picks it; that is a visible,
-- correctable gap rather than an invented row.
--
-- Conventions as everywhere else (§12, §15): UUID v4 PKs, TEXT columns, ISO-8601 UTC timestamps,
-- every FK indexed, reference rows in the migration rather than in `seeds/` (D26 — validation and
-- the derivation both read these, so an environment without them would be broken, not merely bare).

-- --- The lookups -------------------------------------------------------------------------------

CREATE TABLE grade_levels (
    id           TEXT PRIMARY KEY NOT NULL,
    -- The stable machine handle the backfill and the tests resolve by.
    code         TEXT NOT NULL,
    -- What a counselor and a student read. Unique so two "Grade 11" rows cannot both exist.
    name         TEXT NOT NULL,
    order_number INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at   TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX grade_levels_code_unique ON grade_levels (code);
CREATE UNIQUE INDEX grade_levels_name_unique ON grade_levels (name COLLATE NOCASE);
CREATE INDEX grade_levels_order_number_index ON grade_levels (order_number);

CREATE TABLE shs_strands (
    id           TEXT PRIMARY KEY NOT NULL,
    code         TEXT NOT NULL,
    /**
     * Must stay byte-identical to the §13.1 enum values — `students_profiles.strand`,
     * `programs.recommended_strand` and §27's comparison all read these strings.
     */
    name         TEXT NOT NULL,
    -- The tracks this strand covers, shown as the option's helper text on the profile screen.
    description  TEXT,
    order_number INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at   TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX shs_strands_code_unique ON shs_strands (code);
CREATE UNIQUE INDEX shs_strands_name_unique ON shs_strands (name COLLATE NOCASE);
CREATE INDEX shs_strands_order_number_index ON shs_strands (order_number);

-- --- The reference rows ------------------------------------------------------------------------
--
-- Fixed UUIDs and INSERT OR IGNORE, so re-running is a no-op and code/tests/seeds may refer to a
-- row by a stable id.

INSERT OR IGNORE INTO grade_levels (id, code, name, order_number, created_at, updated_at) VALUES
('91000001-0000-4000-8000-000000000001', 'GRADE_11', 'Grade 11', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('91000002-0000-4000-8000-000000000002', 'GRADE_12', 'Grade 12', 2, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT OR IGNORE INTO shs_strands (id, code, name, description, order_number, created_at, updated_at) VALUES
('92000001-0000-4000-8000-000000000001', 'ACADEMIC',               'Academic',               'STEM, HUMSS, ABM, GAS',        1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('92000002-0000-4000-8000-000000000002', 'TECHNICAL_PROFESSIONAL', 'Technical-Professional', 'TVL, Sports, Arts & Design',   2, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- --- The foreign keys --------------------------------------------------------------------------
--
-- `ON DELETE SET NULL` throughout, matching migration 0012's reasoning: retiring a lookup row must
-- not delete the student or the class that referenced it. SQLite permits `ADD COLUMN … REFERENCES`
-- only when the column defaults to NULL, which all four do.

ALTER TABLE student_profiles ADD COLUMN grade_level_id TEXT REFERENCES grade_levels (id) ON DELETE SET NULL;
ALTER TABLE student_profiles ADD COLUMN shs_strand_id  TEXT REFERENCES shs_strands  (id) ON DELETE SET NULL;

-- On `classes` these are the **source** of the two above, not a copy of them: the counselor sets
-- them once per class and every enrolled student derives from them.
ALTER TABLE classes ADD COLUMN grade_level_id TEXT REFERENCES grade_levels (id) ON DELETE SET NULL;
ALTER TABLE classes ADD COLUMN shs_strand_id  TEXT REFERENCES shs_strands  (id) ON DELETE SET NULL;

CREATE INDEX student_profiles_grade_level_id_index ON student_profiles (grade_level_id);
CREATE INDEX student_profiles_shs_strand_id_index  ON student_profiles (shs_strand_id);
CREATE INDEX classes_grade_level_id_index          ON classes (grade_level_id);
CREATE INDEX classes_shs_strand_id_index           ON classes (shs_strand_id);

-- --- Backfill ----------------------------------------------------------------------------------
--
-- Matched on `name`, case-insensitively and with surrounding whitespace trimmed, because the old
-- columns were free text on the class side and a curated dropdown on the profile side. A value that
-- matches nothing stays NULL — an honest gap the counselor can fill, not a guess written into a
-- column that §27 reads.
--
-- Note the direction: this backfills from what each row *already said about itself*. It deliberately
-- does not push the class's value onto its students, because at this point no class has one yet —
-- `classes.shs_strand_id` is NULL for every existing row and the counselor must set it. The
-- derivation from class to student is application code (`StudentProfileService.syncFromClass`), and
-- it runs on enrollment and on class edit from here on.

UPDATE student_profiles
SET grade_level_id = (
    SELECT gl.id FROM grade_levels gl
    WHERE gl.name = TRIM(student_profiles.grade_level) COLLATE NOCASE
)
WHERE grade_level IS NOT NULL AND TRIM(grade_level) <> '';

UPDATE student_profiles
SET shs_strand_id = (
    SELECT s.id FROM shs_strands s
    WHERE s.name = TRIM(student_profiles.strand) COLLATE NOCASE
)
WHERE strand IS NOT NULL AND TRIM(strand) <> '';

UPDATE classes
SET grade_level_id = (
    SELECT gl.id FROM grade_levels gl
    WHERE gl.name = TRIM(classes.grade_level) COLLATE NOCASE
)
WHERE grade_level IS NOT NULL AND TRIM(grade_level) <> '';

-- Re-normalize the mirror on the profile side: a row whose free text was "grade 11" now carries the
-- FK, so the text must read exactly "Grade 11" to stay a faithful copy of `grade_levels.name`.
-- Rows that matched nothing are left exactly as they were — the text is all the information there
-- is about them, and blanking it would destroy it.
UPDATE student_profiles
SET grade_level = (SELECT gl.name FROM grade_levels gl WHERE gl.id = student_profiles.grade_level_id)
WHERE grade_level_id IS NOT NULL;

UPDATE student_profiles
SET strand = (SELECT s.name FROM shs_strands s WHERE s.id = student_profiles.shs_strand_id)
WHERE shs_strand_id IS NOT NULL;

UPDATE classes
SET grade_level = (SELECT gl.name FROM grade_levels gl WHERE gl.id = classes.grade_level_id)
WHERE grade_level_id IS NOT NULL;

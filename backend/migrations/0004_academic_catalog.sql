-- Migration 0004 — Academic Catalog (FULLPLAN §13.3)
--
-- Standards as in 0001–0003: UUID v4 PKs, TEXT + CHECK enums, every FK indexed (§12, §15).
--
-- This is the module Phase 4 reads. Two columns here are inputs to the recommendation engine
-- rather than display fields — `programs.recommended_strand` and `careers.typical_riasec_code`
-- — so their CHECK constraints are written now, while the table is empty and the constraint is
-- free, rather than after Part VII's formulas are already reading them.

CREATE TABLE colleges (
    id          TEXT PRIMARY KEY NOT NULL,
    name        TEXT NOT NULL,
    description TEXT,
    -- Two states, not three: a college has no meaningful "entered but not yet offered"
    -- state, so `draft` is a *program* status and is deliberately not valid here.
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at  TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at  TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    deleted_at  TEXT
);

-- Deliberately **not** a UNIQUE index on `name`, even though the name is unique among live
-- colleges (§20). Colleges are soft-deleted (§12), so a deleted row keeps its name forever,
-- and a DB-level index would let one deleted "University of Santo Tomas" permanently block
-- anyone from ever adding the real one. The uniqueness check scopes itself to live rows in
-- the Service instead. The same reasoning applies to `programs.code` and `careers.title`.
CREATE INDEX colleges_status_index ON colleges (status);
CREATE INDEX colleges_name_index ON colleges (name);

CREATE TABLE programs (
    id                 TEXT PRIMARY KEY NOT NULL,
    -- The parent always comes from the route, never from the body: a program cannot be moved
    -- between institutions, because doing so would silently rewrite the college that §27
    -- derives for every recommendation already pointing at it.
    college_id         TEXT NOT NULL REFERENCES colleges (id) ON DELETE CASCADE,
    code               TEXT NOT NULL,
    name               TEXT NOT NULL,
    -- Still denormalized text — departments remain deferred (§63).
    department_name    TEXT,
    description        TEXT,
    -- NULL is a third, *distinct* state meaning "no strand requirement", which §27 scores as
    -- a full 100 — it is a claim, not a missing value.
    recommended_strand TEXT CHECK (recommended_strand IN ('Academic', 'Technical-Professional')),
    -- Three states here, unlike colleges and careers: `draft` is a program the admin has
    -- entered but is not offering, and §27 ranks only `active` ones.
    status             TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('draft', 'active', 'archived')),
    created_at         TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at         TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    deleted_at         TEXT
);

CREATE INDEX programs_college_id_index ON programs (college_id);
CREATE INDEX programs_status_index ON programs (status);
-- Not unique: `code` is unique *within a live college* (BSCS at UP and BSCS at DLSU are
-- different programs that legitimately share a code), and soft deletes rule out the index.
CREATE INDEX programs_college_code_index ON programs (college_id, code);

CREATE TABLE careers (
    id                  TEXT PRIMARY KEY NOT NULL,
    title               TEXT NOT NULL,
    description         TEXT,
    -- Free text by design, e.g. "PHP 30,000 - 80,000/mo" (§13.3).
    salary_range        TEXT,
    employment_outlook  TEXT,
    -- A Holland code, e.g. "IEC": up to three distinct RIASEC letters, most dominant first.
    -- §27 reads it *positionally* against the student's profile, weighting [0.5, 0.3, 0.2],
    -- so order is data, not formatting. NULL is valid — the career is in the catalog but
    -- cannot be RIASEC-matched. The letter/length/repeat rules live in `lib/holland.ts`,
    -- because a CHECK cannot express "no repeated letter"; the column keeps §13.3's width.
    typical_riasec_code TEXT,
    status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at          TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at          TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    deleted_at          TEXT
);

CREATE INDEX careers_status_index ON careers (status);
CREATE INDEX careers_title_index ON careers (title);

-- The mapping is an **input to the recommendation engine**, not a display list: §27 averages
-- `riasec_compatibility` over every career linked to a program to produce that program's
-- RIASEC component, and an unmapped program falls back to a neutral 50. So a duplicate link
-- is not untidy bookkeeping — it is a career voting twice and quietly bending the score.
--
-- No `created_at` / `updated_at`, per §13.3, which specifies exactly three columns. Unlike
-- `class_students` — an enrollment a real student lived through — this row records no event;
-- it is a set membership, and it is hard-deleted when unlinked.
CREATE TABLE program_careers (
    id         TEXT PRIMARY KEY NOT NULL,
    program_id TEXT NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
    career_id  TEXT NOT NULL REFERENCES careers (id) ON DELETE CASCADE
);

-- **This** is the guarantee, not the Service's pre-check. The pre-check exists only to produce
-- a sentence an admin can read; check-then-insert is a race, and without this index the loser
-- of that race would surface as a 500 rather than the 422 it is meant to be.
CREATE UNIQUE INDEX program_careers_program_career_unique ON program_careers (program_id, career_id);
CREATE INDEX program_careers_program_id_index ON program_careers (program_id);
CREATE INDEX program_careers_career_id_index ON program_careers (career_id);

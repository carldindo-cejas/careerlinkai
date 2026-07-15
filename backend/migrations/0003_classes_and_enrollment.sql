-- Migration 0003 — Class & Enrollment (FULLPLAN §13.2)
--
-- Standards as in 0001: UUID v4 PKs, TEXT + CHECK enums, every FK indexed (§12, §15).

CREATE TABLE classes (
    id                   TEXT PRIMARY KEY NOT NULL,
    counselor_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name                 TEXT NOT NULL,
    academic_year        TEXT NOT NULL,
    grade_level          TEXT,
    -- Generated at class creation, before any roster exists (§13.2, §57), and never accepted
    -- as client input: a client that could choose its own code could choose a guessable one.
    join_code            TEXT NOT NULL,
    -- The code is the entire security boundary for student access (§38), so it expires by
    -- default rather than living forever. Counselor can regenerate at any time.
    join_code_expires_at TEXT,
    -- New classes default to `active` (ratified v1.2). A non-`active` class refuses joins.
    status               TEXT NOT NULL DEFAULT 'active'
                              CHECK (status IN ('draft', 'active', 'archived')),
    created_at           TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at           TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    deleted_at           TEXT
);

CREATE UNIQUE INDEX classes_join_code_unique ON classes (join_code);
CREATE INDEX classes_counselor_id_index ON classes (counselor_id);
CREATE INDEX classes_status_index ON classes (status);

-- This table doubles as enrollment history and as the student's class-scoped login identity.
--
-- Deliberately has **no `created_at` / `updated_at`** — `joined_at` / `removed_at` are its
-- lifecycle timestamps. This is the one sanctioned exception to the §12 timestamp rule
-- (ratified v1.2); do not "fix" it by adding them.
CREATE TABLE class_students (
    id          TEXT PRIMARY KEY NOT NULL,
    class_id    TEXT NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
    student_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- The per-class login handle. Unique per (class_id, username), **not globally** — the
    -- class code already disambiguates identity, so two classes may reuse a username freely.
    username    TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
    joined_at   TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    removed_at  TEXT
);

-- Both uniques cover every row regardless of `status`: a removed student's username stays
-- reserved in that class. That is intentional — recycling a departed student's handle would
-- point the class's own history at the wrong person.
CREATE UNIQUE INDEX class_students_class_student_unique ON class_students (class_id, student_id);
CREATE UNIQUE INDEX class_students_class_username_unique ON class_students (class_id, username);
CREATE INDEX class_students_student_id_index ON class_students (student_id);

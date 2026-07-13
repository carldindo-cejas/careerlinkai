-- Migration 0001 — Identity & Access (FULLPLAN §13.1)
--
-- Standards applied throughout (§12):
--   * UUID v4 primary keys, never auto-increment integers.
--   * Enums are TEXT + CHECK — D1/SQLite has no native ENUM type.
--   * Every foreign key is indexed (§15, hard rule).
--   * Soft deletes on `users` (a business entity an admin can remove).
--   * Timestamps are ISO-8601 UTC strings, so SQLite string comparison is chronological.

CREATE TABLE users (
    id                   TEXT PRIMARY KEY NOT NULL,
    name                 TEXT NOT NULL,
    -- Nullable and unique-when-present: students routinely have no email, and SQLite
    -- allows multiple NULLs in a UNIQUE index, which is exactly the semantics §13.1 wants.
    email                TEXT,
    -- PBKDF2-SHA256 (§38), `pbkdf2$iterations$salt$hash`. NULL forever for students —
    -- passwordless by design, not by omission.
    password             TEXT,
    role                 TEXT NOT NULL CHECK (role IN ('admin', 'counselor', 'student')),
    status               TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'active', 'inactive', 'suspended')),
    must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
    email_verified_at    TEXT,
    last_login_at        TEXT,
    created_at           TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at           TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    deleted_at           TEXT
);

CREATE UNIQUE INDEX users_email_unique ON users (email);
CREATE INDEX users_role_index ON users (role);
CREATE INDEX users_status_index ON users (status);

CREATE TABLE counselor_profiles (
    id              TEXT PRIMARY KEY NOT NULL,
    user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    first_name      TEXT NOT NULL,
    last_name       TEXT NOT NULL,
    phone           TEXT,
    employee_number TEXT,
    specialization  TEXT,
    bio             TEXT,
    created_at      TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at      TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX counselor_profiles_user_id_unique ON counselor_profiles (user_id);

CREATE TABLE student_profiles (
    id               TEXT PRIMARY KEY NOT NULL,
    user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    first_name       TEXT NOT NULL,
    -- Nullable (v1.2): a mononym is a legitimate name, not a validation error (§16).
    last_name        TEXT,
    birthdate        TEXT,
    gender           TEXT,
    grade_level      TEXT,
    strand           TEXT CHECK (strand IN ('Academic', 'Technical-Professional')),
    gwa              REAL,
    math_grade       REAL,
    science_grade    REAL,
    english_grade    REAL,
    guardian_name    TEXT,
    guardian_contact TEXT,
    created_at       TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at       TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX student_profiles_user_id_unique ON student_profiles (user_id);

-- Infrastructure tables (§13.1) — not part of the 28-table domain count.

-- The first-party replacement for Sanctum (§38). Only the SHA-256 hash of the opaque
-- bearer token is stored; the plaintext is returned once, at issue time, and never again.
-- Used identically by staff login and passwordless student join.
CREATE TABLE api_tokens (
    id           TEXT PRIMARY KEY NOT NULL,
    user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL,
    expires_at   TEXT,
    last_used_at TEXT,
    created_at   TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX api_tokens_token_hash_unique ON api_tokens (token_hash);
CREATE INDEX api_tokens_user_id_index ON api_tokens (user_id);

-- Staff-only in practice: students have no password to reset.
CREATE TABLE password_reset_tokens (
    email      TEXT PRIMARY KEY NOT NULL,
    token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

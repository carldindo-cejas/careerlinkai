-- Migration 0005 — Assessment module (FULLPLAN §13.4)
--
-- Standards as in 0001–0004: UUID v4 PKs, TEXT + CHECK enums, every FK indexed (§12, §15).
--
-- This module is where the plan's integrity rules stop being advice and become structure. Three
-- of them cannot be expressed as a constraint here and live in `AssessmentBuilderService`
-- instead — they are named at their table so that nobody reads the absence of a CHECK as the
-- absence of a rule:
--
--   1. **A PUBLISHED version is frozen** — it and every question, option and mapping beneath it.
--      SQLite cannot express "no UPDATE when a parent column has a given value".
--   2. **Dimensions freeze once ANY version of their template publishes.** They hang off the
--      *template*, so rule 1 does not reach them (§12, v1.2).
--   3. **The confirmation gate** — no version publishes while any of its `question_dimensions`
--      has `confirmed_at IS NULL` (§25). This is a cross-row aggregate; a CHECK sees one row.
--
-- Decimals are REAL, as in 0001 (`student_profiles.gwa`). They are serialized to strings at the
-- API boundary, which is what the frontend's types already expect.

-- A *template* is the instrument ("RIASEC"); a *version* is what anyone actually takes. Nothing
-- downstream ever points at a template — see `assessment_assignments`.
CREATE TABLE assessment_templates (
    id          TEXT PRIMARY KEY NOT NULL,
    creator_id  TEXT NOT NULL REFERENCES users (id),
    -- RIASEC and SCCT are **permanently excluded from AI-assisted creation and editing** (§5) —
    -- a rule enforced at the API layer, as the *first* check in `policies/assessment.ts`, not
    -- merely hidden in the UI. This column is what that check reads.
    category    TEXT NOT NULL CHECK (category IN ('RIASEC', 'SCCT', 'CUSTOM')),
    title       TEXT NOT NULL,
    description TEXT,
    -- v1 ships GLOBAL instruments plus counselor-private CUSTOM ones. (`COUNSELOR_PRIVATE`
    -- knowledge *documents* are the thing deferred to v2 — §63 — not private templates.)
    ownership   TEXT NOT NULL DEFAULT 'GLOBAL'
                     CHECK (ownership IN ('GLOBAL', 'COUNSELOR_PRIVATE')),
    status      TEXT NOT NULL DEFAULT 'DRAFT'
                     CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
    created_at  TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at  TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    deleted_at  TEXT
);

CREATE INDEX assessment_templates_creator_id_index ON assessment_templates (creator_id);
CREATE INDEX assessment_templates_category_index ON assessment_templates (category);
CREATE INDEX assessment_templates_status_index ON assessment_templates (status);

CREATE TABLE assessment_versions (
    id                     TEXT PRIMARY KEY NOT NULL,
    assessment_template_id TEXT NOT NULL REFERENCES assessment_templates (id) ON DELETE CASCADE,
    version_number         INTEGER NOT NULL,
    instructions           TEXT,
    duration_minutes       INTEGER,
    -- JSON (§12 permits it for formula/config data, never for business fields):
    -- `{"algorithm": "HOLLAND_CODE_TOP3" | "WEIGHTED_COMPOSITE", "composite_weights": {...}}`.
    -- §24 is one engine with two configurations, so a third instrument is added by writing data
    -- here, never by writing new scoring code.
    scoring_config         TEXT NOT NULL DEFAULT '{}',
    status                 TEXT NOT NULL DEFAULT 'DRAFT'
                                CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
    created_by             TEXT NOT NULL REFERENCES users (id),
    created_at             TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- §13.4. Version numbers start at 1 and increment per template; a race that produced two v2s
-- for one template would make "the latest version" ambiguous, and the loser surfaces as a
-- constraint error rather than as a duplicate.
CREATE UNIQUE INDEX assessment_versions_template_number_unique
    ON assessment_versions (assessment_template_id, version_number);
CREATE INDEX assessment_versions_template_id_index ON assessment_versions (assessment_template_id);
CREATE INDEX assessment_versions_status_index ON assessment_versions (status);
CREATE INDEX assessment_versions_created_by_index ON assessment_versions (created_by);

CREATE TABLE assessment_dimensions (
    id                     TEXT PRIMARY KEY NOT NULL,
    -- Template-scoped, **not** version-scoped. This is exactly why the freeze rule (§12, v1.2)
    -- has to exist separately from version immutability: `question_dimensions`, `dimension_scores`
    -- and the Holland-code derivation all hang off these rows, and version immutability alone
    -- would leave them editable after students had already been scored against them.
    assessment_template_id TEXT NOT NULL REFERENCES assessment_templates (id) ON DELETE CASCADE,
    code                   TEXT NOT NULL,
    name                   TEXT NOT NULL,
    description            TEXT,
    -- JSON bands, e.g. `[{"min":0,"max":33.99,"label":"Low Interest"}, ...]` (§22). Sliding a
    -- band from 67 to 60 would silently rewrite the label on results already delivered — which
    -- is what the freeze rule prevents.
    interpretation_ranges  TEXT,
    -- **Scoring data, not a display preference.** §22 breaks Holland Code ties on the canonical
    -- order R > I > A > S > E > C, and §24's engine is generic — it tie-breaks on
    -- `dimensions.canonical_order`, whatever the instrument. Without this column a student with
    -- I = A = 71.0 would get whichever row the database happened to return first, and their
    -- Holland Code would be a fact about row ordering rather than about them.
    --
    -- (§13.4's column list omits this; `docs/api/phase-3-assessment-engine.md` specifies it and
    -- states why. FULLPLAN is silent here rather than contradictory, so the contract doc fills
    -- the gap — recorded as a deviation in PROGRESS.md.)
    order_number           INTEGER NOT NULL DEFAULT 1,
    created_at             TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- A dimension code is the instrument's alphabet ("I", "SE"): two rows sharing one code within a
-- template would make `dimension_scores` ambiguous about what was actually measured.
CREATE UNIQUE INDEX assessment_dimensions_template_code_unique
    ON assessment_dimensions (assessment_template_id, code);
CREATE INDEX assessment_dimensions_template_id_index
    ON assessment_dimensions (assessment_template_id);

CREATE TABLE assessment_questions (
    id                    TEXT PRIMARY KEY NOT NULL,
    assessment_version_id TEXT NOT NULL REFERENCES assessment_versions (id) ON DELETE CASCADE,
    question_text         TEXT NOT NULL,
    question_type         TEXT NOT NULL
                               CHECK (question_type IN ('LIKERT', 'MULTIPLE_CHOICE', 'BOOLEAN')),
    -- An optional grouping heading ("Investigative") — replaces a full sections table in v1. It
    -- is sent to the player, deliberately: it chunks sixty items into legible sections without
    -- revealing what any single item scores.
    section_label         TEXT,
    order_number          INTEGER NOT NULL,
    -- Submission is blocked while any REQUIRED question is unanswered, which is what makes §24's
    -- prorating rule safe. Prorating is right for an optional question and catastrophic for a
    -- required one: without the block a student could answer one Investigative item with a 5,
    -- skip the other 59, and walk out with a perfect and entirely meaningless `I`.
    required              INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
    -- Provenance (§13.4, v1.1). RIASEC/SCCT questions are MANUAL by construction.
    source                TEXT NOT NULL DEFAULT 'MANUAL'
                               CHECK (source IN ('MANUAL', 'AI_GENERATED')),
    -- FK → ai_requests.id, but **the constraint is deliberately not declared**: `ai_requests` is
    -- a Phase 5a table and does not exist yet. Declaring a REFERENCES against a missing table
    -- would make every insert here fail the moment foreign keys are enforced. The column exists
    -- now because §13.4 puts it here and because backfilling provenance after the fact is how
    -- provenance stops being trustworthy; the REFERENCES clause is added with that table.
    source_ai_request_id  TEXT,
    created_at            TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX assessment_questions_version_id_index
    ON assessment_questions (assessment_version_id);
-- The player reads questions in order, for one version, on every page load.
CREATE INDEX assessment_questions_version_order_index
    ON assessment_questions (assessment_version_id, order_number);

CREATE TABLE question_options (
    id           TEXT PRIMARY KEY NOT NULL,
    question_id  TEXT NOT NULL REFERENCES assessment_questions (id) ON DELETE CASCADE,
    label        TEXT NOT NULL,
    value        TEXT NOT NULL,
    -- **Never sent to the player** (§37, and a frontend test pins it). A student who can see
    -- that "Strongly Agree" is worth 5 stops answering an interest inventory and starts
    -- answering the Holland Code they would like to have.
    score        REAL NOT NULL,
    order_number INTEGER NOT NULL
);

CREATE INDEX question_options_question_id_index ON question_options (question_id);

-- **The confirmation gate lives on this table** (§25). The risk AI poses is not writing awkward
-- question text — that is a UX problem. It is silently deciding *what a question measures and
-- how strongly*, because that decision is invisible in the finished product: the student sees a
-- normal Likert item and a normal result, with no sign that the thing connecting them was never
-- read by a human. `confirmed_at` is what makes that reviewable, and publish is what enforces it.
CREATE TABLE question_dimensions (
    id           TEXT PRIMARY KEY NOT NULL,
    question_id  TEXT NOT NULL REFERENCES assessment_questions (id) ON DELETE CASCADE,
    dimension_id TEXT NOT NULL REFERENCES assessment_dimensions (id) ON DELETE CASCADE,
    -- Supports a question loading onto more than one dimension (§13.4). RIASEC/SCCT use 1.00.
    weight       REAL NOT NULL DEFAULT 1.0,
    -- NULL = unconfirmed, which is only reachable for an AI-proposed mapping. A human typing a
    -- mapping in the builder gets it set at insert time — there is nothing to review later.
    confirmed_at TEXT,
    confirmed_by TEXT REFERENCES users (id)
);

-- One mapping per (question, dimension): a duplicate row would weight that dimension twice and
-- quietly double the item's contribution — the same class of bug as a duplicate program_career.
CREATE UNIQUE INDEX question_dimensions_question_dimension_unique
    ON question_dimensions (question_id, dimension_id);
CREATE INDEX question_dimensions_question_id_index ON question_dimensions (question_id);
CREATE INDEX question_dimensions_dimension_id_index ON question_dimensions (dimension_id);
-- The publish gate's query: "does this version have any unconfirmed mapping?" It runs on every
-- publish and on every publish-readiness poll.
CREATE INDEX question_dimensions_confirmed_at_index ON question_dimensions (confirmed_at);

CREATE TABLE assessment_assignments (
    id                    TEXT PRIMARY KEY NOT NULL,
    -- **A version, never a template** (§13.4). It must be PUBLISHED: a DRAFT is still being
    -- edited, and students answering questions that move underneath them is the exact failure
    -- version immutability exists to prevent. Assigning a draft is a 422, not a 403 — the
    -- counselor is allowed to do this, the version simply is not ready.
    assessment_version_id TEXT NOT NULL REFERENCES assessment_versions (id),
    class_id              TEXT NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
    assigned_by           TEXT NOT NULL REFERENCES users (id),
    deadline              TEXT,
    status                TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLOSED')),
    created_at            TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX assessment_assignments_version_id_index
    ON assessment_assignments (assessment_version_id);
CREATE INDEX assessment_assignments_class_id_index ON assessment_assignments (class_id);
CREATE INDEX assessment_assignments_status_index ON assessment_assignments (status);
CREATE INDEX assessment_assignments_assigned_by_index ON assessment_assignments (assigned_by);

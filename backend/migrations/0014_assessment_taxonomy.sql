-- Migration 0014 — Assessment taxonomy: type, scoring, and the compatibility matrix between them
-- (prompt-driven extension, 2026-07-26)
--
-- Three normalized lookups replace what would otherwise be free text on an assessment:
--
--   * `assessment_types`        — what kind of instrument this is (Aptitude, Personality, …).
--   * `assessment_scorings`     — how it is scored (Likert Scales, T-Scores, IQ Scores, …).
--   * `assessment_type_scorings`— **which scorings are meaningful for which type.**
--
-- The third table is the one that earns its keep. "Only compatible scoring methods may be selected"
-- is a *rule about data*, and the two ways to write it are a hard-coded map in TypeScript or a row
-- per legal pair. A hard-coded map would put the rule in exactly one runtime, leaving the database
-- unable to answer "is this combination legal" and leaving the frontend's dropdown filter and the
-- server's validation as two independent transcriptions of the same table — which is how they drift.
-- As rows, the matrix is one source of truth: the API serves it to the client (so the dropdown
-- filters instantly, with no request per keystroke) and the Service validates against it, both
-- reading the same 80 rows.
--
-- **The reference rows live in this migration rather than in `seeds/`, and that is deliberate.**
-- Everything in `seeds/` is demo content — five universities, a roster — that an environment may
-- legitimately be without. These rows are not content: `assessment_type_scorings` is *server-side
-- validation input*, so an environment missing it would reject every assessment ever saved, and
-- `test/setup.ts` applies migrations only. Reference data that validation reads belongs where the
-- CHECK constraints already are. (Recorded as deviation D26 in PROGRESS.md.)
--
-- Ids are fixed UUIDs and every insert is `INSERT OR IGNORE`, so re-running is a no-op and code,
-- tests and seeds may all refer to a type by a stable id.
--
-- Conventions as everywhere else (§12, §15): UUID v4 PKs, TEXT columns, ISO-8601 UTC timestamps
-- (`strftime`, never bare `CURRENT_TIMESTAMP` — see seeds/0002), every FK indexed.

-- --- The type lookup --------------------------------------------------------------------------
--
-- `code` is the stable machine handle (`CAREER_VOCATIONAL`); `name` is what an administrator reads
-- ("Career/Vocational"). Both are unique — the code because code is what the backfill and the tests
-- resolve by, the name because two rows called "Aptitude" in a dropdown is a data-entry accident
-- rather than a distinction. `order_number` is the display order the prompt lists them in; it is a
-- column rather than an ORDER BY on name because the list is a curated sequence, not an alphabet.

CREATE TABLE assessment_types (
    id           TEXT PRIMARY KEY NOT NULL,
    code         TEXT NOT NULL,
    name         TEXT NOT NULL,
    description  TEXT,
    order_number INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at   TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX assessment_types_code_unique ON assessment_types (code);
CREATE UNIQUE INDEX assessment_types_name_unique ON assessment_types (name COLLATE NOCASE);
CREATE INDEX assessment_types_order_number_index ON assessment_types (order_number);

-- --- The scoring lookup -----------------------------------------------------------------------

CREATE TABLE assessment_scorings (
    id           TEXT PRIMARY KEY NOT NULL,
    code         TEXT NOT NULL,
    name         TEXT NOT NULL,
    description  TEXT,
    order_number INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at   TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX assessment_scorings_code_unique ON assessment_scorings (code);
CREATE UNIQUE INDEX assessment_scorings_name_unique ON assessment_scorings (name COLLATE NOCASE);
CREATE INDEX assessment_scorings_order_number_index ON assessment_scorings (order_number);

-- --- The compatibility matrix -----------------------------------------------------------------
--
-- One row per *legal* (type, scoring) pair. CASCADE on both sides: a type or scoring that is ever
-- retired takes its own rows in this matrix with it, because a pair naming a deleted side is not a
-- weaker rule — it is an unreadable one.

CREATE TABLE assessment_type_scorings (
    id                    TEXT PRIMARY KEY NOT NULL,
    assessment_type_id    TEXT NOT NULL REFERENCES assessment_types (id) ON DELETE CASCADE,
    assessment_scoring_id TEXT NOT NULL REFERENCES assessment_scorings (id) ON DELETE CASCADE,
    created_at            TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- A duplicate pair would double-count nothing and break nothing, which is exactly why it must be
-- refused here: it would be invisible, and the matrix would slowly stop being a statement anyone
-- could count rows in.
CREATE UNIQUE INDEX assessment_type_scorings_pair_unique
    ON assessment_type_scorings (assessment_type_id, assessment_scoring_id);
CREATE INDEX assessment_type_scorings_type_id_index
    ON assessment_type_scorings (assessment_type_id);
CREATE INDEX assessment_type_scorings_scoring_id_index
    ON assessment_type_scorings (assessment_scoring_id);

-- --- The assessment's own type ----------------------------------------------------------------
--
-- Nullable, and it has to be: SQLite permits `ADD COLUMN … REFERENCES` only when the column
-- defaults to NULL, and the templates already in the database predate the taxonomy. The backfill at
-- the foot of this file gives the two curated instruments their type; a CUSTOM template written
-- before today keeps a NULL, which the list page renders as "Untyped" and the edit form requires
-- the administrator to resolve on the next save. Requiring it at the API (`schemas.ts`) rather than
-- with a NOT NULL is what lets old rows stay readable instead of becoming unloadable.
ALTER TABLE assessment_templates ADD COLUMN assessment_type_id TEXT REFERENCES assessment_types (id);

CREATE INDEX assessment_templates_assessment_type_id_index
    ON assessment_templates (assessment_type_id);

-- --- The assessment's scoring methods (many-to-many) ------------------------------------------
--
-- **A join table, not a second FK on `assessment_templates`.** The matrix above is the reason: a
-- single Personality instrument legitimately reports Likert responses *and* T-Scores *and* a profile,
-- and the prompt's own mapping lists up to nine methods for a type. A single `assessment_scoring_id`
-- would force the author to pick the one that fits worst.

CREATE TABLE assessment_template_scorings (
    id                     TEXT PRIMARY KEY NOT NULL,
    assessment_template_id TEXT NOT NULL REFERENCES assessment_templates (id) ON DELETE CASCADE,
    -- **No CASCADE on this side.** A scoring method still referenced by a live assessment is not
    -- something to silently unpick; the restriction surfaces as a constraint error, which is the
    -- honest outcome (nothing in the app deletes a scoring row — the lookup is curated).
    assessment_scoring_id  TEXT NOT NULL REFERENCES assessment_scorings (id),
    created_at             TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX assessment_template_scorings_pair_unique
    ON assessment_template_scorings (assessment_template_id, assessment_scoring_id);
CREATE INDEX assessment_template_scorings_template_id_index
    ON assessment_template_scorings (assessment_template_id);
CREATE INDEX assessment_template_scorings_scoring_id_index
    ON assessment_template_scorings (assessment_scoring_id);

-- --- Assignment scope -------------------------------------------------------------------------
--
-- An assignment still **names exactly one class**, and every downstream rule — who may start an
-- attempt (live enrollment), who may read one (the class's counselor), who gets the §44 notification
-- — continues to resolve through that class unchanged. What this column records is the *act* that
-- created the row: assigning to picked classes, or the single administrative act of assigning to
-- every active class at once.
--
-- The alternative, a nullable `class_id` meaning "everyone", was rejected: it would make
-- `classForAttempt` return NULL, and `authorizeViewAttempt` — the guard on the most sensitive data
-- in the system (§40) — is written against a class that exists. A display distinction is not worth
-- weakening that.
ALTER TABLE assessment_assignments
    ADD COLUMN scope TEXT NOT NULL DEFAULT 'CLASS' CHECK (scope IN ('GLOBAL', 'CLASS'));

CREATE INDEX assessment_assignments_scope_index ON assessment_assignments (scope);

-- --- Reference rows: the 12 types -------------------------------------------------------------

INSERT OR IGNORE INTO assessment_types (id, code, name, description, order_number, created_at, updated_at) VALUES
('a55e7001-0001-4001-8001-000000000001', 'APTITUDE',             'Aptitude',             'Measures capacity to learn or perform a skill.',                          1,  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('a55e7001-0001-4001-8001-000000000002', 'ACADEMIC',             'Academic',             'Measures attainment in a subject or curriculum.',                         2,  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('a55e7001-0001-4001-8001-000000000003', 'PERSONALITY',          'Personality',          'Measures stable traits and dispositions.',                                3,  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('a55e7001-0001-4001-8001-000000000004', 'INTEREST',             'Interest',             'Measures preference for activities and environments (RIASEC lives here).', 4,  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('a55e7001-0001-4001-8001-000000000005', 'INTELLIGENCE',         'Intelligence',         'Measures general cognitive ability.',                                     5,  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('a55e7001-0001-4001-8001-000000000006', 'BEHAVIORAL',           'Behavioral',           'Measures observable conduct and its frequency or severity.',              6,  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('a55e7001-0001-4001-8001-000000000007', 'EMOTIONAL',            'Emotional',            'Measures affect, regulation and emotional functioning.',                  7,  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('a55e7001-0001-4001-8001-000000000008', 'CLINICAL',             'Clinical',             'Screens for clinically significant symptoms.',                            8,  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('a55e7001-0001-4001-8001-000000000009', 'NEUROPSYCHOLOGICAL',   'Neuropsychological',   'Measures cognitive domains tied to brain function.',                      9,  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('a55e7001-0001-4001-8001-000000000010', 'ADAPTIVE_FUNCTIONING', 'Adaptive Functioning', 'Measures everyday practical, social and conceptual skills.',              10, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('a55e7001-0001-4001-8001-000000000011', 'CAREER_VOCATIONAL',    'Career/Vocational',    'Measures career readiness, values and vocational fit (SCCT lives here).', 11, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('a55e7001-0001-4001-8001-000000000012', 'LEARNING_STYLE',       'Learning Style',       'Measures preferred modes of learning and study.',                         12, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- --- Reference rows: the 15 scoring methods ---------------------------------------------------

INSERT OR IGNORE INTO assessment_scorings (id, code, name, description, order_number, created_at, updated_at) VALUES
('5c04e001-0002-4002-8002-000000000001', 'LIKERT_SCALES',                'Likert Scales',                'Ordered agreement responses summed per dimension.',            1,  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('5c04e001-0002-4002-8002-000000000002', 'RAW_SCORES',                   'Raw Scores',                   'The untransformed point total.',                                2,  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('5c04e001-0002-4002-8002-000000000003', 'PERCENTAGE_SCORES',            'Percentage Scores',            'Points earned as a percentage of points available.',            3,  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('5c04e001-0002-4002-8002-000000000004', 'PERCENTILE_RANKS',             'Percentile Ranks',             'Position relative to a norm group, 1–99.',                      4,  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('5c04e001-0002-4002-8002-000000000005', 'STANDARD_SCORES',              'Standard Scores',              'Normalized to a fixed mean and standard deviation.',            5,  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('5c04e001-0002-4002-8002-000000000006', 'T_SCORES',                     'T-Scores',                     'Standard scores with mean 50, SD 10.',                          6,  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('5c04e001-0002-4002-8002-000000000007', 'Z_SCORES',                     'Z-Scores',                     'Standard scores with mean 0, SD 1.',                            7,  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('5c04e001-0002-4002-8002-000000000008', 'STANINES',                     'Stanines',                     'A nine-point normalized band.',                                 8,  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('5c04e001-0002-4002-8002-000000000009', 'SCALED_SCORES',                'Scaled Scores',                'Subtest scores with mean 10, SD 3.',                            9,  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('5c04e001-0002-4002-8002-000000000010', 'NORM_REFERENCED_SCORES',       'Norm-Referenced Scores',       'Interpreted against a comparison group.',                       10, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('5c04e001-0002-4002-8002-000000000011', 'CRITERION_REFERENCED_SCORES',  'Criterion-Referenced Scores',  'Interpreted against a fixed standard of mastery.',               11, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('5c04e001-0002-4002-8002-000000000012', 'COMPOSITE_SCORES',             'Composite Scores',             'A weighted combination of several subscores.',                  12, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('5c04e001-0002-4002-8002-000000000013', 'PROFILE_SCORES',               'Profile Scores',               'A shape across dimensions rather than one number.',              13, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('5c04e001-0002-4002-8002-000000000014', 'SEVERITY_SCORES',              'Severity Scores',              'Banded intensity, e.g. mild / moderate / severe.',              14, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('5c04e001-0002-4002-8002-000000000015', 'IQ_SCORES',                    'IQ Scores',                    'Deviation IQ with mean 100, SD 15.',                            15, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- --- Reference rows: the 80 legal (type, scoring) pairs ---------------------------------------
--
-- The pair id encodes its own coordinates — `…-00000000TTSS`, type TT and scoring SS — so the row
-- is idempotent under re-run and a pair can be read straight out of the id while debugging.
--
-- Written out per type, one INSERT each, rather than as one generated compound SELECT: D1 refuses a
-- compound SELECT this long (`too many terms in compound SELECT`), and the grouped form is the one
-- a reader can check against the specification line by line anyway.

-- Aptitude: Raw, Standard, Percentile, Scaled, Z, T, Stanines, Norm-Referenced, Composite
INSERT OR IGNORE INTO assessment_type_scorings (id, assessment_type_id, assessment_scoring_id, created_at) VALUES
('7a5c0001-0003-4003-8003-000000000102', 'a55e7001-0001-4001-8001-000000000001', '5c04e001-0002-4002-8002-000000000002', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000105', 'a55e7001-0001-4001-8001-000000000001', '5c04e001-0002-4002-8002-000000000005', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000104', 'a55e7001-0001-4001-8001-000000000001', '5c04e001-0002-4002-8002-000000000004', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000109', 'a55e7001-0001-4001-8001-000000000001', '5c04e001-0002-4002-8002-000000000009', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000107', 'a55e7001-0001-4001-8001-000000000001', '5c04e001-0002-4002-8002-000000000007', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000106', 'a55e7001-0001-4001-8001-000000000001', '5c04e001-0002-4002-8002-000000000006', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000108', 'a55e7001-0001-4001-8001-000000000001', '5c04e001-0002-4002-8002-000000000008', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000110', 'a55e7001-0001-4001-8001-000000000001', '5c04e001-0002-4002-8002-000000000010', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000112', 'a55e7001-0001-4001-8001-000000000001', '5c04e001-0002-4002-8002-000000000012', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Academic: Raw, Percentage, Standard, Percentile, Criterion-Referenced, Norm-Referenced, Scaled, Stanines
INSERT OR IGNORE INTO assessment_type_scorings (id, assessment_type_id, assessment_scoring_id, created_at) VALUES
('7a5c0001-0003-4003-8003-000000000202', 'a55e7001-0001-4001-8001-000000000002', '5c04e001-0002-4002-8002-000000000002', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000203', 'a55e7001-0001-4001-8001-000000000002', '5c04e001-0002-4002-8002-000000000003', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000205', 'a55e7001-0001-4001-8001-000000000002', '5c04e001-0002-4002-8002-000000000005', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000204', 'a55e7001-0001-4001-8001-000000000002', '5c04e001-0002-4002-8002-000000000004', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000211', 'a55e7001-0001-4001-8001-000000000002', '5c04e001-0002-4002-8002-000000000011', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000210', 'a55e7001-0001-4001-8001-000000000002', '5c04e001-0002-4002-8002-000000000010', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000209', 'a55e7001-0001-4001-8001-000000000002', '5c04e001-0002-4002-8002-000000000009', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000208', 'a55e7001-0001-4001-8001-000000000002', '5c04e001-0002-4002-8002-000000000008', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Personality: Likert, Raw, T, Standard, Profile, Percentile, Norm-Referenced
INSERT OR IGNORE INTO assessment_type_scorings (id, assessment_type_id, assessment_scoring_id, created_at) VALUES
('7a5c0001-0003-4003-8003-000000000301', 'a55e7001-0001-4001-8001-000000000003', '5c04e001-0002-4002-8002-000000000001', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000302', 'a55e7001-0001-4001-8001-000000000003', '5c04e001-0002-4002-8002-000000000002', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000306', 'a55e7001-0001-4001-8001-000000000003', '5c04e001-0002-4002-8002-000000000006', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000305', 'a55e7001-0001-4001-8001-000000000003', '5c04e001-0002-4002-8002-000000000005', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000313', 'a55e7001-0001-4001-8001-000000000003', '5c04e001-0002-4002-8002-000000000013', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000304', 'a55e7001-0001-4001-8001-000000000003', '5c04e001-0002-4002-8002-000000000004', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000310', 'a55e7001-0001-4001-8001-000000000003', '5c04e001-0002-4002-8002-000000000010', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Interest: Likert, Raw, Profile, Stanines, Percentile, Standard
INSERT OR IGNORE INTO assessment_type_scorings (id, assessment_type_id, assessment_scoring_id, created_at) VALUES
('7a5c0001-0003-4003-8003-000000000401', 'a55e7001-0001-4001-8001-000000000004', '5c04e001-0002-4002-8002-000000000001', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000402', 'a55e7001-0001-4001-8001-000000000004', '5c04e001-0002-4002-8002-000000000002', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000413', 'a55e7001-0001-4001-8001-000000000004', '5c04e001-0002-4002-8002-000000000013', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000408', 'a55e7001-0001-4001-8001-000000000004', '5c04e001-0002-4002-8002-000000000008', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000404', 'a55e7001-0001-4001-8001-000000000004', '5c04e001-0002-4002-8002-000000000004', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000405', 'a55e7001-0001-4001-8001-000000000004', '5c04e001-0002-4002-8002-000000000005', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Intelligence: IQ, Standard, Scaled, Percentile, T, Z, Norm-Referenced
INSERT OR IGNORE INTO assessment_type_scorings (id, assessment_type_id, assessment_scoring_id, created_at) VALUES
('7a5c0001-0003-4003-8003-000000000515', 'a55e7001-0001-4001-8001-000000000005', '5c04e001-0002-4002-8002-000000000015', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000505', 'a55e7001-0001-4001-8001-000000000005', '5c04e001-0002-4002-8002-000000000005', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000509', 'a55e7001-0001-4001-8001-000000000005', '5c04e001-0002-4002-8002-000000000009', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000504', 'a55e7001-0001-4001-8001-000000000005', '5c04e001-0002-4002-8002-000000000004', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000506', 'a55e7001-0001-4001-8001-000000000005', '5c04e001-0002-4002-8002-000000000006', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000507', 'a55e7001-0001-4001-8001-000000000005', '5c04e001-0002-4002-8002-000000000007', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000510', 'a55e7001-0001-4001-8001-000000000005', '5c04e001-0002-4002-8002-000000000010', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Behavioral: Likert, Raw, T, Severity, Profile, Standard
INSERT OR IGNORE INTO assessment_type_scorings (id, assessment_type_id, assessment_scoring_id, created_at) VALUES
('7a5c0001-0003-4003-8003-000000000601', 'a55e7001-0001-4001-8001-000000000006', '5c04e001-0002-4002-8002-000000000001', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000602', 'a55e7001-0001-4001-8001-000000000006', '5c04e001-0002-4002-8002-000000000002', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000606', 'a55e7001-0001-4001-8001-000000000006', '5c04e001-0002-4002-8002-000000000006', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000614', 'a55e7001-0001-4001-8001-000000000006', '5c04e001-0002-4002-8002-000000000014', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000613', 'a55e7001-0001-4001-8001-000000000006', '5c04e001-0002-4002-8002-000000000013', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000605', 'a55e7001-0001-4001-8001-000000000006', '5c04e001-0002-4002-8002-000000000005', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Emotional: Likert, Raw, T, Severity, Standard, Profile
INSERT OR IGNORE INTO assessment_type_scorings (id, assessment_type_id, assessment_scoring_id, created_at) VALUES
('7a5c0001-0003-4003-8003-000000000701', 'a55e7001-0001-4001-8001-000000000007', '5c04e001-0002-4002-8002-000000000001', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000702', 'a55e7001-0001-4001-8001-000000000007', '5c04e001-0002-4002-8002-000000000002', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000706', 'a55e7001-0001-4001-8001-000000000007', '5c04e001-0002-4002-8002-000000000006', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000714', 'a55e7001-0001-4001-8001-000000000007', '5c04e001-0002-4002-8002-000000000014', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000705', 'a55e7001-0001-4001-8001-000000000007', '5c04e001-0002-4002-8002-000000000005', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000713', 'a55e7001-0001-4001-8001-000000000007', '5c04e001-0002-4002-8002-000000000013', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Clinical: T, Severity, Raw, Standard, Percentile, Profile, Norm-Referenced
INSERT OR IGNORE INTO assessment_type_scorings (id, assessment_type_id, assessment_scoring_id, created_at) VALUES
('7a5c0001-0003-4003-8003-000000000806', 'a55e7001-0001-4001-8001-000000000008', '5c04e001-0002-4002-8002-000000000006', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000814', 'a55e7001-0001-4001-8001-000000000008', '5c04e001-0002-4002-8002-000000000014', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000802', 'a55e7001-0001-4001-8001-000000000008', '5c04e001-0002-4002-8002-000000000002', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000805', 'a55e7001-0001-4001-8001-000000000008', '5c04e001-0002-4002-8002-000000000005', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000804', 'a55e7001-0001-4001-8001-000000000008', '5c04e001-0002-4002-8002-000000000004', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000813', 'a55e7001-0001-4001-8001-000000000008', '5c04e001-0002-4002-8002-000000000013', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000810', 'a55e7001-0001-4001-8001-000000000008', '5c04e001-0002-4002-8002-000000000010', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Neuropsychological: Raw, Standard, Scaled, Percentile, T, Z, Composite
INSERT OR IGNORE INTO assessment_type_scorings (id, assessment_type_id, assessment_scoring_id, created_at) VALUES
('7a5c0001-0003-4003-8003-000000000902', 'a55e7001-0001-4001-8001-000000000009', '5c04e001-0002-4002-8002-000000000002', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000905', 'a55e7001-0001-4001-8001-000000000009', '5c04e001-0002-4002-8002-000000000005', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000909', 'a55e7001-0001-4001-8001-000000000009', '5c04e001-0002-4002-8002-000000000009', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000904', 'a55e7001-0001-4001-8001-000000000009', '5c04e001-0002-4002-8002-000000000004', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000906', 'a55e7001-0001-4001-8001-000000000009', '5c04e001-0002-4002-8002-000000000006', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000907', 'a55e7001-0001-4001-8001-000000000009', '5c04e001-0002-4002-8002-000000000007', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000000912', 'a55e7001-0001-4001-8001-000000000009', '5c04e001-0002-4002-8002-000000000012', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Adaptive Functioning: Raw, Standard, Percentile, Composite, Profile
INSERT OR IGNORE INTO assessment_type_scorings (id, assessment_type_id, assessment_scoring_id, created_at) VALUES
('7a5c0001-0003-4003-8003-000000001002', 'a55e7001-0001-4001-8001-000000000010', '5c04e001-0002-4002-8002-000000000002', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000001005', 'a55e7001-0001-4001-8001-000000000010', '5c04e001-0002-4002-8002-000000000005', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000001004', 'a55e7001-0001-4001-8001-000000000010', '5c04e001-0002-4002-8002-000000000004', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000001012', 'a55e7001-0001-4001-8001-000000000010', '5c04e001-0002-4002-8002-000000000012', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000001013', 'a55e7001-0001-4001-8001-000000000010', '5c04e001-0002-4002-8002-000000000013', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Career/Vocational: Likert, Raw, Profile, Standard, Percentile, Composite, Norm-Referenced
INSERT OR IGNORE INTO assessment_type_scorings (id, assessment_type_id, assessment_scoring_id, created_at) VALUES
('7a5c0001-0003-4003-8003-000000001101', 'a55e7001-0001-4001-8001-000000000011', '5c04e001-0002-4002-8002-000000000001', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000001102', 'a55e7001-0001-4001-8001-000000000011', '5c04e001-0002-4002-8002-000000000002', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000001113', 'a55e7001-0001-4001-8001-000000000011', '5c04e001-0002-4002-8002-000000000013', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000001105', 'a55e7001-0001-4001-8001-000000000011', '5c04e001-0002-4002-8002-000000000005', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000001104', 'a55e7001-0001-4001-8001-000000000011', '5c04e001-0002-4002-8002-000000000004', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000001112', 'a55e7001-0001-4001-8001-000000000011', '5c04e001-0002-4002-8002-000000000012', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000001110', 'a55e7001-0001-4001-8001-000000000011', '5c04e001-0002-4002-8002-000000000010', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Learning Style: Likert, Raw, Profile, Standard, Percentile
INSERT OR IGNORE INTO assessment_type_scorings (id, assessment_type_id, assessment_scoring_id, created_at) VALUES
('7a5c0001-0003-4003-8003-000000001201', 'a55e7001-0001-4001-8001-000000000012', '5c04e001-0002-4002-8002-000000000001', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000001202', 'a55e7001-0001-4001-8001-000000000012', '5c04e001-0002-4002-8002-000000000002', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000001213', 'a55e7001-0001-4001-8001-000000000012', '5c04e001-0002-4002-8002-000000000013', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000001205', 'a55e7001-0001-4001-8001-000000000012', '5c04e001-0002-4002-8002-000000000005', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('7a5c0001-0003-4003-8003-000000001204', 'a55e7001-0001-4001-8001-000000000012', '5c04e001-0002-4002-8002-000000000004', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- --- Data migration: the instruments that predate the taxonomy --------------------------------
--
-- RIASEC is an interest inventory and SCCT is a career-theory instrument, so each has exactly one
-- honest type. Both are Likert instruments summed to a raw total per dimension — and both pairs are
-- legal under the matrix above (Interest and Career/Vocational each allow Likert Scales and Raw
-- Scores), so the backfill leaves no row that the validation it just gained would now reject.
--
-- A CUSTOM template written before today keeps `assessment_type_id = NULL` on purpose: guessing a
-- type for somebody's instrument is worse than showing "Untyped" and asking on the next edit.

UPDATE assessment_templates
   SET assessment_type_id = 'a55e7001-0001-4001-8001-000000000004', -- Interest
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE category = 'RIASEC' AND assessment_type_id IS NULL;

UPDATE assessment_templates
   SET assessment_type_id = 'a55e7001-0001-4001-8001-000000000011', -- Career/Vocational
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE category = 'SCCT' AND assessment_type_id IS NULL;

INSERT OR IGNORE INTO assessment_template_scorings (id, assessment_template_id, assessment_scoring_id, created_at)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4'
         || substr(lower(hex(randomblob(2))), 2) || '-a'
         || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       template.id,
       scoring.id,
       strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM assessment_templates AS template
  JOIN assessment_scorings AS scoring ON scoring.code IN ('LIKERT_SCALES', 'RAW_SCORES')
 WHERE template.category IN ('RIASEC', 'SCCT');

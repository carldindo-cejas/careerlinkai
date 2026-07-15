-- Migration 0006 — Attempt & Results module (FULLPLAN §13.5)
--
-- **No soft deletes anywhere in this module** (§12), and that is not an oversight to be tidied
-- up later by a well-meaning refactor. An attempt, its answers and its scores are permanent
-- historical evidence: they are what a student was actually asked, what they actually said, and
-- what the system actually concluded. A `deleted_at` here would let that record be made to
-- disappear, and the archive-don't-delete principle (§8) exists precisely so it cannot. Nothing
-- in this module is ever removed; an attempt that should not count becomes `EXPIRED`.

CREATE TABLE assessment_attempts (
    id                    TEXT PRIMARY KEY NOT NULL,
    assignment_id         TEXT NOT NULL REFERENCES assessment_assignments (id) ON DELETE CASCADE,
    -- Denormalized from the assignment on purpose (§13.5): the attempt must still resolve to the
    -- exact version it was taken under even after the assignment is closed, and a student's
    -- result must keep meaning what it meant. This is the column that makes an attempt
    -- re-derivable years later.
    assessment_version_id TEXT NOT NULL REFERENCES assessment_versions (id),
    student_id            TEXT NOT NULL REFERENCES users (id),
    -- EXPIRED is a real state with a precise definition (§21, v1.2): an attempt still
    -- IN_PROGRESS when its assignment CLOSES, or one voided by a counselor reset. Expired
    -- attempts are never scored and never feed recommendations — which is what makes "latest
    -- result" resolve unambiguously to a SCORED attempt everywhere else in the system.
    status                TEXT NOT NULL DEFAULT 'IN_PROGRESS'
                               CHECK (status IN ('IN_PROGRESS', 'SUBMITTED', 'SCORED', 'EXPIRED')),
    started_at            TEXT NOT NULL,
    submitted_at          TEXT,
    created_at            TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at            TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- **One attempt per assignment per student** (§13.5, v1.2) — load-bearing, not hygiene.
--
-- A retake is a counselor-initiated reset: the old attempt is marked EXPIRED and *kept*, and a
-- fresh one may then start. So the constraint cannot be a plain UNIQUE (assignment_id,
-- student_id) — that would make the reset impossible, because the expired row still occupies the
-- pair. It is a **partial** index over the live states instead: at most one attempt that still
-- counts, with any number of expired ones behind it as history.
CREATE UNIQUE INDEX assessment_attempts_live_assignment_student_unique
    ON assessment_attempts (assignment_id, student_id)
    WHERE status <> 'EXPIRED';

CREATE INDEX assessment_attempts_assignment_id_index ON assessment_attempts (assignment_id);
CREATE INDEX assessment_attempts_student_id_index ON assessment_attempts (student_id);
CREATE INDEX assessment_attempts_version_id_index ON assessment_attempts (assessment_version_id);
CREATE INDEX assessment_attempts_status_index ON assessment_attempts (status);
-- "The student's latest SCORED result", which is the Part VII engine's entry query.
CREATE INDEX assessment_attempts_student_status_index ON assessment_attempts (student_id, status);

CREATE TABLE assessment_answers (
    id                 TEXT PRIMARY KEY NOT NULL,
    attempt_id         TEXT NOT NULL REFERENCES assessment_attempts (id) ON DELETE CASCADE,
    question_id        TEXT NOT NULL REFERENCES assessment_questions (id),
    selected_option_id TEXT REFERENCES question_options (id),
    -- For non-option answer types. Unused by RIASEC/SCCT; reserved for CUSTOM (§13.5).
    answer_text        TEXT,
    -- **An immutable snapshot, copied server-side from the chosen option at answer time**
    -- (§13.5) — never client-supplied. Two reasons, and both matter:
    --   1. A client that could POST its own score would be scoring its own assessment.
    --   2. It is why a scored attempt is re-derivable years later: the engine reads this
    --      snapshot, never a live join through `question_options`, so editing an option's score
    --      in some future version cannot reach backwards into a result already delivered.
    score              REAL NOT NULL,
    answered_at        TEXT NOT NULL
);

-- One answer per question per attempt (§13.5). The endpoint is an upsert — changing your mind on
-- question 7 must *update* the answer, not stack a second one that then gets summed twice.
CREATE UNIQUE INDEX assessment_answers_attempt_question_unique
    ON assessment_answers (attempt_id, question_id);
CREATE INDEX assessment_answers_attempt_id_index ON assessment_answers (attempt_id);
CREATE INDEX assessment_answers_question_id_index ON assessment_answers (question_id);

CREATE TABLE dimension_scores (
    id               TEXT PRIMARY KEY NOT NULL,
    attempt_id       TEXT NOT NULL REFERENCES assessment_attempts (id) ON DELETE CASCADE,
    dimension_id     TEXT NOT NULL REFERENCES assessment_dimensions (id),
    raw_score        REAL NOT NULL,
    normalized_score REAL NOT NULL,
    interpretation   TEXT,
    created_at       TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- **An absent row means "not measured", and that is a different claim from zero** (§24).
--
-- When every question on a dimension was optional and skipped, `max` is 0 and no row is written
-- at all. A stored 0.00 would be a false statement about the student: it would then be sorted
-- into a Holland Code as a real dimension and averaged into a recommendation as a real number.
-- The results UI honours this by rendering no bar rather than an empty one, and a frontend test
-- pins it. Nothing in the scoring path may "helpfully" backfill a zero here.
CREATE UNIQUE INDEX dimension_scores_attempt_dimension_unique
    ON dimension_scores (attempt_id, dimension_id);
CREATE INDEX dimension_scores_attempt_id_index ON dimension_scores (attempt_id);
CREATE INDEX dimension_scores_dimension_id_index ON dimension_scores (dimension_id);

CREATE TABLE assessment_results (
    id              TEXT PRIMARY KEY NOT NULL,
    attempt_id      TEXT NOT NULL REFERENCES assessment_attempts (id) ON DELETE CASCADE,
    -- **Display only** (§23, v1.2). For SCCT this holds the Career Confidence Index rendered as
    -- a sentence — and every consumer, above all the Part VII engine, *recomputes* that index
    -- from the `dimension_scores` rows plus the version's `scoring_config`. Nothing ever parses
    -- a number back out of this prose. A numeric value round-tripping through a display string
    -- is, in the plan's own words, a bug waiting to happen.
    overall_summary TEXT,
    -- The Holland Code ("IAS") for RIASEC; NULL for SCCT, which produces a composite instead.
    -- NULL for an ungraded CUSTOM assessment too (§24) — an assessment with no dimensions is
    -- reflection-only, and it still gets a result row, still fires AssessmentCompleted.
    result_code     TEXT,
    generated_at    TEXT NOT NULL
);

-- One result per attempt. Re-scoring an attempt must replace its result, never accumulate a
-- second one that a "latest result" query would then have to choose between.
CREATE UNIQUE INDEX assessment_results_attempt_id_unique ON assessment_results (attempt_id);

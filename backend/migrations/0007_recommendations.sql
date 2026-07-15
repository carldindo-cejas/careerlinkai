-- Migration 0007 — recommendations + recommendation_explanations (FULLPLAN §13.6)
--
-- The Recommendation module. Blocked until now for a concrete reason and not an organisational
-- one: `recommendations.assessment_result_id` is a foreign key to `assessment_results`, and that
-- table did not exist until Step 4. The migration could not be written, let alone applied.
--
-- Two tables, and the split between them is the one place in this schema where the
-- **deterministic/AI boundary is structural rather than conventional** (§13.6). Everything in
-- `recommendations` is computed by ordinary arithmetic with a known formula (§27) and is
-- reproducible from the same inputs (§26). Everything in `recommendation_explanations` is a
-- language model talking. Keeping them in one table would mean a single row where half the
-- columns are facts and half are prose, and the first person to write `SELECT *` would not be
-- able to tell which was which.
--
-- There is no soft delete on either table. A recommendation is derived data, not a record of
-- something a human did — the way to make it go away is to regenerate it, and the way to keep it
-- honest is that regenerating it from the same result produces byte-identical rows.

CREATE TABLE recommendations (
    id                   TEXT PRIMARY KEY NOT NULL,

    -- The RIASEC result these recommendations were computed from. §27 reads *two* results — the
    -- RIASEC dimension scores and the SCCT career-confidence index — but the FK is singular, so
    -- it anchors to RIASEC: that is the result whose `dimension_scores` the ranking is actually
    -- computed over, and the one whose Holland Code the student sees next to these cards. The
    -- SCCT result contributes a single scalar (§23's composite index), which is recomputed from
    -- `dimension_scores` at generation time and is not a parent of this row.
    assessment_result_id TEXT NOT NULL REFERENCES assessment_results (id) ON DELETE CASCADE,

    -- Denormalized from the result's attempt. §27 ranks the whole catalog for one student, and
    -- every read of this table is "this student's recommendations" — resolving that through
    -- assessment_results → assessment_attempts → student_id on every request would be a two-hop
    -- join to recover something that can never change for a given row.
    student_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,

    match_type           TEXT NOT NULL CHECK (match_type IN ('CAREER', 'PROGRAM')),

    -- Exactly one of these is set, and which one is decided by `match_type`. The CHECK below is
    -- what makes that a schema guarantee rather than a comment: a CAREER row with a program in
    -- it would be scored by one formula (§27's career composite) and read by the other.
    target_career_id     TEXT REFERENCES careers (id) ON DELETE CASCADE,
    target_program_id    TEXT REFERENCES programs (id) ON DELETE CASCADE,

    match_score          REAL NOT NULL,

    -- 1 = the best match *within its own type, for this result*. Not globally: a student has a
    -- rank-1 career and a rank-1 program, and comparing a career's 69.1 against a program's 76.1
    -- is meaningless — they are computed by different formulas with different weights (§27).
    ranking              INTEGER NOT NULL,

    -- Deterministic, rule-based, and assembled by string formatting over numbers already
    -- computed (§27). Never a model call. §3's first principle: "No recommendation is shown
    -- without a reason", and this is the reason — the AI explanation in the sibling table is an
    -- elaboration on it, not a substitute for it.
    reason               TEXT NOT NULL,

    created_at           TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),

    -- The target must agree with the type. SQLite CAN express this one, so it does.
    CHECK (
        (match_type = 'CAREER'  AND target_career_id IS NOT NULL AND target_program_id IS NULL)
        OR
        (match_type = 'PROGRAM' AND target_program_id IS NOT NULL AND target_career_id IS NULL)
    )
);

-- One row per rank per type per result. This is what makes regeneration *idempotent* rather than
-- duplicative: §26 promises the same inputs produce the same ranking, so re-running generation
-- for a result must not silently leave two rank-1 careers behind. The service deletes a result's
-- rows before inserting the new ones, in the same batch — this index is the thing that would
-- catch it if it ever stopped doing so.
CREATE UNIQUE INDEX recommendations_result_type_ranking_unique
    ON recommendations (assessment_result_id, match_type, ranking);

CREATE INDEX recommendations_student_id_index ON recommendations (student_id);
CREATE INDEX recommendations_assessment_result_id_index ON recommendations (assessment_result_id);
CREATE INDEX recommendations_target_career_id_index ON recommendations (target_career_id);
CREATE INDEX recommendations_target_program_id_index ON recommendations (target_program_id);

-- A "recommended college" needs no table and no text matching (§13.6): it is a real join,
-- target_program_id → programs.college_id → colleges. That only became true when `colleges`
-- stopped being a free-text column in v1.1.

CREATE TABLE recommendation_explanations (
    id                TEXT PRIMARY KEY NOT NULL,
    recommendation_id TEXT NOT NULL REFERENCES recommendations (id) ON DELETE CASCADE,
    explanation_text  TEXT NOT NULL,
    -- Which model said it. An explanation is only reproducible-ish to the extent you know what
    -- produced it, and a model swap is exactly the kind of change that makes old prose read
    -- oddly next to new prose.
    ai_model          TEXT NOT NULL,
    created_at        TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- One explanation per recommendation (§13.6: "FK, unique"). Phase 5a writes these; nothing does
-- yet. Re-explaining a recommendation replaces its explanation rather than accumulating a pile
-- of variations on the same card.
CREATE UNIQUE INDEX recommendation_explanations_recommendation_id_unique
    ON recommendation_explanations (recommendation_id);

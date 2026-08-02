-- Migration 0021 — Two positions that must be unique: a question's place in its version, and an
-- option's answer key within its question (ASSESSMENT-FIX §4, §6).
--
-- Both columns are *identities* that the application has always treated as unique and the database
-- has never held. Neither omission produced an error; both produced silently wrong data, which is
-- why they were found by reading the write paths rather than by anything failing.
--
-- ## `assessment_questions (assessment_version_id, order_number)`
--
-- `order_number` is what the player renders items in and what every author-facing list sorts by.
-- Three different code paths computed it, and they did not agree:
--
--   * the bulk-add route positioned with `COUNT + 1`,
--   * `duplicateQuestion` with `MAX + 1` — whose own doc comment says why a count is wrong,
--   * the §31 generation job numbered from 1 regardless of what the version already held, so
--     drafting with AI into a version an author had started by hand gave two questions the same
--     position every time.
--
-- Positioning now lives in `addQuestions` alone (`MAX + 1`, array order). That fixes the disagreement
-- but not the race: two concurrent adds read the same `MAX` and write the same number. A pre-check
-- cannot hold that invariant — this index can, and `translateUniqueViolation` turns the loser into
-- the same 422 the pre-check would have given (H4).
--
-- The plain index this replaces covered the same two columns in the same order, so every query that
-- used it — the player reading a version's items in order, on every page load — uses this one
-- identically. Dropping it leaves no lookup unindexed.
--
-- ### The renumbering had to change first, and this is the part worth reading
--
-- SQLite enforces a unique index **as each row is written**; there is no deferred mode for one
-- (only foreign keys can be deferred). Both renumbering paths passed through states where two rows
-- held the same position transiently:
--
--   * `reorderQuestions` writes the new sequence row by row — the simplest possible drag, swapping
--     two items, collides on the first statement.
--   * `deleteQuestion` shifted the tail with a single `order_number = order_number - 1`, whose row
--     order SQLite does not define; it collides whenever a row is updated before the one below it.
--
-- Both now park the affected rows on **negative** numbers first, vacating the positive range, and
-- flip them back in a second statement inside the same `db.batch()` — so the interlude is never
-- observable and the final numbers land on positions nothing can be holding. Shipping this index
-- against the previous code would have broken every drag and every delete in the builder.
--
-- ## `question_options (question_id, value)`
--
-- `value` is the answer key: the author-facing and export-facing identity of an option. Nothing
-- prevented duplicates at any layer, and the client actively produced them — `addOption` derived the
-- new value from the array length, so removing option 2 of 3 and adding one yielded two options
-- valued "3". Scoring is unaffected (stored answers reference `selected_option_id`, not `value`), so
-- this never surfaced as a bug; it surfaced as an export in which two rows mean the same thing.
--
-- Both write schemas now reject a duplicate within a payload, and the client derives new values from
-- the highest existing one. This index is the floor under both.
--
-- ## Verified before it was written, per the 0020 lesson
--
-- A migration checked only against a local database applies cleanly and then fails on the first real
-- one. Both violation counts were run against **production and staging** first:
--
--     production   90 questions,  450 options — 0 duplicate positions, 0 duplicate option values
--     staging     103 questions,  515 options — 0 duplicate positions, 0 duplicate option values
--
-- So both indexes are constraints that cost nothing today, and no row is rewritten or removed by
-- this file: it is non-destructive under the §5b rollback note (`wrangler rollback` reverts code
-- only; an applied migration stays applied).

DROP INDEX assessment_questions_version_order_index;

CREATE UNIQUE INDEX assessment_questions_version_order_unique
    ON assessment_questions (assessment_version_id, order_number);

CREATE UNIQUE INDEX question_options_question_value_unique
    ON question_options (question_id, value);

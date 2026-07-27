-- Migration 0016 — the publication date, the delete actor, and the audit viewer's filter indexes
-- (prompt-driven extension, 2026-07-26)
--
-- Three unrelated-looking additions that are all the same shape: a *fact the system already had but
-- could not answer a question about*.
--
--   * **`assessment_versions.published_at`** — publishing was a status flip and nothing else, so
--     "when did this assessment become available to students?" had no answer at all. `created_at`
--     is when the version was *drafted*, which for an instrument that sat in review for three weeks
--     is a different date entirely. The administrator's table is now asked to show and filter on
--     Date Published, and a column derived from the wrong timestamp would be worse than no column.
--   * **`assessment_templates.deleted_by`** — `deleted_at` existed; who did it did not. A soft
--     delete is the one act on an instrument that makes it disappear from every screen, so "who
--     removed this" must be answerable from the row, not only from a scan of the audit trail.
--   * **Two composite audit indexes** — the viewer gains an actor filter and a date range, and both
--     of those queries end in "…newest first". 0002 indexed `user_id` and `action` on their own and
--     0010 added `(module, created_at)` for exactly this reason; these two finish the set.
--
-- Conventions as everywhere else (§12, §15): TEXT columns holding ISO-8601 UTC, `strftime` rather
-- than bare `CURRENT_TIMESTAMP`, every new filter path indexed. No CHECK widening and no table
-- rebuild — all three are plain `ADD COLUMN` / `CREATE INDEX`, so this migration is additive and
-- cannot fail on existing data.

-- --- When a version became available to students ----------------------------------------------
--
-- Nullable, and it stays NULL for every DRAFT and for a version archived before it ever published.
-- NULL here means "never published", which is a real state and not missing data — the list renders
-- it as an em dash and the Date Published filter excludes it, both correctly.
--
-- SQLite permits `ADD COLUMN` only with a constant default, so this cannot be
-- `DEFAULT (strftime(...))` — which is right anyway: a default would stamp every existing draft
-- with today's date and claim it had published.
ALTER TABLE assessment_versions ADD COLUMN published_at TEXT;

-- The backfill, and the one judgement call in this file. A version that is already PUBLISHED did
-- publish, at some point nobody recorded; `created_at` is the only timestamp that exists for it and
-- is guaranteed to be *no later* than the real publication. So the backfilled date is a lower bound
-- rather than a guess — an instrument published the day it was drafted (which is what the seeded
-- RIASEC/SCCT instruments and every test fixture actually do) gets the exact right answer, and
-- anything else gets a date that is early rather than invented.
UPDATE assessment_versions
   SET published_at = created_at
 WHERE status = 'PUBLISHED' AND published_at IS NULL;

-- "Everything published in this window, newest first" — the Date Published filter's query shape.
CREATE INDEX assessment_versions_published_at_index ON assessment_versions (published_at);

-- --- Who removed an instrument ------------------------------------------------------------------
--
-- `ON DELETE SET NULL` rather than CASCADE: deleting the administrator who deleted an assessment
-- must not resurrect the assessment. The row keeps its `deleted_at` and loses only the name.
ALTER TABLE assessment_templates ADD COLUMN deleted_by TEXT REFERENCES users (id) ON DELETE SET NULL;

-- Every list in the module opens with `deleted_at IS NULL`. It was a scan; it is now an index seek.
CREATE INDEX assessment_templates_deleted_at_index ON assessment_templates (deleted_at);

-- --- The audit viewer's two new filter paths ---------------------------------------------------
--
-- Composite `(column, created_at)` rather than bare single-column indexes, for the reason 0010
-- gives: every query this screen issues is "these rows, newest first", so an index that stops at
-- the filter still leaves the sort as a scan-and-sort over the matched set.

-- "Everything this administrator did", newest first — the Actor filter.
CREATE INDEX audit_logs_user_created_index ON audit_logs (user_id, created_at);

-- "Every ASSESSMENT_PUBLISHED", newest first — the Action filter, which is a prefix match, so the
-- index serves both the exact action and the `LIKE 'ASSESSMENT_%'` range the action-type groups use.
CREATE INDEX audit_logs_action_created_index ON audit_logs (action, created_at);

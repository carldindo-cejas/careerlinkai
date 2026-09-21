-- Migration 0037 — counselor-owned assessment versions, copy lineage, and how a version is delivered
--
-- Prompt-driven (2026-09-17). Four additive columns and two data corrections. Nothing is dropped,
-- nothing is rewritten that a result depends on, and every existing row stays valid under the new
-- defaults — see the note on each column for why its default is the honest reading of history.
--
-- ## What was already here, and is deliberately not duplicated
--
-- The prompt asks for an explicit ownership/author relationship (`authorType` / `authorId`). This
-- schema has carried exactly that since migration 0005, under different names:
--
--     assessment_templates.ownership   GLOBAL | COUNSELOR_PRIVATE   -- the authorType
--     assessment_templates.creator_id  → users(id)                  -- the authorId
--
-- A GLOBAL template is administrator-owned curated content; a COUNSELOR_PRIVATE one belongs to the
-- counselor named by `creator_id`. Adding an `author_type` column beside `ownership` would create a
-- second opinion about the same fact, and the day the two disagree is the day a private assessment
-- leaks. So the existing pair *is* the ownership model, and what this migration adds is the three
-- things it genuinely lacked: where a copy came from, how the instrument is presented, and what
-- order one student actually saw.
--
-- ## 1. Copy lineage
--
-- A counselor copying RIASEC gets a **new template** (their own, private, DRAFT v1) rather than a
-- branch of the administrator's. That is what makes ownership isolation expressible at all — the
-- unit every policy, list and assignment already scopes on is the template. But a copy with no
-- record of its origin is indistinguishable from something typed from scratch, so both levels carry
-- a self-referencing pointer:
--
--   * `assessment_templates.source_template_id` — "this instrument was copied from that one".
--   * `assessment_versions.source_version_id`   — "these questions were copied from that version".
--
-- The version-level column also back-fills a gap that predates this prompt: `duplicateVersion`
-- (the Edit-a-copy path) has always produced an untraceable draft.
--
-- ON DELETE SET NULL on both: templates are soft-deleted (§12) so this is defensive, but a lineage
-- pointer must never be the reason a row cannot be removed, and "copied from something that is no
-- longer here" is a truthful state.
--
-- ## 2. Presentation mode — on the template, not the version
--
-- `SEQUENTIAL | RANDOM`, and the placement is the whole design decision.
--
-- A version is **frozen at publish** (invariant 4): every write to a PUBLISHED version is rejected
-- in the Service layer, because the version's content is what a delivered result means. Putting
-- delivery order there would mean RIASEC could never be switched to random without publishing a v2
-- — which is precisely the "open multiple configuration screens" the prompt is asking us to remove.
--
-- And it belongs on the template because it is **not part of what a result means**. Order does not
-- enter scoring anywhere: `ScoringService` reads `assessment_answers.score` joined to
-- `question_dimensions`, neither of which knows the sequence an item was shown in. A student who
-- saw the sixty RIASEC items shuffled and one who saw them in order are scored by identical
-- arithmetic. So this is a delivery setting about the instrument, editable at any time, and the
-- historical record of what one student actually saw lives in the attempt (see 3).
--
-- Defaults to SEQUENTIAL, which is what every existing attempt in fact received.
--
-- ## 3. The attempt's own question order
--
-- Randomizing per attempt is only correct if the order is **stable for that attempt**: Previous
-- must not reshuffle, a refresh must not re-deal, and a result read back years later must be able
-- to state the order the student was asked in. So the order is dealt once, at `start`, and stored.
--
-- A JSON array of question ids, on the attempt. Not a join table: this is one opaque value read
-- whole by exactly one code path (`loadAttemptContent`) and never queried across rows, which is the
-- same reasoning `assessment_versions.scoring_config` is JSON for.
--
-- **NULL means "as authored"**, and that is the honest backfill rather than a shortcut. Every
-- attempt that exists today was delivered in `order_number` order, and writing out an explicit
-- array for each of them would be inventing a record of a decision nobody made.

ALTER TABLE assessment_templates
    ADD COLUMN source_template_id TEXT REFERENCES assessment_templates (id) ON DELETE SET NULL;

-- SQLite cannot add a column with a non-constant default or a table-level CHECK, so the constraint
-- is written inline on the column — which ALTER TABLE ... ADD COLUMN does accept. The string-literal
-- union in `src/db/enums.ts` (`PRESENTATION_MODES`) is the same rule for the type checker; §12 says
-- keep the two in lockstep.
ALTER TABLE assessment_templates
    ADD COLUMN presentation_mode TEXT NOT NULL DEFAULT 'SEQUENTIAL'
        CHECK (presentation_mode IN ('SEQUENTIAL', 'RANDOM'));

ALTER TABLE assessment_versions
    ADD COLUMN source_version_id TEXT REFERENCES assessment_versions (id) ON DELETE SET NULL;

ALTER TABLE assessment_attempts
    ADD COLUMN question_order TEXT;

-- The copy lists ("which of my assessments came from RIASEC") and the counselor's own list are both
-- served by this; the version-level pointer is read one row at a time and needs no index.
CREATE INDEX assessment_templates_source_template_id_index
    ON assessment_templates (source_template_id);


-- ## 4. The Likert scale is presented positive-first
--
-- Prompt §8A. Both curated instruments are 5-point Likert, and both were seeded Strongly Disagree
-- first — `order_number` 1..5 running 1,2,3,4,5 in score. The requested presentation is the
-- reverse: Strongly Agree (5) at the top, Strongly Disagree (1) at the bottom, on every surface.
--
-- **This is done in the data rather than by sorting in a serializer, and that is deliberate.** The
-- player is served options *without their scores* (§37, `serializeQuestion` — a student who can see
-- that Strongly Agree is worth 5 stops answering an interest inventory), so a "sort by score
-- descending" in the player would have to reach for a column the payload exists to withhold. And
-- three other surfaces render the same options — the builder, the preview, the printed answer
-- appendix — each of which would need its own copy of the rule. `order_number` is the one place
-- that already means "the order these are shown in", and every surface already reads it.
--
-- ### Is this a write to a frozen version?
--
-- It is a write beneath one, and it is the one kind that invariant 4 is not about. The freeze
-- exists so that "editing a template can never retroactively alter a student's historical result".
-- Nothing here can:
--
--   * `question_options.score` is untouched. Strongly Agree is 5 before and after.
--   * `question_options.value` is untouched — it is the stored answer key, and migration 0021 made
--     it unique per question.
--   * `assessment_answers.score` is a **server-side snapshot** taken at the moment of answering
--     (§13.5) and is never re-derived from a live join, so no completed attempt can move.
--   * `assessment_answers.selected_option_id` still points at the same option row.
--
-- What changes is the position an option is drawn at, which no result, score, band or recommendation
-- reads. Re-running `interpretation-bands` / `report` against a pre-migration attempt yields
-- byte-identical output; `test/assessment/likert-presentation.test.ts` asserts exactly that.
--
-- Scoped to RIASEC and SCCT, as the prompt scopes it. A CUSTOM instrument's option order is its
-- author's decision and is left alone.
UPDATE question_options
SET order_number = CASE CAST(score AS INTEGER)
                       WHEN 5 THEN 1
                       WHEN 4 THEN 2
                       WHEN 3 THEN 3
                       WHEN 2 THEN 4
                       WHEN 1 THEN 5
                   END
WHERE question_id IN (
    SELECT q.id
      FROM assessment_questions q
      JOIN assessment_versions v  ON v.id = q.assessment_version_id
      JOIN assessment_templates t ON t.id = v.assessment_template_id
     WHERE t.category IN ('RIASEC', 'SCCT')
       AND q.question_type = 'LIKERT'
)
-- Only a canonical 1–5 integer scale is reordered. A CUSTOM-style rescaling that somehow reached a
-- curated instrument would otherwise have every option collapsed to NULL by the CASE above, which
-- is a far worse outcome than being left in its authored order.
AND CAST(score AS INTEGER) IN (1, 2, 3, 4, 5)
AND CAST(score AS INTEGER) = score;

-- The midpoint anchor, named as §8A names it. "Neutral" and "Neither Agree nor Disagree" are the
-- same point on the same scale — the score is 3 either way — so this renames a label, it does not
-- redefine a response. Restricted to the curated instruments and to options that actually score 3,
-- so a CUSTOM question whose author wrote "Neutral" to mean something else is untouched.
UPDATE question_options
SET label = 'Neither Agree nor Disagree'
WHERE label = 'Neutral'
  AND CAST(score AS INTEGER) = 3
  AND question_id IN (
    SELECT q.id
      FROM assessment_questions q
      JOIN assessment_versions v  ON v.id = q.assessment_version_id
      JOIN assessment_templates t ON t.id = v.assessment_template_id
     WHERE t.category IN ('RIASEC', 'SCCT')
       AND q.question_type = 'LIKERT'
);

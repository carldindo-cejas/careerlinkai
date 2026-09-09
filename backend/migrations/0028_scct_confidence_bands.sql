-- Migration 0028 — SCCT dimensions stop reporting a student's confidence as an interest
--
-- Found by driving the live site as a student. Finishing the SCCT Career Confidence Scale on
-- careerlinkai.online produced this breakdown, under a heading reading "YOUR CAREER CONFIDENCE"
-- and a summary reading "Moderately High Career Confidence.":
--
--   SE  Self-Efficacy          78 out of 100 · High Interest
--   OE  Outcome Expectations   80 out of 100 · High Interest
--   GO  Goal Orientation       82 out of 100 · High Interest
--
-- `interpretation` is stored text, banded at scoring time from this column (`lib/scoring.ts`), and
-- `seedScct` had handed all three SCCT dimensions `INTEREST_BANDS` — the six-type interest bands
-- §22 defines for RIASEC — instead of the confidence bands sitting four lines above them in the
-- same file and already used for this instrument's composite summary.
--
-- It is a real error, not a wording preference. Interest is what the *other* instrument measures;
-- self-efficacy is a belief about your own ability, and there is no such thing as a high or low
-- interest in one. §55 makes Dimension terminology enforced rather than advisory precisely here:
-- the two instruments answer different questions, and a student who reads their SCCT breakdown as
-- a second interest profile has been told something false about themselves by the screen that
-- exists to tell them something true.
--
-- ## Why a migration, when `assessment_dimensions` rows are frozen (§12, v1.2)
--
-- The freeze is a Service-layer rule and it is the right one: sliding a band from 67 to 60 would
-- silently rewrite the label on results already delivered, so no *user* may edit these rows once
-- any version of their template is published. That rule exists to stop a human quietly changing
-- what a delivered result meant. It cannot also be the reason a seeding defect stays on a live
-- student's screen forever — and this correction is the opposite of the case the freeze guards:
-- it does not move a threshold, it renames the bands at thresholds that do not move.
--
-- A migration is the honest vehicle for that. `seed-instruments` is idempotent by title and skips
-- an installed template, so fixing `instruments.ts` alone fixes only deployments that have not
-- installed the instruments yet — which is no deployment that has ever been used.
--
-- ## What this does and does not change
--
-- **Does not** touch `dimension_scores`. Every `interpretation` already written stays exactly as
-- it was written: those rows are historical evidence of what a student was told on the day
-- (§12 — the attempt/answer/result chain is never rewritten), and re-banding them retroactively is
-- the very thing the freeze rule forbids. Students who sat the SCCT before this migration keep
-- "High Interest" on their stored result; students who sit it afterwards get "High Confidence".
-- That seam is visible and is the correct trade: a wrong label already delivered is a fact about
-- what happened, and quietly editing history to hide it would be worse than the seam.
--
-- **Does not** change any score, band boundary, ranking, or the SCCT confidence index — the four
-- cut points below are `CONFIDENCE_BANDS`', already in use for this template's composite summary
-- since it was seeded. The breakdown and the sentence above it now read off one scale rather than
-- two, which is the other half of the defect.
--
-- ## Scoping
--
-- Narrowed three ways so re-running is a no-op and nothing else in the schema is in range:
--
--   * `category = 'SCCT'` — the reserved, globally-curated template (§22, §23). A counselor's
--     CUSTOM instrument may legitimately band anything however it likes and is not touched.
--   * `code IN ('SE','OE','GO')` — the three dimensions `seedScct` creates, and the unique index
--     on (assessment_template_id, code) means there is at most one of each.
--   * `LIKE '%Interest%'` — only rows still carrying the wrong bands. Matching on the defect
--     rather than on an exact JSON string keeps this idempotent and independent of key order or
--     whitespace in however the value was serialized.

UPDATE assessment_dimensions
SET interpretation_ranges = '[{"min":0,"max":33.99,"label":"Low Confidence"},{"min":34,"max":66.99,"label":"Moderate Confidence"},{"min":67,"max":79.99,"label":"Moderately High Confidence"},{"min":80,"max":100,"label":"High Confidence"}]'
WHERE code IN ('SE', 'OE', 'GO')
  AND interpretation_ranges LIKE '%Interest%'
  AND assessment_template_id IN (
      SELECT id FROM assessment_templates WHERE category = 'SCCT'
  );

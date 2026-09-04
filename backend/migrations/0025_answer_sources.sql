-- Migration 0025 — Show the student where the answer came from (AiNormalisation Phase 3)
--
-- §3's grounding contract ends with the check a person performs rather than the code: every AI
-- answer names the material behind it — *"Based on: 2026 Admissions Handbook"* — under the
-- paragraph the student reads.
--
-- That is not decoration. It is the last line of defence and the cheapest one:
--
--   * A student who can see where an answer came from can judge it. A counselor reviewing a
--     complaint can check it against the same document in seconds.
--   * An answer with **no** visible source is visibly not a fact. The absence is the signal —
--     which is why the deterministic fallback carries no sources and should not.
--
-- Stored rather than computed on read, for both tables, because the provenance is a fact about the
-- moment of generation: the corpus changes, entries are edited and archived, and an answer written
-- in September must keep naming what it was actually written from. `ai_requests.input_context`
-- already holds the chunk ids for audit (§13.7); this is the human-readable half of the same
-- record, denormalized so rendering a transcript is one query rather than one per message.
--
-- JSON array of titles in a TEXT column, matching how `ai_requests.input_context` already stores
-- structured data in this schema. NULL means "no sources", which is the correct and common state:
-- a deterministic reply, a Gate 1 verbatim answer before this shipped, an older row.

ALTER TABLE chat_messages ADD COLUMN sources TEXT;

ALTER TABLE recommendation_explanations ADD COLUMN sources TEXT;

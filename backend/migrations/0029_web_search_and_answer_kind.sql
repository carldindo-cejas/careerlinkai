-- Migration 0029 — the two fallback tiers below the knowledge base, and the column that says
-- which tier answered
--
-- Prompt-driven (2026-09-05), extending FULLPLAN §30. The plan's chat pipeline has two sources —
-- the admin's own Q&A entries (Gate 1) and the school's knowledge corpus (Gate 2) — and refuses
-- when neither covers a question. Measured on production, that refusal is most of what students
-- get: `/admin/ai-insights` reported 20 of 96 careers and **0 of 202 programs** covered, and a
-- corpus of auto-generated catalog blurbs was never going to answer "when do applications close?"
-- however well it is synced.
--
-- So two tiers are added below Gate 2, and this migration is the state they need.
--
-- ## `ai_policies` — the two switches
--
-- Invariant 5: *AI policies are database-driven. Never hardcode a guardrail.* These are guardrails
-- — they decide whether a student can be shown a sentence that is not drawn from the school's own
-- materials — so they live beside the governance text an admin already edits, not in a `[vars]`
-- block that needs a deploy to change. An admin who sees a bad answer can switch the tier off
-- while they investigate.
--
-- Both default to 1 because this migration ships the feature that was asked for; the web tier is
-- additionally inert until `SERPER_API_KEY` is set, so on a deployment with no key the default
-- changes nothing.
--
-- Note the deliberate asymmetry with `is_active`: an *inactive* policy row injects empty governance
-- text but does not disable the assistant. These two flags are read from the active row only, and
-- when there is no active row both read as **off** — the safe direction, since the tier that needs
-- governing most is the one with no grounding behind it.
--
-- ## `chat_messages.answer_kind` — which gate produced this
--
-- Until now the panel inferred it: `ai_request_id IS NULL` meant "deterministic fallback". That
-- inference was already wrong before this change — it is equally the state of a Gate 1 answer,
-- which is an admin's own words with a named source and the best answer the system can give — and
-- adding two tiers makes it unrecoverable, because "generated, with no sources" would now mean
-- either "answered from the student's own computed results" or "answered from the model's general
-- knowledge", which are not remotely the same claim to put in front of a student.
--
-- A student is entitled to know which of those they are reading, so it is recorded rather than
-- guessed. Five values, `CHECK`-constrained (D1 has no ENUM):
--
--   CURATED    Gate 1 — an admin's answer, verbatim, no model involved.
--   KNOWLEDGE  Gate 2 — grounded in the school's corpus and/or the student's own results.
--   WEB        Gate 3 — grounded in web pages, cited, with the domains named under the answer.
--   GENERAL    Gate 4 — the model's own knowledge. No grounding, and labelled as such on screen.
--   CANNED     Not generated at all: off-domain, no coverage, or the model was unavailable.
--
-- NULL for every user message and for every assistant message written before this migration. The
-- panel treats NULL exactly as it treated these rows yesterday, so no historical transcript
-- suddenly acquires a claim about where it came from that nobody recorded at the time.

ALTER TABLE ai_policies ADD COLUMN web_search_enabled INTEGER NOT NULL DEFAULT 1;

ALTER TABLE ai_policies ADD COLUMN general_knowledge_enabled INTEGER NOT NULL DEFAULT 1;

ALTER TABLE chat_messages ADD COLUMN answer_kind TEXT
    CHECK (answer_kind IN ('CURATED', 'KNOWLEDGE', 'WEB', 'GENERAL', 'CANNED'));

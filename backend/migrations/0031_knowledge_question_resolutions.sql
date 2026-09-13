-- Migration 0031 — the backlog learns what has already been dealt with
--
-- Prompt-driven (2026-09-11), closing the loop AiNormalisation Phase 4 opened.
--
-- ## The bug this fixes
--
-- `/admin/ai-insights` builds its "unanswered questions" list out of two things that have always
-- been written and never been *retracted*:
--
--   * `ai_requests` rows that FAILED with SKIPPED / NO_GROUNDING — one per honest refusal, and
--   * `chat_messages.knowledge_request = 'REQUESTED'` — one per student who pressed the button.
--
-- Both are records of something that happened in the past, and neither can ever stop being true.
-- So when an admin pressed **Answer this**, wrote the Q&A entry, and saved it, the corpus gained
-- the answer and the report lost nothing: the question sat there, at the top of the list, with its
-- ask count intact, indistinguishable from the ones nobody had touched. The only way to tell
-- whether a row had been dealt with was to remember, and the backlog is exactly the screen nobody
-- should have to hold in their head.
--
-- The missing fact was never "is this covered now?" — it is "did a person decide this was done?".
-- That is a new fact about a *question*, not about a request or a message, so it gets its own row
-- rather than a column on either of the tables above. Two further reasons it cannot be a column:
-- one question is many `ai_requests` rows (that is the whole point of the grouping), and a question
-- can be resolved before it is next asked, when no row to flag exists yet.
--
-- ## Why the key is normalised text rather than an id
--
-- There is no question entity in this system. A question is text, arrived at two different ways:
-- the refusal list groups on `ai_requests.input_context.retrieval_query`, while the student-request
-- list groups on the raw preceding `chat_messages.content`. Those two strings are usually the same
-- sentence and almost never byte-identical — different capitalisation, a trailing "?", a stray
-- space. Before this migration that mismatch was already a live (if quiet) bug: the same question
-- could appear twice in one report, once from each list, because the merge compared raw text.
--
-- `question_key` is that text run through one normalisation, and the normalisation is defined in
-- SQL — `rtrim(lower(trim(x)), ' ?.!')` — so the value stored here and the value computed over
-- `ai_requests` at read time come from *the same expression*, not from two implementations that
-- have to be kept in agreement. A JS-side normaliser writing the key and a SQL-side one matching it
-- is precisely the kind of pair that drifts one refactor later and fails silently, by showing a
-- resolved question again forever.
--
-- The key is UNIQUE. Two people answering the same question at the same moment is a realistic race
-- on a shared backlog, and the constraint is what turns it into an upsert rather than two rows that
-- disagree about who resolved it.
--
-- ## Why a resolution can expire on its own
--
-- Nothing here is a tombstone. The read applies three conditions, and a resolution that fails any
-- of them stops suppressing its question — no cleanup job, no reconciliation cron:
--
--   1. **The answering entry was archived.** `document_id` is the entry that was written; if an
--      admin later archives it, its vectors leave the index (§13.7) and the question is genuinely
--      unanswered again. It returns to the backlog.
--   2. **The answering entry failed to process.** A FAILED document is text that exists and is not
--      retrievable — it looks healthy in every other list. Without this condition, a failed
--      ingestion would *silently* remove the question from the one screen that would have shown
--      the gap, which is the worst available outcome: the admin believes it is answered, the
--      student still gets a refusal, and nothing anywhere says so.
--   3. **It was asked again afterwards.** The read only counts `ai_requests` rows newer than
--      `created_at` here. An answer that exists but is not being retrieved therefore comes back by
--      itself, carrying only the new asks — which is a far more useful signal than the original
--      gap was, because it means the writing is done and the *retrieval* is what needs looking at.
--
-- `DISMISSED` is the one resolution that does not expire, because it has no document to expire
-- with. It is for gibberish, tests and off-topic questions — the rows that would otherwise sit in
-- the backlog forever, since nobody will ever write an entry for "asdfgh". It is reversible from
-- the UI (delete the row) so a misclick costs nothing.

CREATE TABLE knowledge_question_resolutions (
    id TEXT PRIMARY KEY NOT NULL,

    -- The join key: `rtrim(lower(trim(question)), ' ?.!')`, written by the service through the
    -- same SQL expression the read uses. Never write this from application code.
    question_key TEXT NOT NULL,

    -- The question as a human last saw it, kept for display. `question_key` is lossy on purpose
    -- and is not something to show anybody.
    question TEXT NOT NULL,

    --   ANSWERED   An entry was written for it. `document_id` names the entry, and conditions 1
    --              and 2 above are read through it.
    --   DISMISSED  A person judged it not worth answering. No document, and no expiry.
    resolution TEXT NOT NULL CHECK (resolution IN ('ANSWERED', 'DISMISSED')),

    -- NULL for DISMISSED, and nullable rather than NOT NULL for ANSWERED too: the entry is created
    -- first and the resolution second (see `resolveQuestion`), so that a failure between the two
    -- leaves the answer in the corpus and the question in the backlog — annoying, and the right
    -- direction to fail in. A resolution pointing at nothing is treated as not covering anything.
    document_id TEXT REFERENCES knowledge_documents(id),

    -- Who decided. The admin screen shows it, and it is what scopes a counselor's "questions I
    -- answered" list — so it is the attribution the second half of this feature is built on.
    resolved_by TEXT NOT NULL REFERENCES users(id),

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One resolution per question. This is the constraint that makes concurrent answering safe: the
-- second writer upserts over the first instead of creating a duplicate the read would have to
-- de-duplicate (and would have to pick a winner from, with no principled way to choose).
CREATE UNIQUE INDEX knowledge_question_resolutions_key_unique
    ON knowledge_question_resolutions (question_key);

-- "What have I answered?" — the counselor's own contribution list, and the admin's who-did-what.
CREATE INDEX knowledge_question_resolutions_resolved_by_index
    ON knowledge_question_resolutions (resolved_by, created_at);

-- Archiving an entry has to find the resolutions that depend on it. Without this index that is a
-- table scan on every archive.
CREATE INDEX knowledge_question_resolutions_document_index
    ON knowledge_question_resolutions (document_id);

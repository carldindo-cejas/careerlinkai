-- Migration 0030 — "Request to add to knowledge": a student asking for the gap to be filled
--
-- Prompt-driven (2026-09-09), extending AiNormalisation Phase 4.
--
-- ## The gap this closes
--
-- When nothing in the corpus covers a question, `ChatService` refuses honestly and logs a SKIPPED
-- `ai_requests` row carrying the question — which `/admin/ai-insights` already reads back as the
-- "unanswered questions" backlog. That much has worked since Phase 5a, and it works *silently*:
-- the student is told to go and ask their counselor, and has no way to know their question was
-- recorded at all, let alone to say "yes, please answer this one".
--
-- So the refusal gets a button, and the button needs a place to write to. One nullable column,
-- exactly the shape `feedback` (migration 0026) already uses for the other student-side signal on
-- this table, and for the same reasons: one value per message, given by the one student who can
-- see that message, with every other field already on the row or reachable through it.
--
-- ## Why two values rather than a boolean
--
--   OFFERED    This answer was a no-coverage refusal. Written by the service at the moment the
--              answer is stored, so the panel can offer the button on a transcript reloaded days
--              later rather than re-deriving it by matching the reply text — which would break the
--              first time somebody reworded the sentence.
--   REQUESTED  The student pressed it. This is the signal an admin acts on.
--
-- NULL is every other message: user turns, generated answers, off-domain redirects, Gate 1
-- answers, and every assistant message written before this migration. As with 0026 and 0029, no
-- historical row acquires a claim nobody recorded at the time — an old refusal simply does not
-- offer the button, which is the honest reading of "we did not record what this was".
--
-- One direction only, like `feedback`: there is no un-request. The request is a backlog item, and
-- an item that can vanish before an admin has looked at it is worse than a stale one.

ALTER TABLE chat_messages ADD COLUMN knowledge_request TEXT
    CHECK (knowledge_request IN ('OFFERED', 'REQUESTED'));

-- The admin queue reads exactly this: requested rows, newest first. Partial, because the rows that
-- matter are a vanishing fraction of the table and an index over the NULLs would be dead weight.
CREATE INDEX chat_messages_knowledge_request_index
    ON chat_messages (knowledge_request, created_at)
    WHERE knowledge_request = 'REQUESTED';

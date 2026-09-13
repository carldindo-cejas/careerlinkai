-- Migration 0026 — Answer feedback (AiNormalisation Phase 4)
--
-- A thumbs-down on a chat answer. One nullable column, and it closes the last gap in the flywheel.
--
-- ## Why a column and not a table
--
-- The obvious shape is `answer_feedback (id, message_id, user_id, verdict, created_at)`. It is the
-- wrong one here: feedback is one value per message, given by the one student who can see that
-- message, and every field that table would add is already on `chat_messages` or reachable through
-- its conversation. A join table would buy a second write, a second index and a second thing to
-- keep consistent, in exchange for a many-to-many nobody has.
--
-- ## Why only down, and why it is enough
--
-- There is no `UP`. A thumbs-up on an answer nobody has questioned tells an admin nothing they can
-- act on, and asking students to rate answers is asking them to do the system's job. A thumbs-down
-- is different: it is a student saying *this was wrong*, on a specific answer, whose retrieved
-- chunk ids are already recorded on its `ai_requests` row (§13.7). That makes it the one signal
-- that leads straight to a fix — the admin reads the answer, follows the provenance to the passage
-- that produced it, and corrects or archives that entry.
--
-- NULL is "no feedback", which is and should remain the overwhelmingly common state.

ALTER TABLE chat_messages ADD COLUMN feedback TEXT;

-- The admin review queue reads exactly this: flagged messages, newest first. Partial, because the
-- rows that matter are a vanishing fraction of the table and an index over the NULLs would be
-- almost entirely dead weight.
CREATE INDEX chat_messages_feedback_index
    ON chat_messages (feedback, created_at)
    WHERE feedback IS NOT NULL;

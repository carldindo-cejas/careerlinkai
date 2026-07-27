-- Migration 0019 — The recommendation chat assistant (prompt-driven extension, 2026-07-27)
--
-- The §37 recommendations screen gains an assistant a student can ask about their own results.
-- Two tables: a conversation per student, and its messages.
--
-- ## Why history is a table and not client state
--
-- A chat whose history lives in React state is a chat that resets on refresh — on a shared school
-- computer, which is the machine this system is actually used on, that is most of the time. It also
-- puts the entire transcript on the wire on every turn, where the §40 rule that only named,
-- whitelisted fields reach a prompt cannot be enforced, and it makes the conversation unauditable:
-- §29 principle 6 requires every model call to be a row, and a call whose inputs the server never
-- saw cannot honestly be one.
--
-- ## What is not here
--
-- No `ai_policy_id`, no per-message token counts, no embeddings of the transcript. Every model call
-- this feature makes still lands in `ai_requests` exactly like §30's explanation path, with its
-- retrieved chunk ids in `input_context` — that table remains the single audit trail for AI usage
-- (§13.7), and `chat_messages.ai_request_id` is the pointer into it rather than a second copy of it.
--
-- Conventions as everywhere else (§12, §15): UUID v4 PKs, TEXT columns, ISO-8601 UTC timestamps,
-- every FK indexed.

CREATE TABLE chat_conversations (
    id         TEXT PRIMARY KEY NOT NULL,
    -- CASCADE, unlike most FKs in this schema: a deleted student's chat about their own
    -- recommendations has no meaning without them and is not audit material (`ai_requests` is).
    student_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    /**
     * Which recommendation set this conversation is about. Nullable and `ON DELETE SET NULL`:
     * regenerating recommendations replaces the rows (§20) but must not silently delete the
     * conversation a student had about the previous set — the transcript stays readable, anchored
     * to a result that no longer exists, which is the honest shape of what happened.
     */
    assessment_result_id TEXT REFERENCES assessment_results (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX chat_conversations_student_id_index ON chat_conversations (student_id);
-- The one query this table serves: "my most recent conversation".
CREATE INDEX chat_conversations_student_updated_index ON chat_conversations (student_id, updated_at);

CREATE TABLE chat_messages (
    id              TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES chat_conversations (id) ON DELETE CASCADE,
    -- Only the two roles a transcript contains. The system prompt is **not** stored per message:
    -- it is assembled from the prompt module plus the active AI policy at call time (§32), so a
    -- stored copy would be a stale duplicate of a thing that is meant to be editable in one place.
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content         TEXT NOT NULL,
    /**
     * The `ai_requests` row this assistant message came from — the provenance link (§13.7). NULL on
     * every user message, and also on an assistant message that is the deterministic fallback
     * rather than a generation (§29: the fallback is not a model output and must not be recorded
     * as one).
     */
    ai_request_id   TEXT REFERENCES ai_requests (id) ON DELETE SET NULL,
    created_at      TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX chat_messages_conversation_id_index ON chat_messages (conversation_id);
-- Transcript order. `created_at` alone is not enough at sub-millisecond insert rates, so the id
-- is the tie-break — arbitrary but stable, which is all ordering needs to be reproducible (§26).
CREATE INDEX chat_messages_conversation_created_index ON chat_messages (conversation_id, created_at, id);
CREATE INDEX chat_messages_ai_request_id_index ON chat_messages (ai_request_id);

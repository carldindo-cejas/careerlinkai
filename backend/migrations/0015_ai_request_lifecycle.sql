-- `ai_requests` becomes a **lifecycle** row instead of a completion receipt (§20, §29, §42).
--
-- ── The bug this migration exists to close ─────────────────────────────────────────────────
-- Until now the gateway wrote exactly one row, *after* the model answered. The §20 poll
-- (`GET /ai/requests/{id}/status`) therefore derived PENDING from the **absence of a row**, and
-- that made four completely different situations indistinguishable, forever:
--
--     * the job is sitting in the queue        (legitimately pending)
--     * the job is running right now           (legitimately pending)
--     * the message was never consumed         (lost — no consumer, DLQ, expired retention)
--     * the id never existed                   (bogus)
--
-- The first two resolve; the last two never do, and the frontend polled a permanent PENDING
-- until the tab closed. "No row yet" cannot be the encoding of "in flight" when the thing that
-- writes the row is the same thing that might never run.
--
-- So the row is now created at **enqueue** time, by the endpoint, before the message is sent —
-- and the job advances it. PENDING → PROCESSING → SUCCESS | FAILED. A row that exists but has
-- not moved is now a *fact* the system can see and time out, which is what makes the stale
-- sweep in `jobs/cleanup.ts` and the deadline in `statusFor` possible at all.
--
-- ── `failure_reason` gets its own column ───────────────────────────────────────────────────
-- It used to be tucked inside the `input_context` JSON blob, which meant the one field an
-- operator actually greps for ("why did this fail?") was the one field SQL could not filter on,
-- and it shared a column whose documented purpose is provenance — what the model was *shown*,
-- not what went wrong. §12 admits JSON for the former and not for the latter. Legacy rows are
-- backfilled out of the blob below, so nothing is lost.
--
-- SQLite cannot widen a CHECK constraint in place, so this is the standard table rebuild. It is
-- safe here specifically because **nothing declares a foreign key onto `ai_requests`** —
-- `assessment_questions.source_ai_request_id` points at it by convention only (see the note in
-- 0005), so the DROP cannot orphan a constraint.

CREATE TABLE ai_requests_rebuilt (
    id            TEXT PRIMARY KEY NOT NULL,
    -- Nullable: a system-triggered request (the queued explanation job) has no acting user.
    user_id       TEXT REFERENCES users (id) ON DELETE SET NULL,
    request_type  TEXT NOT NULL
        CHECK (request_type IN ('RECOMMENDATION_EXPLANATION', 'ASSESSMENT_GENERATION', 'CHAT')),
    -- Retrieved chunk ids + prompt variables, for auditability (§13.7): what the model was
    -- shown, recoverable after the fact. JSON is allowed here by §12 — this is provenance
    -- configuration, not a queryable business field.
    input_context TEXT,
    response_text TEXT,
    model         TEXT,
    tokens_used   INTEGER,
    latency_ms    INTEGER,
    -- Four states, not two. PENDING is written by the endpoint that enqueues; PROCESSING by the
    -- consumer that picks the job up; SUCCESS/FAILED are terminal. A synchronous caller (the §30
    -- explanation path) still writes a single terminal row and never occupies the middle two —
    -- the lifecycle is available, not compulsory.
    status        TEXT NOT NULL
        CHECK (status IN ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED')),
    -- The §30 taxonomy verbatim (`QUOTA_EXHAUSTED: …`), or the stage that threw. NULL unless
    -- the row is FAILED.
    failure_reason TEXT,
    created_at    TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    -- When the row last changed state. `created_at` alone cannot answer "has this been stuck?"
    -- once a row is allowed to live through more than one status.
    updated_at    TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- Every historical row is terminal by construction (the old CHECK allowed nothing else), so
-- `updated_at` is truthfully `created_at`. `json_valid` guards the extract: a malformed blob
-- would otherwise abort the whole migration rather than simply having no reason to recover.
INSERT INTO ai_requests_rebuilt (
    id, user_id, request_type, input_context, response_text, model,
    tokens_used, latency_ms, status, failure_reason, created_at, updated_at
)
SELECT
    id, user_id, request_type, input_context, response_text, model,
    tokens_used, latency_ms, status,
    CASE WHEN json_valid(input_context)
         THEN json_extract(input_context, '$.failure_reason')
    END,
    created_at, created_at
FROM ai_requests;

DROP TABLE ai_requests;

ALTER TABLE ai_requests_rebuilt RENAME TO ai_requests;

CREATE INDEX ai_requests_user_id_index ON ai_requests (user_id);
-- §15: dashboard queries and the per-user AI rate-limit check both read this pair.
CREATE INDEX ai_requests_user_created_index ON ai_requests (user_id, created_at);
-- The nightly stale sweep reads exactly this pair: non-terminal rows older than the deadline.
CREATE INDEX ai_requests_status_updated_index ON ai_requests (status, updated_at);

-- Migration 0008 — the AI / Knowledge module (FULLPLAN §13.7, Phase 5a).
--
-- Four tables, and a boundary worth stating up front: nothing in this module ever computes a
-- number a student sees. `knowledge_documents`/`knowledge_chunks` are the retrieval corpus for
-- the §30 RAG pipeline; `ai_requests` is the audit trail of every model call; `ai_policies` is
-- the admin-editable text injected into every prompt (§32). The deterministic engine (§24, §27)
-- reads none of these.
--
-- The embeddings themselves live in Cloudflare Vectorize, never in D1 — `knowledge_chunks`
-- holds only the `vector_id` pointer (§13.7).

CREATE TABLE knowledge_documents (
    id                TEXT PRIMARY KEY NOT NULL,
    uploaded_by       TEXT NOT NULL REFERENCES users (id),
    file_name         TEXT NOT NULL,
    file_type         TEXT NOT NULL CHECK (file_type IN ('pdf', 'docx')),
    -- The R2 object key. The raw file is retained for provenance: extraction happens in the
    -- admin's browser (§33, v1.5 — the Free plan has no server-side CPU home for a parser),
    -- so the original must stay available to settle any extraction dispute.
    storage_path      TEXT NOT NULL,
    processing_status TEXT NOT NULL DEFAULT 'UPLOADED'
        CHECK (processing_status IN ('UPLOADED', 'PROCESSING', 'COMPLETED', 'FAILED')),
    -- v1 uses only GLOBAL (v1.2): COUNSELOR_PRIVATE shipped in v1.1 with no retrieval-scoping
    -- rule, which made it a cross-tenant leak waiting to happen; it is deferred to §63. The
    -- CHECK keeps the enum shape so restoring the value later is not a migration.
    visibility        TEXT NOT NULL DEFAULT 'GLOBAL'
        CHECK (visibility IN ('GLOBAL', 'COUNSELOR_PRIVATE')),
    -- Archived, never hard-deleted (§13.7, v1.2). On archive the chunks' vectors leave
    -- Vectorize — archived content becomes structurally unretrievable — while the rows stay,
    -- because ai_requests.input_context references chunk ids for provenance.
    archived_at       TEXT,
    created_at        TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at        TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX knowledge_documents_uploaded_by_index ON knowledge_documents (uploaded_by);
CREATE INDEX knowledge_documents_processing_status_index ON knowledge_documents (processing_status);

CREATE TABLE knowledge_chunks (
    id           TEXT PRIMARY KEY NOT NULL,
    document_id  TEXT NOT NULL REFERENCES knowledge_documents (id) ON DELETE CASCADE,
    chunk_number INTEGER NOT NULL,
    -- 300–800 tokens per chunk with 50–100 of overlap (§33). The content stays in D1; only
    -- the embedding goes to Vectorize, keyed back here by vector_id.
    content      TEXT NOT NULL,
    -- NULL until the chunk's embedding batch lands. `GenerateEmbeddingJob` checks for an
    -- existing vector_id before re-embedding — that is what makes it idempotent (§43).
    vector_id    TEXT,
    token_count  INTEGER,
    created_at   TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX knowledge_chunks_document_id_index ON knowledge_chunks (document_id);
CREATE UNIQUE INDEX knowledge_chunks_document_number_unique
    ON knowledge_chunks (document_id, chunk_number);

CREATE TABLE ai_requests (
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
    -- Exactly one row per gateway call, success or failure, no exceptions (§29 principle 6).
    -- A quota-exhausted call is a FAILED row like any other model failure (§30 v1.5) — never
    -- a retry into a dead quota.
    status        TEXT NOT NULL CHECK (status IN ('SUCCESS', 'FAILED')),
    created_at    TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX ai_requests_user_id_index ON ai_requests (user_id);
-- §15: dashboard queries and the per-user AI rate-limit check both read this pair.
CREATE INDEX ai_requests_user_created_index ON ai_requests (user_id, created_at);

CREATE TABLE ai_policies (
    id           TEXT PRIMARY KEY NOT NULL,
    -- GLOBAL is the only value used in v1; the column is designed to extend to finer scopes
    -- later (§63) without a schema change.
    scope        TEXT NOT NULL DEFAULT 'GLOBAL' CHECK (scope IN ('GLOBAL')),
    -- Admin-authored guidance appended to every AI system prompt (§32),
    -- e.g. "Always mention that recommendations are not final decisions."
    instructions TEXT,
    -- Admin-authored constraints, e.g. "Never reference documents tagged internal-only."
    restrictions TEXT,
    is_active    INTEGER NOT NULL DEFAULT 1,
    updated_by   TEXT NOT NULL REFERENCES users (id),
    created_at   TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at   TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX ai_policies_updated_by_index ON ai_policies (updated_by);

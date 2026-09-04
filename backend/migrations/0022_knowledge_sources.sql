-- Migration 0022 — Knowledge sources beyond the uploaded file (AiNormalisation Phase 1, 2026-09-04)
--
-- ## Why
--
-- `knowledge_documents` could only ever describe a file an admin uploaded: `file_type` was
-- `'pdf' | 'docx'` and `storage_path` was NOT NULL, so a row had to have an R2 object behind it.
-- There was no way to paste a paragraph, answer one question, or correct a fact without
-- archive-and-re-upload.
--
-- On 2026-09-04 the production corpus was measured: **zero documents, zero chunks, ever**. The
-- §30 pipeline was refusing to generate because it had nothing to retrieve — correct behaviour
-- over an empty index. Upload-only was not one bottleneck among several; it was the reason the
-- corpus never started.
--
-- ## What changes
--
--   * `file_type` → `source_type`, widened to `pdf | docx | text | qa | catalog`. The column is
--     no longer about a file format; it is about **where the knowledge came from**.
--   * `title` — what a human calls this entry. For an upload it is the file name; for a pasted
--     note or a Q&A pair it is the only human-readable handle the row has.
--   * `storage_path` becomes nullable. An authored entry has no original file to retain. The
--     extracted-text sidecar (`knowledge/{id}/extracted.txt`) still exists for every row — it is
--     what `process()` re-reads — but it is derived, not provenance, so it does not belong here.
--   * `entity_type` / `entity_id` — the catalog auto-sync's identity. One knowledge entry per
--     career and per program, found again by what it is *about* rather than by its uuid, so a
--     re-sync updates the entry instead of adding a second one. Nullable everywhere else.
--
-- `file_name` stays NOT NULL and stays populated for authored entries too (the title is copied
-- into it), because §44's "{file_name} is now available to the AI assistant." notification and
-- the audit rows both read it, and a NULL there would degrade a message rather than a column.
--
-- ## Why both tables are rebuilt
--
-- SQLite cannot relax a NOT NULL in place, so `knowledge_documents` must be rebuilt. Its child
-- `knowledge_chunks` carries `ON DELETE CASCADE` — and a bare `DROP TABLE` on the parent fires
-- that cascade, which would silently take every chunk with it. So the order below is deliberate:
-- rename the old parent aside (SQLite repoints the child's REFERENCES clause), build the new
-- parent, rebuild the child against it, and only then drop the old parent — by which point
-- nothing references it and there is nothing left to cascade to.

-- 1. Move the old parent aside. knowledge_chunks' FK follows the rename to `_old`.
ALTER TABLE knowledge_documents RENAME TO knowledge_documents_old;

-- Indexes do NOT follow the table into a new namespace — they keep their original names on the
-- renamed table, so recreating them below would collide. Drop them here rather than after the
-- DROP TABLE: an index name is global to the database, and the collision is the whole point.
DROP INDEX knowledge_documents_uploaded_by_index;
DROP INDEX knowledge_documents_processing_status_index;

-- 2. The new parent.
CREATE TABLE knowledge_documents (
    id                TEXT PRIMARY KEY NOT NULL,
    uploaded_by       TEXT NOT NULL REFERENCES users (id),
    -- What a human calls this entry. NOT NULL: every row has a handle, backfilled from file_name.
    title             TEXT NOT NULL,
    file_name         TEXT NOT NULL,
    -- pdf | docx | text | qa | catalog
    source_type       TEXT NOT NULL,
    -- NULL for an authored entry: there is no original file to retain.
    storage_path      TEXT,
    -- 'career' | 'program' for catalog-synced entries; NULL otherwise.
    entity_type       TEXT,
    entity_id         TEXT,
    processing_status TEXT NOT NULL,
    visibility        TEXT NOT NULL,
    archived_at       TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);

INSERT INTO knowledge_documents (
    id, uploaded_by, title, file_name, source_type, storage_path,
    entity_type, entity_id, processing_status, visibility, archived_at, created_at, updated_at
)
SELECT
    id, uploaded_by,
    -- Every pre-existing row is an upload, so its file name is its title.
    file_name, file_name, file_type, storage_path,
    NULL, NULL, processing_status, visibility, archived_at, created_at, updated_at
FROM knowledge_documents_old;

CREATE INDEX knowledge_documents_uploaded_by_index ON knowledge_documents (uploaded_by);
CREATE INDEX knowledge_documents_processing_status_index ON knowledge_documents (processing_status);
CREATE INDEX knowledge_documents_source_type_index ON knowledge_documents (source_type);

-- The catalog sync's find-or-create key, and the guarantee that makes re-syncing safe: a career
-- can have at most one knowledge entry, so the nightly run updates rather than accumulates.
-- Partial, because every authored and uploaded row leaves both columns NULL.
CREATE UNIQUE INDEX knowledge_documents_entity_unique
    ON knowledge_documents (entity_type, entity_id)
    WHERE entity_type IS NOT NULL AND entity_id IS NOT NULL;

-- 3. Rebuild the child so its FK points at the new parent rather than at `_old`.
CREATE TABLE knowledge_chunks_rebuilt (
    id           TEXT PRIMARY KEY NOT NULL,
    document_id  TEXT NOT NULL REFERENCES knowledge_documents (id) ON DELETE CASCADE,
    chunk_number INTEGER NOT NULL,
    content      TEXT NOT NULL,
    vector_id    TEXT,
    token_count  INTEGER,
    created_at   TEXT NOT NULL
);

INSERT INTO knowledge_chunks_rebuilt (
    id, document_id, chunk_number, content, vector_id, token_count, created_at
)
SELECT id, document_id, chunk_number, content, vector_id, token_count, created_at
FROM knowledge_chunks;

DROP TABLE knowledge_chunks;

ALTER TABLE knowledge_chunks_rebuilt RENAME TO knowledge_chunks;

CREATE INDEX knowledge_chunks_document_id_index ON knowledge_chunks (document_id);
CREATE UNIQUE INDEX knowledge_chunks_document_number_unique
    ON knowledge_chunks (document_id, chunk_number);

-- 4. Nothing references the old parent now, so this drops rows and cascades to nothing.
DROP TABLE knowledge_documents_old;

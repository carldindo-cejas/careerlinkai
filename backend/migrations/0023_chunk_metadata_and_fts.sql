-- Migration 0023 — Retrieval that knows what it is looking for (AiNormalisation Phase 2)
--
-- Two changes, both about precision. Phase 0 made retrieval return things; Phase 1 made the corpus
-- grow. A bigger corpus searched on raw similarity alone gets *noisier*, not better — this is what
-- stops that.
--
-- ## 1. Chunk metadata
--
-- A vector's only metadata was `{ document_id }`, so when explaining one specific program there
-- was no way to prefer chunks *about that program*: it competed against the whole corpus on cosine
-- distance. These three columns are denormalized from `knowledge_documents` onto every chunk, and
-- the same three go into the Vectorize record's metadata at upsert.
--
-- Denormalized deliberately. The alternative — join `knowledge_chunks` to `knowledge_documents` at
-- query time — cannot work, because the filtering that matters happens **inside Vectorize**, before
-- any row is read. A vector carries its own metadata or it cannot be filtered on at all. Keeping
-- the columns on the chunk row too means the D1 side of retrieval (the keyword half, below) filters
-- on exactly the same values as the vector side, rather than two subtly different definitions of
-- "about this program".
--
-- They are nullable and backfilled from the parent, which is correct for both directions: existing
-- rows get the truth they always implied, and `entity_type`/`entity_id` stay NULL for everything
-- that is not a catalog entry.
--
-- ## 2. Keyword search (FTS5)
--
-- Embeddings are bad at exactly the things a student's question is most likely to hinge on: a
-- program code, a school's exact name, a figure. "BSCS" and "BS Computer Science" are close in
-- vector space to a hundred other programme names, and `bge-base-en-v1.5` has no Filipino training
-- at all (D8) — so a query naming a college exactly can currently miss it.
--
-- FTS5 is an SQLite built-in: no dependency, no bundle cost, and **zero neurons**, which is the
-- part that matters on a 10,000-neuron day. Hybrid retrieval fuses its hits with the vector hits by
-- reciprocal rank, so keyword search catches what embeddings miss without either half being able to
-- crowd the other out.
--
-- `content=` makes this an **external-content** table: FTS5 stores only the index, not a second copy
-- of every chunk's text. The triggers below are what keep it in step — without them the index
-- silently drifts from the table, which is the classic FTS5 failure and looks exactly like "search
-- got worse for no reason".

ALTER TABLE knowledge_chunks ADD COLUMN source_type TEXT;
ALTER TABLE knowledge_chunks ADD COLUMN entity_type TEXT;
ALTER TABLE knowledge_chunks ADD COLUMN entity_id TEXT;

UPDATE knowledge_chunks
SET source_type = (
        SELECT source_type FROM knowledge_documents
        WHERE knowledge_documents.id = knowledge_chunks.document_id
    ),
    entity_type = (
        SELECT entity_type FROM knowledge_documents
        WHERE knowledge_documents.id = knowledge_chunks.document_id
    ),
    entity_id = (
        SELECT entity_id FROM knowledge_documents
        WHERE knowledge_documents.id = knowledge_chunks.document_id
    );

-- The two-pass explanation retrieval reads exactly this pair: "chunks about this program".
CREATE INDEX knowledge_chunks_entity_index ON knowledge_chunks (entity_type, entity_id);

-- `unicode61` with diacritic folding: a student typing "Saint Louis" must match "Saint Loüis", and
-- Filipino text carries enough accented vowels for this to be a real difference rather than a
-- theoretical one. `remove_diacritics 2` is the modern, full form of the option.
CREATE VIRTUAL TABLE knowledge_chunks_fts USING fts5 (
    content,
    content='knowledge_chunks',
    content_rowid='rowid',
    tokenize="unicode61 remove_diacritics 2"
);

-- Backfill whatever is already there. (`rebuild` is the external-content table's own command for
-- exactly this — reading straight from the content table, so it cannot disagree with it.)
INSERT INTO knowledge_chunks_fts (knowledge_chunks_fts) VALUES ('rebuild');

-- The index is a projection of the table, and these keep it one. Ingestion replaces a document's
-- chunks wholesale on every reprocess (delete-then-insert), so the delete trigger is not an edge
-- case — it fires on every single re-run, and an index that missed it would accumulate the text of
-- every superseded version of every entry, answering students from wording that no longer exists.
CREATE TRIGGER knowledge_chunks_fts_insert AFTER INSERT ON knowledge_chunks BEGIN
    INSERT INTO knowledge_chunks_fts (rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER knowledge_chunks_fts_delete AFTER DELETE ON knowledge_chunks BEGIN
    INSERT INTO knowledge_chunks_fts (knowledge_chunks_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER knowledge_chunks_fts_update AFTER UPDATE ON knowledge_chunks BEGIN
    INSERT INTO knowledge_chunks_fts (knowledge_chunks_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
    INSERT INTO knowledge_chunks_fts (rowid, content) VALUES (new.rowid, new.content);
END;

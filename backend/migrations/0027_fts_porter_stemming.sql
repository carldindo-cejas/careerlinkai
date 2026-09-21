-- Migration 0027 — Stem both sides of the keyword half (AiNormalisation, Phase 0 acceptance)
--
-- Phase 0's acceptance run measured 17 of 20 real student questions retrieving >=3 chunks on the
-- keyword half alone. All three misses were the same defect, and none of them was a coverage gap:
--
--   | Tell me about becoming a Registered **Nurse** | 1 chunk  |
--   | How much do **architects** earn?              | 0 chunks |
--   | What careers involve working with **computers**? | 0 chunks |
--
-- `unicode61` matches whole tokens. The corpus says *nursing*, *Architect* and *computer*; the
-- student types *nurse*, *architects* and *computers*. The passages exist and say the right thing
-- — the index simply could not see that two spellings of one word were one word.
--
-- FTS5 ships a `porter` wrapper around any tokenizer, which stems every term on the way in **and**
-- every term in a `MATCH` on the way out. Because both sides are stemmed, this is not a widening
-- of the query: it is the two halves finally agreeing on what a word is.
--
-- ## Why the table has to be dropped and rebuilt
--
-- A tokenizer is fixed at creation. There is no `ALTER` for it, and an index built by one
-- tokenizer cannot be read by another — the stored terms *are* the old tokenizer's output. So the
-- only correct migration is drop, recreate, `rebuild`. That is cheap here and always will be:
-- `content='knowledge_chunks'` makes this an external-content table, so the rebuild reads the
-- chunk rows that never went anywhere, costs zero neurons, and cannot disagree with the table it
-- is derived from.
--
-- The triggers are dropped first, on purpose. They reference `knowledge_chunks_fts` by name, and a
-- trigger left pointing at a table that does not exist yet turns any concurrent write to
-- `knowledge_chunks` into an error for the length of this migration.
--
-- ## What stemming costs, measured rather than assumed
--
-- English stemming applied to Taglish is not free of side effects, so it was measured against the
-- porter tokenizer before this migration was written, not after:
--
--   * The words this corpus and its students actually collide on all fold correctly —
--     nurse/nurses/nursing -> `nurs`, architect/architects -> `architect`,
--     computer/computers -> `comput`, engineer/engineering -> `engin`,
--     requirement/requirements -> `requir`.
--   * **`magkano` stems to `magkano`** — the specific word the plan named as the thing that must
--     not break. So do trabaho, kurso, paaralan, mahal, kailangan, maganda, pagkain, bayad, gusto
--     and saan. Porter's rules key off English suffixes, and Filipino roots mostly do not carry
--     them.
--   * Three Tagalog words *are* mangled, all by Porter's `-ing` rule: `aking` -> `ak`,
--     `ating` -> `at`, `kaming` -> `kame`. This is survivable for the one reason that matters —
--     the rule is applied to the query as well, so `aking` still finds `aking`. The residual risk
--     is a collision, an English word that also stems to `ak` or `at`; both are then terms of very
--     high document frequency, which is precisely what BM25 scores at near zero. A false candidate
--     that ranks last is filtered by `KEYWORD_CANDIDATE_K` before fusion and by the cross-encoder
--     after it.
--
-- The trade is three measured, reproducible retrieval failures fixed against a ranking risk that
-- two later stages already exist to absorb.

DROP TRIGGER IF EXISTS knowledge_chunks_fts_insert;
DROP TRIGGER IF EXISTS knowledge_chunks_fts_delete;
DROP TRIGGER IF EXISTS knowledge_chunks_fts_update;

DROP TABLE IF EXISTS knowledge_chunks_fts;

-- `remove_diacritics 2` is carried over unchanged from 0023 and still earns its place: a student
-- typing "Saint Louis" must match "Saint Loüis". `porter` wraps the tokenizer rather than
-- replacing it, so the folding happens first and the stemmer sees already-folded text.
CREATE VIRTUAL TABLE knowledge_chunks_fts USING fts5 (
    content,
    content='knowledge_chunks',
    content_rowid='rowid',
    tokenize="porter unicode61 remove_diacritics 2"
);

-- Reads straight from the content table, so the new index cannot disagree with it.
INSERT INTO knowledge_chunks_fts (knowledge_chunks_fts) VALUES ('rebuild');

-- Recreated verbatim from 0023. They are what keep the index a projection of the table rather than
-- a copy that drifts; ingestion replaces a document's chunks wholesale on every reprocess, so the
-- delete trigger fires on every re-run and is not an edge case.
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

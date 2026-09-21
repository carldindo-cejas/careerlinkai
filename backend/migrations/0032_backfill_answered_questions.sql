-- Migration 0032 — credit the answers that were written before the backlog could remember them
--
-- Found by testing migration 0031 against production on 2026-09-11.
--
-- 0031 gave the unanswered-questions report a memory, but only going forward: a resolution row is
-- written when somebody answers a question *through the new code path*. Every Q&A pair written
-- before it shipped had no such row, so the questions they answer stayed on the backlog — exactly
-- the bug 0031 was written to fix, still visible on the live screen. The case that exposed it:
-- "Where is Holy Name University located?" was being answered word for word by Gate 1 from an
-- admin's Q&A entry while it sat fourth on the unanswered list with four asks.
--
-- The application now resolves a Q&A pair's own question whenever one is saved (see
-- `resolveBacklogItems` in `src/modules/ai/routes.ts`). This migration does the same, once, for
-- the entries that already exist.
--
-- ## The key expression is 0031's, character for character
--
-- `rtrim(lower(trim(title)), ' ?.!')` is `questionKey()` in `insights-service.ts`. It is written
-- out here because a migration cannot import TypeScript, and it must not drift: a backfilled key
-- that normalised differently would match no refusal and clear nothing, silently. If
-- `questionKey()` ever changes, this file stays as it is (it has already run) and the new
-- expression needs its own migration re-keying the table.
--
-- ## The timestamps are the entry's, not today's
--
-- A resolution covers only the asks that came before it (0031, condition 3). Backdating it to the
-- entry's own `created_at` keeps that meaning honest: asks from before the answer existed clear,
-- while an ask that arrived *after* the answer was written — and was refused anyway — survives and
-- is flagged as "answered, asked again", which is the retrieval problem it actually is. Stamping
-- today's date would bury those.
--
-- ## Conflicts
--
-- `INSERT OR IGNORE` against the unique key, newest entry first: an existing resolution (somebody
-- already answered or dismissed the question through the UI) is a decision a person made and is
-- left alone, and where two old Q&A pairs share a question the newer one is credited. Archived
-- entries are skipped — they cover nothing, and a lapsed row would only add noise.
--
-- `resolved_by` is the entry's author. It is attribution rather than a claim anybody made in the
-- UI, and it is the right person: they wrote the answer.
--
-- Idempotent: every row it could insert is either inserted once or ignored on a re-run.

INSERT OR IGNORE INTO knowledge_question_resolutions (
    id, question_key, question, resolution, document_id, resolved_by, created_at, updated_at
)
SELECT
    lower(hex(randomblob(16))),
    rtrim(lower(trim(d.title)), ' ?.!'),
    d.title,
    'ANSWERED',
    d.id,
    d.uploaded_by,
    d.created_at,
    d.created_at
FROM knowledge_documents d
WHERE d.source_type = 'qa'
  AND d.archived_at IS NULL
  AND trim(d.title) <> ''
ORDER BY d.created_at DESC;

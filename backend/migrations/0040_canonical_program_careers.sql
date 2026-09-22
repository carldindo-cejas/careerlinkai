-- Migration 0040 — What a program leads to belongs to the canonical program (2026-09-22)
--
-- Until now `program_careers` was keyed by **offering**: "BSCS at BISU-Tagbilaran leads to Software
-- Developer" was one row, and "BSCS at UB leads to Software Developer" was another. The seed wrote
-- every one of them from a single per-canonical-code list (`MAPPINGS` in build-region7-seed.mjs), so
-- the data always *meant* "BSCS leads to these careers" — but the only screen that could change it
-- edited one college at a time. Re-pointing what BS Computer Science leads to meant repeating the
-- same edit on every campus that offers it, and a missed campus scored differently from its twins
-- for no reason a student could see.
--
-- So the link moves to where the fact lives. `program_catalog_careers` says what a canonical program
-- leads to; every offering of it inherits that set. `program_careers` stays, and now means
-- **college-specific extras** — a destination one campus's track genuinely adds on top of the
-- degree's own. An offering's careers are the union of the two.
--
-- ## One definition of "an offering's careers": the `program_career_links` view
--
-- Six readers traverse this relationship — the §27 scorer, the career → programs lookup, the admin
-- college view, the knowledge-corpus sync and two assistant answers. If each of them re-derived the
-- union, the first one to forget half of it would score, answer or describe a program differently
-- from the others, silently. The view is the union written once; every reader selects from it.
--
-- It carries `source` ('canonical' / 'offering') so the admin screen can say which chips are
-- inherited, and it **excludes an offering row that duplicates an inherited link** rather than using
-- UNION to dedupe — so a career never appears twice for one offering (§27 would give it two votes),
-- and the surviving row is labelled with the source the admin should edit.
--
-- A soft-deleted canonical entry contributes nothing: a merged-away entry has no offerings left, and
-- `listPrograms` already treats a deleted canonical as no link at all.
--
-- ## The backfill is lossless
--
-- For each canonical program, the careers linked on **every** live offering of it are promoted; the
-- offering rows they came from are then deleted as redundant. A career linked on only some offerings
-- stays where it is, as an extra on exactly those offerings. So every offering's effective set after
-- this migration is identical to its set before it — no program's score moves — and the common core
-- is now editable in one place. Offerings with no canonical entry keep all their rows untouched.
--
-- ## The recommended strand moves up too, as a default rather than a lock
--
-- `program_catalog.recommended_strand` is what the canonical page edits, and saving a change to it
-- writes the value to every offering (see `AcademicCatalogService.updateCanonicalProgram`). The
-- offering keeps its own column, and every reader keeps reading it, because admission requirements
-- genuinely vary by campus — one college may require the Academic track for a degree another accepts
-- from either. NULL keeps its §27 meaning here: "no strand requirement", scored as a full 100.
--
-- Backfilled with the value most live offerings already carry (ties to the lexically first, NULL
-- before a named strand, so the result is reproducible — §26). No offering is modified: until an
-- admin saves a new strand on the canonical page, every offering scores exactly as it did.

CREATE TABLE program_catalog_careers (
    id                 TEXT PRIMARY KEY NOT NULL,
    program_catalog_id TEXT NOT NULL REFERENCES program_catalog (id) ON DELETE CASCADE,
    career_id          TEXT NOT NULL REFERENCES careers (id) ON DELETE CASCADE
);

-- A scoring invariant, as on `program_careers`: a duplicate link is a career voting twice.
CREATE UNIQUE INDEX program_catalog_careers_catalog_career_unique
    ON program_catalog_careers (program_catalog_id, career_id);
CREATE INDEX program_catalog_careers_program_catalog_id_index
    ON program_catalog_careers (program_catalog_id);
CREATE INDEX program_catalog_careers_career_id_index
    ON program_catalog_careers (career_id);

ALTER TABLE program_catalog ADD COLUMN recommended_strand TEXT
    CHECK (recommended_strand IN ('Academic', 'Technical-Professional'));

-- --- Backfill: careers ----------------------------------------------------------------------------
--
-- A career is promoted when the number of live offerings of the canonical program that link it
-- equals the number of live offerings of that canonical program — i.e. all of them.

INSERT INTO program_catalog_careers (id, program_catalog_id, career_id)
SELECT
    lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6))),
    shared.program_catalog_id,
    shared.career_id
FROM (
    SELECT p.program_catalog_id AS program_catalog_id, pc.career_id AS career_id
    FROM program_careers pc
    JOIN programs p ON p.id = pc.program_id
    WHERE p.program_catalog_id IS NOT NULL
      AND p.deleted_at IS NULL
    GROUP BY p.program_catalog_id, pc.career_id
    HAVING COUNT(DISTINCT p.id) = (
        SELECT COUNT(*)
        FROM programs sibling
        WHERE sibling.program_catalog_id = p.program_catalog_id
          AND sibling.deleted_at IS NULL
    )
) AS shared;

-- The offering rows the canonical links now cover. Soft-deleted offerings are included: were one
-- restored, it would inherit the same careers from its canonical entry anyway.
DELETE FROM program_careers
WHERE id IN (
    SELECT pc.id
    FROM program_careers pc
    JOIN programs p ON p.id = pc.program_id
    JOIN program_catalog_careers pcc
      ON pcc.program_catalog_id = p.program_catalog_id
     AND pcc.career_id = pc.career_id
);

-- --- Backfill: strand -----------------------------------------------------------------------------

UPDATE program_catalog
SET recommended_strand = (
    SELECT p.recommended_strand
    FROM programs p
    WHERE p.program_catalog_id = program_catalog.id
      AND p.deleted_at IS NULL
    GROUP BY p.recommended_strand
    ORDER BY COUNT(*) DESC, COALESCE(p.recommended_strand, '') ASC
    LIMIT 1
);

-- --- The union, written once ----------------------------------------------------------------------

CREATE VIEW program_career_links AS
SELECT p.id AS program_id, pcc.career_id AS career_id, 'canonical' AS source
FROM program_catalog_careers pcc
JOIN program_catalog c ON c.id = pcc.program_catalog_id AND c.deleted_at IS NULL
JOIN programs p ON p.program_catalog_id = pcc.program_catalog_id
UNION ALL
SELECT pc.program_id AS program_id, pc.career_id AS career_id, 'offering' AS source
FROM program_careers pc
WHERE NOT EXISTS (
    SELECT 1
    FROM programs p
    JOIN program_catalog c ON c.id = p.program_catalog_id AND c.deleted_at IS NULL
    JOIN program_catalog_careers pcc
      ON pcc.program_catalog_id = p.program_catalog_id
     AND pcc.career_id = pc.career_id
    WHERE p.id = pc.program_id
);

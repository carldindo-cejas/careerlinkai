-- Migration 0041 — How strongly a program leads to a career (2026-09-22)
--
-- Until now a link was binary: a program led to a career or it did not. The source catalog behind
-- seed 0005 grades them — DIRECT (the program's natural destination), RELATED (a common path),
-- CONDITIONAL (reachable with an extra credential) — and the seed could only apply that as an
-- editorial yes/no, because `program_careers` had nowhere to put it. So BS Nursing leading to
-- Registered Nurse and BS Nursing leading to Health Informatics Specialist counted the same.
--
-- Each link now carries its relationship, and the formula's `linkWeights` say how much each kind
-- counts toward a program's score (see `lib/recommendation.ts`: a weighted average for the breadth
-- term, and a pull toward neutral — never toward zero — for the depth term).
--
-- **Every existing link becomes `direct`, which counts fully.** No program's score moves until an
-- administrator reclassifies a link on purpose; grading the 216 canonical links is an editorial
-- job for a person who knows the programs, not something a migration should guess at.
--
-- The view is recreated to carry the column, with the same union and the same de-duplication as
-- migration 0040.

ALTER TABLE program_catalog_careers ADD COLUMN relationship TEXT NOT NULL DEFAULT 'direct'
    CHECK (relationship IN ('direct', 'related', 'conditional'));

ALTER TABLE program_careers ADD COLUMN relationship TEXT NOT NULL DEFAULT 'direct'
    CHECK (relationship IN ('direct', 'related', 'conditional'));

DROP VIEW program_career_links;

CREATE VIEW program_career_links AS
SELECT p.id AS program_id, pcc.career_id AS career_id, 'canonical' AS source,
       pcc.relationship AS relationship
FROM program_catalog_careers pcc
JOIN program_catalog c ON c.id = pcc.program_catalog_id AND c.deleted_at IS NULL
JOIN programs p ON p.program_catalog_id = pcc.program_catalog_id
UNION ALL
SELECT pc.program_id AS program_id, pc.career_id AS career_id, 'offering' AS source,
       pc.relationship AS relationship
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

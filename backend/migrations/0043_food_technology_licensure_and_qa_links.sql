-- Migration 0043 — Food Technologist is licensed; Quality Assurance Engineer is software (2026-09-22)
--
-- Two catalog corrections, the same ones made to `MAPPINGS` and `CAREERS` in
-- `scripts/build-region7-seed.mjs` so a fresh database and an existing one agree.
--
-- ## Quality Assurance Engineer is an IT career
--
-- Its description is software testing ("the test suites that decide whether software ships"), and
-- that stays. It was also linked from BS Industrial Technology and BS Food Technology, where it
-- stood in for manufacturing and food QA — a different job the description does not describe. A
-- student ranked on those links was being told a food technology degree leads to software testing.
-- The two links are removed; BS Computer Science keeps its link.
--
-- ## Food Technologist is a regulated profession
--
-- The catalog called it "non-regulated as a title". Republic Act 11052, the Philippine Food
-- Technology Act (2018), made practice require the PRC Food Technologist Licensure Examination. The
-- description is corrected, **only where it is still the seed's original text** — an administrator
-- who has already rewritten it keeps their version.
--
-- And a licence is what makes a link conditional (see the grading rule above `MAPPINGS`): BS
-- Agricultural and Biosystems Engineering does not lead to that examination, so its link to Food
-- Technologist moves from related to conditional. A link an administrator has already set to
-- conditional is unaffected either way. BS Food Technology's own link stays direct.

-- --- Remove the two QA links, canonical and any college-specific copies -------------------------

DELETE FROM program_catalog_careers
WHERE program_catalog_id IN (
    SELECT id FROM program_catalog WHERE code COLLATE NOCASE IN ('BSINDTECH', 'BSFT')
)
  AND career_id IN (
    SELECT id FROM careers WHERE LOWER(TRIM(title)) = 'quality assurance engineer'
);

DELETE FROM program_careers
WHERE program_id IN (
    SELECT p.id
    FROM programs p
    JOIN program_catalog c ON c.id = p.program_catalog_id
    WHERE c.code COLLATE NOCASE IN ('BSINDTECH', 'BSFT')
)
  AND career_id IN (
    SELECT id FROM careers WHERE LOWER(TRIM(title)) = 'quality assurance engineer'
);

-- --- BSABE → Food Technologist: related → conditional --------------------------------------------

UPDATE program_catalog_careers
SET relationship = 'conditional'
WHERE relationship IN ('direct', 'related')
  AND program_catalog_id IN (SELECT id FROM program_catalog WHERE code COLLATE NOCASE = 'BSABE')
  AND career_id IN (SELECT id FROM careers WHERE LOWER(TRIM(title)) = 'food technologist');

UPDATE program_careers
SET relationship = 'conditional'
WHERE relationship IN ('direct', 'related')
  AND program_id IN (
    SELECT p.id
    FROM programs p
    JOIN program_catalog c ON c.id = p.program_catalog_id
    WHERE c.code COLLATE NOCASE = 'BSABE'
)
  AND career_id IN (SELECT id FROM careers WHERE LOWER(TRIM(title)) = 'food technologist');

-- --- The description --------------------------------------------------------------------------------

UPDATE careers
SET description = 'Develops food products and runs processing, preservation, quality assurance and food-safety systems (HACCP, GMP) in manufacturing plants and for regulators. Regulated under RA 11052, the Philippine Food Technology Act — practice requires passing the PRC Food Technologist Licensure Examination and registering with the Board.',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE LOWER(TRIM(title)) = 'food technologist'
  AND description = 'Develops food products and runs processing, preservation, quality assurance and food-safety systems (HACCP, GMP) in manufacturing plants and for regulators. Non-regulated as a title, though food-safety practice is governed by FDA and DA standards.';

-- --- Mark stored recommendation sets stale ------------------------------------------------------------
--
-- Removing a link moves those programs' scores. Only stamped where the catalog holds these programs
-- at all, so an empty database is not told its nonexistent sets are out of date (as in 0042).

INSERT INTO app_settings (key, value, updated_by, updated_at)
SELECT 'recommendation_inputs_changed_at',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       NULL,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (
    SELECT 1 FROM program_catalog WHERE code COLLATE NOCASE IN ('BSINDTECH', 'BSFT', 'BSABE')
)
ON CONFLICT (key) DO UPDATE SET
    value = excluded.value,
    updated_by = NULL,
    updated_at = excluded.updated_at;

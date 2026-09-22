-- Migration 0042 — Grade the catalog's program → career links (2026-09-22)
--
-- Migration 0041 gave every link a relationship and set all of them to `direct`, on purpose:
-- grading the catalog was an editorial job, not something a schema change should guess at. This is
-- that editorial job, done on request, for every college at once — a link lives on the canonical
-- program (migration 0040), so grading "BS Nursing → Nurse Administrator" once grades it on every
-- campus that offers BS Nursing.
--
-- The grades are `MAPPINGS` in `scripts/build-region7-seed.mjs`, where the rule is written out:
-- **direct** is what the degree is built for (its own board exam included), **related** is a common
-- path needing nothing more, **conditional** needs something the degree does not give — a graduate
-- degree, years of progression, another degree's licence or a separate accreditation. Seed 0005
-- writes the same grades into a fresh database; this carries them into one that already exists,
-- without the catalog reset the seed would mean (see `scripts/reset-catalog-remote.mjs`).
--
-- ## What it touches, and what it leaves alone
--
-- * Links are matched by **natural key** — canonical code and career title, case- and
--   space-insensitive as the uniqueness indexes are — never by id, so a database whose ids differ
--   from the seed's is graded the same way. A link an admin added that is not in the table, or a
--   career they renamed, simply stays `direct`.
-- * **Only a link still at 0041's default is changed.** A link an administrator already set to
--   related or conditional was graded by a person on purpose, and keeps that grade.
-- * Only the related and conditional grades are listed: every direct link is already `direct`.
-- * College-specific extras (`program_careers`) are graded too, where the same program/career pair
--   appears as an extra on an offering of that program.
--
-- ## Scores move, and the screens say so
--
-- A related or conditional link counts for less in §27 (`linkWeights`), so this changes program
-- scores. The routes that change scoring inputs stamp `recommendation_inputs_changed_at`, which is
-- how a stored recommendation set is shown as stale (`RecommendationFreshnessService`); this does
-- the same, but only when there are graded links to have changed — an empty database is not told
-- that its nonexistent sets are out of date.

CREATE TABLE _link_grades_0042 (
    program_code TEXT NOT NULL,
    career_title TEXT NOT NULL,
    relationship TEXT NOT NULL CHECK (relationship IN ('related', 'conditional'))
);

INSERT INTO _link_grades_0042 (program_code, career_title, relationship) VALUES
    ('BSCS', 'Data Scientist', 'related'),
    ('BSCS', 'Cybersecurity Analyst', 'related'),
    ('BSCS', 'AI/Machine Learning Engineer', 'related'),
    ('BSCS', 'Cloud Infrastructure Engineer', 'related'),
    ('BSCS', 'Quality Assurance Engineer', 'related'),
    ('BSCS', 'Enterprise Systems Architect', 'conditional'),
    ('BSIT', 'Database Administrator', 'related'),
    ('BSIT', 'Cybersecurity Analyst', 'related'),
    ('BSIT', 'Cloud Infrastructure Engineer', 'related'),
    ('BSIS', 'Database Administrator', 'related'),
    ('BSIS', 'Data Analyst', 'related'),
    ('BSIS', 'Software Developer', 'related'),
    ('BSIS', 'Supply Chain Analyst', 'related'),
    ('BSCPE', 'Network Engineer', 'related'),
    ('BSCPE', 'Software Developer', 'related'),
    ('BSCPE', 'Systems Administrator', 'related'),
    ('BSCE', 'Construction Project Manager', 'related'),
    ('BSCE', 'Quantity Surveyor', 'related'),
    ('BSCE', 'BIM Specialist', 'related'),
    ('BSCE', 'Occupational Health and Safety Officer', 'conditional'),
    ('BSME', 'Construction Project Manager', 'related'),
    ('BSME', 'Maintenance Engineer', 'related'),
    ('BSME', 'Occupational Health and Safety Officer', 'conditional'),
    ('BSEE', 'Construction Project Manager', 'related'),
    ('BSEE', 'Maintenance Engineer', 'related'),
    ('BSEE', 'Renewable Energy Specialist', 'related'),
    ('BSABE', 'Environmental Scientist', 'related'),
    ('BSABE', 'Food Technologist', 'related'),
    ('BSABE', 'Farm Operations Manager', 'related'),
    ('BSABE', 'Agriculturist', 'conditional'),
    ('BSARCH', 'BIM Specialist', 'related'),
    ('BSARCH', 'Construction Project Manager', 'related'),
    ('BSARCH', 'Quantity Surveyor', 'related'),
    ('BSARCH', 'Urban and Regional Planner', 'conditional'),
    ('BSARCH', 'Interior Designer', 'conditional'),
    ('BSINDDES', 'CAD Design Technician', 'related'),
    ('BSINDDES', 'Graphic Designer', 'related'),
    ('BSINDDES', 'Multimedia Artist', 'related'),
    ('BSINDDES', 'UI/UX Designer', 'related'),
    ('BSMARE', 'Port Operations Supervisor', 'related'),
    ('BSMARE', 'Maintenance Engineer', 'related'),
    ('BSMARE', 'Power Plant Engineer', 'conditional'),
    ('BSMARE', 'Mechanical Engineer', 'conditional'),
    ('BSMARTRANS', 'Port Operations Supervisor', 'related'),
    ('BSMARTRANS', 'Marine Surveyor', 'conditional'),
    ('BSMARTRANS', 'Ship Captain', 'conditional'),
    ('BSINDTECH', 'CAD Design Technician', 'related'),
    ('BSINDTECH', 'Quality Assurance Engineer', 'related'),
    ('BSINDTECH', 'Operations Manager', 'related'),
    ('BSINDTECH', 'Instrumentation Technician', 'related'),
    ('BSINDTECH', 'Occupational Health and Safety Officer', 'conditional'),
    ('BSELECTECH', 'Industrial Technologist', 'related'),
    ('BSELECTECH', 'CAD Design Technician', 'related'),
    ('BSELECTECH', 'Instrumentation Technician', 'related'),
    ('BSELECTECH', 'Occupational Health and Safety Officer', 'conditional'),
    ('BSELXTECH', 'Industrial Technologist', 'related'),
    ('BSELXTECH', 'IT Support Specialist', 'related'),
    ('BSELXTECH', 'Instrumentation Technician', 'related'),
    ('BSELXTECH', 'Embedded Systems Engineer', 'related'),
    ('BSN', 'Clinical Researcher', 'related'),
    ('BSN', 'Public Health Officer', 'related'),
    ('BSN', 'Medical Sales Representative', 'related'),
    ('BSN', 'Nurse Administrator', 'conditional'),
    ('BSN', 'Occupational Health and Safety Officer', 'conditional'),
    ('BSPHARM', 'Clinical Researcher', 'related'),
    ('BSPHARM', 'Laboratory Research Associate', 'related'),
    ('BSPHARM', 'Regulatory Affairs Specialist', 'related'),
    ('BSPHARM', 'Medical Sales Representative', 'related'),
    ('BSPT', 'Public Health Officer', 'related'),
    ('BSMID', 'Public Health Officer', 'related'),
    ('BSMID', 'Public Health Nurse', 'conditional'),
    ('BSA', 'Financial Analyst', 'related'),
    ('BSA', 'Internal Auditor', 'related'),
    ('BSA', 'Chief Financial Officer', 'conditional'),
    ('BSAIS', 'Data Analyst', 'related'),
    ('BSAIS', 'Financial Analyst', 'related'),
    ('BSBA', 'Operations Manager', 'related'),
    ('BSBA', 'Business Development Specialist', 'related'),
    ('BSBA', 'Bank Operations Officer', 'related'),
    ('BSBA', 'Events Manager', 'related'),
    ('BSBA', 'Executive Assistant', 'related'),
    ('BSENTREP', 'Business Development Specialist', 'related'),
    ('BSENTREP', 'Marketing Specialist', 'related'),
    ('BSENTREP', 'Operations Manager', 'related'),
    ('BSOA', 'Human Resources Specialist', 'related'),
    ('BSOA', 'Operations Manager', 'related'),
    ('BSHM', 'Operations Manager', 'related'),
    ('BSHM', 'Entrepreneur', 'related'),
    ('BSHM', 'Events Manager', 'related'),
    ('BSHM', 'Tour Operations Manager', 'related'),
    ('BSTM', 'Hotel Operations Manager', 'related'),
    ('BSTM', 'Marketing Specialist', 'related'),
    ('BSTM', 'Events Manager', 'related'),
    ('BEED', 'Curriculum Developer', 'related'),
    ('BEED', 'Guidance Counselor', 'conditional'),
    ('BEED', 'School Administrator', 'conditional'),
    ('BSED', 'Curriculum Developer', 'related'),
    ('BSED', 'Guidance Counselor', 'conditional'),
    ('BSED', 'School Administrator', 'conditional'),
    ('BPED', 'Secondary School Teacher', 'related'),
    ('BPED', 'Athletic Coach', 'related'),
    ('BPED', 'Elementary School Teacher', 'conditional'),
    ('BPED', 'Sports Rehabilitation Specialist', 'conditional'),
    ('BPED', 'School Administrator', 'conditional'),
    ('BSPSY', 'Human Resources Specialist', 'related'),
    ('BSPSY', 'Clinical Researcher', 'related'),
    ('BSPSY', 'Clinical Psychologist', 'conditional'),
    ('BSPSY', 'Guidance Counselor', 'conditional'),
    ('BSCRIM', 'Crime Scene Investigator', 'related'),
    ('BSCRIM', 'Fire Officer', 'related'),
    ('BSCRIM', 'Public Administration Officer', 'related'),
    ('BSCRIM', 'Legal Researcher', 'related'),
    ('BSCRIM', 'Security Operations Manager', 'conditional'),
    ('ABPOLSCI', 'Communications Officer', 'related'),
    ('ABPOLSCI', 'Journalist', 'related'),
    ('ABPOLSCI', 'Legal Researcher', 'related'),
    ('ABPOLSCI', 'Lawyer', 'conditional'),
    ('ABENG', 'Communications Officer', 'related'),
    ('ABENG', 'Journalist', 'related'),
    ('ABENG', 'Curriculum Developer', 'related'),
    ('ABENG', 'Secondary School Teacher', 'conditional'),
    ('BPA', 'Operations Manager', 'related'),
    ('BPA', 'Human Resources Specialist', 'related'),
    ('BPA', 'Policy Research Analyst', 'related'),
    ('BPA', 'Security Operations Manager', 'conditional'),
    ('JD', 'Legal Researcher', 'related'),
    ('JD', 'Public Administration Officer', 'related'),
    ('JD', 'Policy Research Analyst', 'related'),
    ('JD', 'Internal Auditor', 'related'),
    ('BSMARBIO', 'Environmental Scientist', 'related'),
    ('BSMARBIO', 'Laboratory Research Associate', 'related'),
    ('BSMARBIO', 'Aquatic Resource Specialist', 'conditional'),
    ('BSMARBIO', 'Fisheries Technologist', 'conditional'),
    ('BSENVSCI', 'Laboratory Research Associate', 'related'),
    ('BSENVSCI', 'Renewable Energy Specialist', 'related'),
    ('BSENVSCI', 'Pollution Control Officer', 'conditional'),
    ('BSENVSCI', 'Public Health Officer', 'conditional'),
    ('BSFISH', 'Marine Biologist', 'related'),
    ('BSFISH', 'Farm Operations Manager', 'related'),
    ('BSFISH', 'Agricultural Extension Worker', 'related'),
    ('BSFISH', 'Agriculturist', 'conditional'),
    ('BSAGRI', 'Environmental Scientist', 'related'),
    ('BSAGRI', 'Entrepreneur', 'related'),
    ('BSAGRI', 'Pollution Control Officer', 'conditional'),
    ('BSFOR', 'Environmental Scientist', 'related'),
    ('BSFOR', 'Agricultural Extension Worker', 'related'),
    ('BSFOR', 'Agriculturist', 'conditional'),
    ('BSFOR', 'Pollution Control Officer', 'conditional'),
    ('BSFT', 'Laboratory Research Associate', 'related'),
    ('BSFT', 'Quality Assurance Engineer', 'related'),
    ('BSFT', 'Regulatory Affairs Specialist', 'related'),
    ('BSFT', 'Food and Beverage Supervisor', 'related'),
    ('BSFT', 'Entrepreneur', 'related');

-- --- The canonical links: what every offering inherits ------------------------------------------

UPDATE program_catalog_careers
SET relationship = (
    SELECT g.relationship
    FROM _link_grades_0042 g
    JOIN program_catalog c ON c.code = g.program_code COLLATE NOCASE
    JOIN careers k ON LOWER(TRIM(k.title)) = LOWER(TRIM(g.career_title))
    WHERE c.id = program_catalog_careers.program_catalog_id
      AND k.id = program_catalog_careers.career_id
)
WHERE relationship = 'direct'
  AND EXISTS (
    SELECT 1
    FROM _link_grades_0042 g
    JOIN program_catalog c ON c.code = g.program_code COLLATE NOCASE
    JOIN careers k ON LOWER(TRIM(k.title)) = LOWER(TRIM(g.career_title))
    WHERE c.id = program_catalog_careers.program_catalog_id
      AND k.id = program_catalog_careers.career_id
  );

-- --- College-specific extras on an offering of the same program --------------------------------

UPDATE program_careers
SET relationship = (
    SELECT g.relationship
    FROM _link_grades_0042 g
    JOIN program_catalog c ON c.code = g.program_code COLLATE NOCASE
    JOIN programs p ON p.program_catalog_id = c.id
    JOIN careers k ON LOWER(TRIM(k.title)) = LOWER(TRIM(g.career_title))
    WHERE p.id = program_careers.program_id
      AND k.id = program_careers.career_id
)
WHERE relationship = 'direct'
  AND EXISTS (
    SELECT 1
    FROM _link_grades_0042 g
    JOIN program_catalog c ON c.code = g.program_code COLLATE NOCASE
    JOIN programs p ON p.program_catalog_id = c.id
    JOIN careers k ON LOWER(TRIM(k.title)) = LOWER(TRIM(g.career_title))
    WHERE p.id = program_careers.program_id
      AND k.id = program_careers.career_id
  );

DROP TABLE _link_grades_0042;

-- --- Mark stored recommendation sets stale -------------------------------------------------------
--
-- The same ISO-8601 shape `lib/datetime.now()` writes, since staleness is a string comparison
-- against `recommendations.created_at`.

INSERT INTO app_settings (key, value, updated_by, updated_at)
SELECT 'recommendation_inputs_changed_at',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       NULL,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM program_catalog_careers WHERE relationship <> 'direct')
   OR EXISTS (SELECT 1 FROM program_careers WHERE relationship <> 'direct')
ON CONFLICT (key) DO UPDATE SET
    value = excluded.value,
    updated_by = NULL,
    updated_at = excluded.updated_at;

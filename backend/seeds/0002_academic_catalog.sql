-- Seed 0002 — the demo academic catalog (FULLPLAN §13.3, Phase 3.5 Step 3).
--
-- **Real data, not faker output**: 5 Philippine institutions, 16 programs, 10 careers,
-- 24 mappings. It is real for two reasons, and both are load-bearing rather than cosmetic.
--
-- 1. It is what a thesis panel is shown. A catalog of invented universities undercuts the demo.
--
-- 2. **§27's worked example scores BS Computer Science through Software Engineer (`IEC`) and
--    Data Analyst (`ICE`).** Those exact rows exist below, with those exact Holland codes and
--    that exact mapping — so Phase 4's recommendation engine can be checked against a number
--    computed by hand rather than against whatever it happens to produce.
--
-- The seed deliberately covers **all three strand cases**, because uniform data would never
-- exercise §27's strand branch:
--   * `Academic` programs (most of them),
--   * `Technical-Professional` programs (Mapúa's BSIT and BSCPE — the TVL-ICT track feeds
--     them directly),
--   * and one program with **no requirement at all** (Ateneo's AB Communication), which §27
--     must score as a full 100 for every student rather than as a missing value.
--
-- Idempotent: every row is keyed by a fixed UUID and inserted with `INSERT OR IGNORE`, so
-- re-running never duplicates the catalog. The ids are stable on purpose — Phase 4's tests
-- will reference them.
--
-- Timestamps are ISO-8601 UTC (`strftime`), never SQLite's bare `CURRENT_TIMESTAMP`, which
-- renders as `2026-07-13 14:11:05` and which JavaScript reads as *local* time. A seeded row
-- has to look exactly like an app-written one (src/lib/datetime.ts).

-- --- Colleges -------------------------------------------------------------------------

INSERT OR IGNORE INTO colleges (id, name, description, status, created_at, updated_at) VALUES
('c0111111-1111-4111-8111-111111111111', 'University of the Philippines Diliman', 'The national university''s flagship constituent university, in Quezon City.', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('c0222222-2222-4222-8222-222222222222', 'University of Santo Tomas', 'The oldest existing university in Asia, founded in 1611.', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('c0333333-3333-4333-8333-333333333333', 'De La Salle University', 'A private Lasallian research university in Manila.', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('c0444444-4444-4444-8444-444444444444', 'Ateneo de Manila University', 'A private Jesuit research university in Quezon City.', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('c0555555-5555-4555-8555-555555555555', 'Mapúa University', 'A private engineering and technology university in Intramuros, Manila.', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- --- Careers --------------------------------------------------------------------------
--
-- `typical_riasec_code` is read **positionally** by §27, weighting [0.5, 0.3, 0.2] — the first
-- letter is the dominant type, so the order of these letters is data, not formatting.

INSERT OR IGNORE INTO careers (id, title, description, salary_range, employment_outlook, typical_riasec_code, status, created_at, updated_at) VALUES
('ca111111-1111-4111-8111-111111111111', 'Software Engineer', 'Designs, builds and maintains software systems.', 'PHP 40,000 - 120,000/mo', 'High demand', 'IEC', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('ca222222-2222-4222-8222-222222222222', 'Data Analyst', 'Turns raw data into decisions using statistics and visualisation.', 'PHP 35,000 - 90,000/mo', 'High demand', 'ICE', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('ca333333-3333-4333-8333-333333333333', 'Civil Engineer', 'Plans and supervises infrastructure projects.', 'PHP 30,000 - 80,000/mo', 'Stable demand', 'RIC', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('ca444444-4444-4444-8444-444444444444', 'Registered Nurse', 'Delivers direct patient care in clinical settings.', 'PHP 25,000 - 60,000/mo', 'High demand, strong overseas market', 'SIR', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('ca555555-5555-4555-8555-555555555555', 'Accountant', 'Prepares and audits financial records.', 'PHP 28,000 - 75,000/mo', 'Stable demand', 'CEI', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('ca666666-6666-4666-8666-666666666666', 'Graphic Designer', 'Creates visual communication for brands and products.', 'PHP 22,000 - 60,000/mo', 'Moderate demand', 'AER', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('ca777777-7777-4777-8777-777777777777', 'Marketing Manager', 'Owns brand strategy and go-to-market execution.', 'PHP 45,000 - 130,000/mo', 'Stable demand', 'ESA', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('ca888888-8888-4888-8888-888888888888', 'Teacher', 'Plans and delivers instruction; assesses learning.', 'PHP 25,000 - 55,000/mo', 'Stable demand', 'SAE', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('ca999999-9999-4999-8999-999999999999', 'Architect', 'Designs buildings and oversees their construction.', 'PHP 30,000 - 90,000/mo', 'Moderate demand', 'ARI', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Journalist', 'Researches, writes and reports news stories.', 'PHP 22,000 - 60,000/mo', 'Declining print, growing digital', 'AES', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- --- Programs -------------------------------------------------------------------------
--
-- `recommended_strand` NULL is a **claim** — "this program has no strand requirement" — which
-- §27 scores as a full 100. It is not "unknown". AB Communication below is the one such row,
-- and it exists precisely so the NULL branch is exercised by the demo data.

INSERT OR IGNORE INTO programs (id, college_id, code, name, department_name, description, recommended_strand, status, created_at, updated_at) VALUES
-- UP Diliman
('90111111-1111-4111-8111-111111111111', 'c0111111-1111-4111-8111-111111111111', 'BSCS',  'BS Computer Science',            'College of Engineering',        'Algorithms, systems and software engineering.',      'Academic', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('90111112-1111-4111-8111-111111111112', 'c0111111-1111-4111-8111-111111111111', 'BSCE',  'BS Civil Engineering',           'College of Engineering',        'Structural, transportation and geotechnical engineering.', 'Academic', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('90111113-1111-4111-8111-111111111113', 'c0111111-1111-4111-8111-111111111111', 'BSSTAT','BS Statistics',                  'School of Statistics',          'Statistical theory, modelling and data analysis.',   'Academic', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('90111114-1111-4111-8111-111111111114', 'c0111111-1111-4111-8111-111111111111', 'BAJ',   'BA Journalism',                  'College of Mass Communication', 'Reporting, editing and media ethics.',               'Academic', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
-- UST
('90222221-2222-4222-8222-222222222221', 'c0222222-2222-4222-8222-222222222222', 'BSN',   'BS Nursing',                     'College of Nursing',            'Clinical practice, community and public health.',    'Academic', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('90222222-2222-4222-8222-222222222222', 'c0222222-2222-4222-8222-222222222222', 'BSA',   'BS Accountancy',                 'College of Commerce',           'Financial accounting, audit and taxation.',          'Academic', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('90222223-2222-4222-8222-222222222223', 'c0222222-2222-4222-8222-222222222222', 'BSARCH','BS Architecture',                'College of Architecture',       'Architectural design, theory and practice.',         'Academic', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
-- DLSU
('90333331-3333-4333-8333-333333333331', 'c0333333-3333-4333-8333-333333333333', 'BSCS',  'BS Computer Science',            'College of Computer Studies',   'Software engineering and computing theory.',         'Academic', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('90333332-3333-4333-8333-333333333332', 'c0333333-3333-4333-8333-333333333333', 'BSMKT', 'BS Marketing Management',        'Ramon V. del Rosario CoB',      'Brand strategy, consumer behaviour and analytics.',  'Academic', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('90333333-3333-4333-8333-333333333333', 'c0333333-3333-4333-8333-333333333333', 'BSA',   'BS Accountancy',                 'Ramon V. del Rosario CoB',      'Accounting, audit and business law.',                'Academic', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
-- Ateneo — ABCOM is the deliberate NULL-strand row (§27 scores NULL as a full 100).
('90444441-4444-4444-8444-444444444441', 'c0444444-4444-4444-8444-444444444444', 'ABCOM', 'AB Communication',               'School of Humanities',          'Media, rhetoric and communication practice.',        NULL,       'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('90444442-4444-4444-8444-444444444442', 'c0444444-4444-4444-8444-444444444444', 'BSMGT', 'BS Management',                  'John Gokongwei SoM',            'General management and entrepreneurship.',           'Academic', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('90444443-4444-4444-8444-444444444443', 'c0444444-4444-4444-8444-444444444444', 'BSPSY', 'BS Psychology',                  'School of Social Sciences',     'Human behaviour, cognition and research methods.',   'Academic', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
-- Mapúa — the two Technical-Professional rows (the TVL-ICT track feeds them directly).
('90555551-5555-4555-8555-555555555551', 'c0555555-5555-4555-8555-555555555555', 'BSIT',  'BS Information Technology',      'School of IT',                  'Applied computing, networks and systems administration.', 'Technical-Professional', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('90555552-5555-4555-8555-555555555552', 'c0555555-5555-4555-8555-555555555555', 'BSCPE', 'BS Computer Engineering',        'School of EECE',                'Hardware, embedded systems and computer architecture.',   'Technical-Professional', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('90555553-5555-4555-8555-555555555553', 'c0555555-5555-4555-8555-555555555555', 'BSCE',  'BS Civil Engineering',           'School of CEGE',                'Structural design and construction management.',     'Academic', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- --- The mapping ----------------------------------------------------------------------
--
-- §27 averages `riasec_compatibility` over every ACTIVE career linked to a program to produce
-- that program's RIASEC component; a program with no links falls back to a neutral 50.
--
-- The first two rows are the ones the §27 worked example depends on: **UP Diliman's BSCS is
-- linked to exactly Software Engineer (IEC) and Data Analyst (ICE)**. Do not add a third
-- career to that program without recomputing the worked example — the average would move, and
-- Phase 4's hand-checked number with it.

INSERT OR IGNORE INTO program_careers (id, program_id, career_id) VALUES
-- UP BSCS → Software Engineer, Data Analyst  (the §27 worked example — keep it at these two)
('9c000001-0000-4000-8000-000000000001', '90111111-1111-4111-8111-111111111111', 'ca111111-1111-4111-8111-111111111111'),
('9c000002-0000-4000-8000-000000000002', '90111111-1111-4111-8111-111111111111', 'ca222222-2222-4222-8222-222222222222'),
-- UP BSCE → Civil Engineer
('9c000003-0000-4000-8000-000000000003', '90111112-1111-4111-8111-111111111112', 'ca333333-3333-4333-8333-333333333333'),
-- UP BS Statistics → Data Analyst, Software Engineer
('9c000004-0000-4000-8000-000000000004', '90111113-1111-4111-8111-111111111113', 'ca222222-2222-4222-8222-222222222222'),
('9c000005-0000-4000-8000-000000000005', '90111113-1111-4111-8111-111111111113', 'ca111111-1111-4111-8111-111111111111'),
-- UP BA Journalism → Journalist, Graphic Designer
('9c000006-0000-4000-8000-000000000006', '90111114-1111-4111-8111-111111111114', 'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
('9c000007-0000-4000-8000-000000000007', '90111114-1111-4111-8111-111111111114', 'ca666666-6666-4666-8666-666666666666'),
-- UST BSN → Registered Nurse
('9c000008-0000-4000-8000-000000000008', '90222221-2222-4222-8222-222222222221', 'ca444444-4444-4444-8444-444444444444'),
-- UST BSA → Accountant
('9c000009-0000-4000-8000-000000000009', '90222222-2222-4222-8222-222222222222', 'ca555555-5555-4555-8555-555555555555'),
-- UST BS Architecture → Architect, Graphic Designer
('9c00000a-0000-4000-8000-00000000000a', '90222223-2222-4222-8222-222222222223', 'ca999999-9999-4999-8999-999999999999'),
('9c00000b-0000-4000-8000-00000000000b', '90222223-2222-4222-8222-222222222223', 'ca666666-6666-4666-8666-666666666666'),
-- DLSU BSCS → Software Engineer, Data Analyst
('9c00000c-0000-4000-8000-00000000000c', '90333331-3333-4333-8333-333333333331', 'ca111111-1111-4111-8111-111111111111'),
('9c00000d-0000-4000-8000-00000000000d', '90333331-3333-4333-8333-333333333331', 'ca222222-2222-4222-8222-222222222222'),
-- DLSU BS Marketing → Marketing Manager, Graphic Designer
('9c00000e-0000-4000-8000-00000000000e', '90333332-3333-4333-8333-333333333332', 'ca777777-7777-4777-8777-777777777777'),
('9c00000f-0000-4000-8000-00000000000f', '90333332-3333-4333-8333-333333333332', 'ca666666-6666-4666-8666-666666666666'),
-- DLSU BSA → Accountant
('9c000010-0000-4000-8000-000000000010', '90333333-3333-4333-8333-333333333333', 'ca555555-5555-4555-8555-555555555555'),
-- Ateneo AB Communication → Journalist, Marketing Manager, Graphic Designer
('9c000011-0000-4000-8000-000000000011', '90444441-4444-4444-8444-444444444441', 'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
('9c000012-0000-4000-8000-000000000012', '90444441-4444-4444-8444-444444444441', 'ca777777-7777-4777-8777-777777777777'),
('9c000013-0000-4000-8000-000000000013', '90444441-4444-4444-8444-444444444441', 'ca666666-6666-4666-8666-666666666666'),
-- Ateneo BS Psychology → Teacher
('9c000014-0000-4000-8000-000000000014', '90444443-4444-4444-8444-444444444443', 'ca888888-8888-4888-8888-888888888888'),
-- Mapúa BSIT → Software Engineer, Data Analyst
('9c000015-0000-4000-8000-000000000015', '90555551-5555-4555-8555-555555555551', 'ca111111-1111-4111-8111-111111111111'),
('9c000016-0000-4000-8000-000000000016', '90555551-5555-4555-8555-555555555551', 'ca222222-2222-4222-8222-222222222222'),
-- Mapúa BSCPE → Software Engineer
('9c000017-0000-4000-8000-000000000017', '90555552-5555-4555-8555-555555555552', 'ca111111-1111-4111-8111-111111111111'),
-- Mapúa BSCE → Civil Engineer
('9c000018-0000-4000-8000-000000000018', '90555553-5555-4555-8555-555555555553', 'ca333333-3333-4333-8333-333333333333');

-- Migration 0020 — Case-insensitive uniqueness for career titles and college names (plan P4-12)
--
-- Closes the defect class behind P1-0 and P2-2: `careers.title` and `colleges.name` carried plain,
-- non-unique indexes, so nothing in the database prevented two rows spelling the same thing. The
-- application has always pre-checked (`assertCareerTitleFree` / `assertCollegeNameFree`), but a
-- pre-check is not an invariant — two concurrent writers both pass it and both insert.
--
-- This is not hypothetical and it is not cosmetic. §27 keeps a **top ten**, ranking every active
-- career, so two identically-coded "Software Engineer" rows both land in the same student's list and
-- the duplicate card is visible on the recommendations screen. It has happened three times:
--
--   * P1-0  — seed chaining ran 0002 and 0004, whose 15 overlapping names differ only by id;
--             `INSERT OR IGNORE` had no unique index to collide on, so both rows survived.
--   * P2-2  — two duplicate careers found **live on staging** and archived by hand:
--             "Data Scientist" twice, and "TEACHER" / "Teacher" — the second differing only by case,
--             which an exact-title check misses entirely.
--   * P2-2  — seed 0004 then refused to apply from the other end, because migration 0018's backfill
--             had already claimed the `BSCS` / `BEED` canonical entries.
--
-- Every one of those was remediated by hand. This migration makes the state unreachable instead.
--
-- ## Why the predicate is `status = 'active' AND deleted_at IS NULL`, and not the obvious one
--
-- The obvious predicate is `deleted_at IS NULL`, because that is exactly what the two `assert…Free`
-- pre-checks already scope to, and matching them looks like the consistent choice.
--
-- **It fails to apply.** Checked against the real databases before this file was written: staging
-- still holds both pairs P2-2 archived —
--
--     Data Scientist   status=active     deleted_at=NULL
--     Data Scientist   status=archived   deleted_at=NULL
--     Teacher          status=active     deleted_at=NULL
--     TEACHER          status=archived   deleted_at=NULL
--
-- P2-2 archived those rows; it did not soft-delete them, so all four have `deleted_at IS NULL` and a
-- `deleted_at`-only unique index collides on two pairs the moment it is created. That is the P2-2
-- lesson repeating in a third place: a migration verified only against a local database applies
-- cleanly and then fails on the first real one.
--
-- Narrowing to `status = 'active'` is also the *correct* boundary rather than merely the one that
-- applies. `scorableCareersForMany` — the query that feeds the ranking — filters on exactly
-- `status = 'active' AND deleted_at IS NULL`, so that is precisely the set in which a duplicate
-- corrupts a student's recommendations. It also keeps archiving usable as the remedy: an admin who
-- finds a collision archives one row, and the constraint is satisfied without deleting the record
-- (§12 keeps what the system produced).
--
-- ## The pre-checks stay stricter than this index, deliberately
--
-- `assert…Free` scopes to `deleted_at IS NULL`, so it refuses a name that clashes with an *archived*
-- row too. That is a wider net than this index and it is left alone: it prevents the naming drift
-- that promoted `colleges` out of a text column in v1.1, and the friendly field-level 422 it returns
-- is a better answer than a constraint error. The index is the floor, not the door — it exists for
-- the case the pre-check structurally cannot cover, which is two writers racing.
--
-- One consequence, recorded rather than left to be discovered: because the index is narrower, it
-- never fires where the pre-check already refuses. It fires only on a genuine race between two
-- *active* rows, which `translateUniqueViolation` turns into the same 422 the pre-check gives (H4).
--
-- ## LOWER(TRIM(...)), not COLLATE NOCASE
--
-- `TRIM` because " Teacher" and "Teacher" are the same career to every human who will read the list,
-- and a trailing space is the classic paste artefact. Verified as safe first: zero violations on
-- production *and* staging under the trimmed predicate, so this is a stricter constraint that costs
-- nothing today. `LOWER`/`TRIM` are ASCII-only in SQLite, which covers the Philippine HEI and career
-- names this catalog holds; if non-ASCII names ever arrive, the constraint quietly stops catching
-- case variants in them rather than rejecting them, so the failure mode is a missed catch, not a
-- blocked insert.
--
-- Expression indexes with a WHERE clause are supported by D1's SQLite. Both are UNIQUE indexes and
-- neither drops or rewrites a row, so this migration is non-destructive and safe under the §5b
-- rollback note (`wrangler rollback` reverts code only; an applied migration stays applied).

CREATE UNIQUE INDEX careers_title_active_unique_ci
    ON careers (LOWER(TRIM(title)))
    WHERE status = 'active' AND deleted_at IS NULL;

CREATE UNIQUE INDEX colleges_name_active_unique_ci
    ON colleges (LOWER(TRIM(name)))
    WHERE status = 'active' AND deleted_at IS NULL;

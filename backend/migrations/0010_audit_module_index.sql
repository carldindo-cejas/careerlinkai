-- Migration 0010 — audit-log module index (audit L2) — pre-production hardening.
--
-- The §54 audit viewer filters by `module` ("show me everything the Assessment module did"),
-- but 0002 indexed only user_id, action, and created_at — so that filter was a full table scan
-- against a table that grows without bound (no retention in v1). One composite index makes the
-- viewer's common query ("this module, newest first") an index range rather than a scan.
--
-- Deliberately NOT in this migration: a foreign key on `assessment_questions.source_ai_request_id`
-- (a documented migration-ordering artifact). SQLite cannot `ALTER TABLE ADD FOREIGN KEY`; adding
-- one means a full 12-step table rebuild of a central table (question_options, question_dimensions
-- and assessment_answers all reference it), and the rebuild's required `PRAGMA foreign_keys` toggle
-- does not work inside D1's migration transaction. D1 also does not reliably enforce FKs, so the
-- rebuild would be pure risk on live data for little integrity gain. The audit files it under
-- "Enhancement Suggestions → follow-up migration"; it stays there until it can be done safely
-- (e.g. on a maintenance window with an exported/reimported table).

-- Composite, mirroring the viewer's actual query shape (module + created_at ordering), not a bare
-- single-column index — the same reasoning as notifications_user_created_index in 0009.
CREATE INDEX audit_logs_module_created_index ON audit_logs (module, created_at);

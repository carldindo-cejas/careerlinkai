-- Migration 0002 — audit_logs (FULLPLAN §13.8)
--
-- Landed with the auth slice rather than with the rest of the Platform module, because
-- §38 requires every failed staff login to be audited from the moment login exists, and
-- Phase 1 (Step 2) requires every student join attempt — success and failure — to be
-- audited from the moment the join endpoint exists. Neither is deferrable to Phase 6.
--
-- Append-only: no application code path ever issues an UPDATE or DELETE against this
-- table. That is enforced by AuditService being the sole writer, and by there being no
-- other query against it in the codebase — there is no schema-level way to say it.

CREATE TABLE audit_logs (
    id          TEXT PRIMARY KEY NOT NULL,
    -- Nullable: system actions, and failed student joins where no user was ever resolved.
    user_id     TEXT REFERENCES users (id) ON DELETE SET NULL,
    action      TEXT NOT NULL,
    module      TEXT NOT NULL,
    target_type TEXT,
    target_id   TEXT,
    old_values  TEXT,
    new_values  TEXT,
    ip_address  TEXT,
    created_at  TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX audit_logs_user_id_index ON audit_logs (user_id);
CREATE INDEX audit_logs_action_index ON audit_logs (action);
CREATE INDEX audit_logs_created_at_index ON audit_logs (created_at);

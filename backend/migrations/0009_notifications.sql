-- Migration 0009 — notifications (FULLPLAN §13.8, §44) — Phase 6.
--
-- The 28th and final domain table. In-app only for v1 (§44 — email/SMS/push are §63 scope):
-- a notification is either created or it isn't, and `read_at` is the only status that will
-- ever be tracked. There is no delivery-state machine to migrate toward.
--
-- ON DELETE CASCADE rather than SET NULL: a notification is *addressed to* its recipient,
-- not evidence about them — unlike audit_logs, a row with no user means nothing.

CREATE TABLE notifications (
    id         TEXT PRIMARY KEY NOT NULL,
    user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    message    TEXT NOT NULL,
    category   TEXT NOT NULL CHECK (category IN ('ASSESSMENT', 'RECOMMENDATION', 'CLASS', 'ACCOUNT')),
    -- NULL = unread (§13.8). Set once, on first read; marking an already-read row again is a no-op.
    read_at    TEXT,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX notifications_user_id_index ON notifications (user_id);
-- The two hot queries are "my notifications, newest first" and "my unread count" — both are
-- served by this composite rather than by two single-column indexes.
CREATE INDEX notifications_user_read_index ON notifications (user_id, read_at);
CREATE INDEX notifications_user_created_index ON notifications (user_id, created_at);

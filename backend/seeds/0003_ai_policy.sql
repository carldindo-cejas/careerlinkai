-- Seed 0003 — the single GLOBAL ai_policies row (FULLPLAN §13.7, §20).
--
-- §20 (v1.2): "the single GLOBAL row is created by the seeder; deliberately no create/delete
-- endpoint." Admins edit this row's text through PATCH /admin/ai-policies/{id}; they never
-- create a second one in v1.
--
-- The updated_by FK points at the fixed admin UUID that both seeds/0001 (local) and
-- scripts/bootstrap-staff.mjs (remote) install, so this seed works against any database
-- either of those has touched. INSERT OR IGNORE: re-running never clobbers text an admin
-- has since edited.

INSERT OR IGNORE INTO ai_policies (
    id, scope, instructions, restrictions, is_active, updated_by, created_at, updated_at
) VALUES (
    '7a1e9f00-5b2c-4c8d-9e3f-0a6b4d2c8e10',
    'GLOBAL',
    'Always remind the student that these recommendations are guidance, not final decisions, and encourage them to discuss the results with their counselor and family.',
    'Never mention or compare specific tuition fees, admission chances, or entrance exam cutoffs. Never discourage a student from any path outright.',
    1,
    'fa3a4f50-3b48-485d-b43a-59a302f4a67c',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

import { describe, expect, it } from 'vitest';

import { api, createClass, createStaffUser, login } from '../helpers';

/**
 * `GET /admin/audit-logs` (FULLPLAN §20, Phase 6) — the viewer over the append-only §13.8
 * trail. The writes themselves are pinned all over the suite (every module audits its own
 * acts); this file pins the *read*: admin-only, newest first, filterable, and the one
 * response in the system that ships `old_values`/`new_values` verbatim.
 */

describe('authorization', () => {
  it('a counselor is refused — 403, not a filtered list', async () => {
    const token = await login(await createStaffUser({ role: 'counselor' }));

    const response = await api('GET', '/admin/audit-logs', { token });

    expect(response.status).toBe(403);
  });

  it('an unauthenticated caller gets 401', async () => {
    const response = await api('GET', '/admin/audit-logs');

    expect(response.status).toBe(401);
  });
});

describe('the viewer', () => {
  it('returns organically written rows, newest first, with the actor resolved by name', async () => {
    const admin = await createStaffUser({ role: 'admin', name: 'Audit Reader' });
    const counselor = await createStaffUser({ role: 'counselor', name: 'Trail Maker' });
    const counselorToken = await login(counselor);

    // Two real audited acts: the login above (STAFF_LOGIN_SUCCESS) and a class creation.
    const classRoom = await createClass(counselorToken, { name: 'Audit Fixture Class' });

    const response = await api('GET', '/admin/audit-logs', {
      token: await login(admin),
    });

    expect(response.status).toBe(200);
    expect(response.body.data.pagination.per_page).toBe(25);

    const items = response.body.data.items as any[];
    const created = items.find(
      (item) => item.action === 'CLASS_CREATED' && item.target_id === classRoom.id,
    );

    expect(created).toBeDefined();
    expect(created.user_name).toBe('Trail Maker');
    expect(created.module).toBe('Class');

    // Newest first: created_at never increases down the page.
    const timestamps = items.map((item) => item.created_at as string);
    expect([...timestamps].sort().reverse()).toEqual(timestamps);
  });

  it('filters by action prefix and by user', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const counselor = await createStaffUser({ role: 'counselor' });
    const counselorToken = await login(counselor);
    await createClass(counselorToken);

    const adminToken = await login(admin);

    const byAction = await api('GET', '/admin/audit-logs?action=CLASS_CREATED', {
      token: adminToken,
    });

    expect(byAction.status).toBe(200);
    expect(byAction.body.data.items.length).toBeGreaterThan(0);

    for (const item of byAction.body.data.items) {
      expect(item.action).toBe('CLASS_CREATED');
    }

    const byUser = await api('GET', `/admin/audit-logs?user_id=${counselor.id}`, {
      token: adminToken,
    });

    expect(byUser.status).toBe(200);
    expect(byUser.body.data.items.length).toBeGreaterThan(0);

    for (const item of byUser.body.data.items) {
      expect(item.user_id).toBe(counselor.id);
    }
  });

  it('answers 422, not 500, to an out-of-range per_page', async () => {
    const token = await login(await createStaffUser({ role: 'admin' }));

    const response = await api('GET', '/admin/audit-logs?per_page=5000', { token });

    expect(response.status).toBe(422);
  });
});

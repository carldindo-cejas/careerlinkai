import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { appSettings, auditLogs } from '@/db/schema';

import { api, createStaffUser, db, login } from '../helpers';

/**
 * The operator flags (migration 0034) — `GET`/`PATCH /admin/settings`.
 *
 * One flag today, and it is not a cosmetic one: `counselor_signup_enabled` decides whether a
 * stranger with a working mailbox can create an account that reads student results. So the three
 * things asserted here are the three that would matter at 3pm on a bad afternoon — only an admin
 * can reach it, the flip is recorded with a name attached, and the flip actually reaches the public
 * endpoint rather than only the admin's own view of it.
 */

const ENDPOINTS: [string, string][] = [
  ['GET', '/admin/settings'],
  ['PATCH', '/admin/settings'],
];

describe('authorization', () => {
  it.each(ENDPOINTS)('%s %s → 403 for a counselor', async (method, path) => {
    const token = await login(await createStaffUser({ role: 'counselor' }));

    const response = await api(method, path, {
      token,
      ...(method === 'GET' ? {} : { body: { counselor_signup_enabled: true } }),
    });

    expect(response.status).toBe(403);
  });

  it('an unauthenticated caller gets 401', async () => {
    const response = await api('GET', '/admin/settings');

    expect(response.status).toBe(401);
  });
});

describe('GET /admin/settings', () => {
  it('reports every flag in the registry', async () => {
    const token = await login(await createStaffUser({ role: 'admin' }));

    const response = await api('GET', '/admin/settings', { token });

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveProperty('counselor_signup_enabled');
    expect(typeof response.body.data.counselor_signup_enabled).toBe('boolean');
  });
});

describe('PATCH /admin/settings', () => {
  it('flips the flag, and the public endpoint agrees', async () => {
    const token = await login(await createStaffUser({ role: 'admin' }));

    const opened = await api('PATCH', '/admin/settings', {
      token,
      body: { counselor_signup_enabled: true },
    });

    expect(opened.status).toBe(200);
    expect(opened.body.data.counselor_signup_enabled).toBe(true);

    // **The assertion that matters.** An admin screen that said "open" while `/auth/signup-status`
    // said "closed" would be a switch that appears to work and does nothing.
    const publicStatus = await api('GET', '/auth/signup-status');

    expect(publicStatus.body.data.counselor_signup_open).toBe(true);

    const closed = await api('PATCH', '/admin/settings', {
      token,
      body: { counselor_signup_enabled: false },
    });

    expect(closed.body.data.counselor_signup_enabled).toBe(false);
    expect((await api('GET', '/auth/signup-status')).body.data.counselor_signup_open).toBe(false);
  });

  it('records who changed it, and what it was before', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);

    await api('PATCH', '/admin/settings', {
      token,
      body: { counselor_signup_enabled: false },
    });
    await api('PATCH', '/admin/settings', {
      token,
      body: { counselor_signup_enabled: true },
    });

    const rows = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'APP_SETTING_UPDATED'));

    const mine = rows.filter((row) => row.userId === admin.id);
    const latest = mine.at(-1);

    expect(latest).toMatchObject({ targetType: 'app_setting', targetId: 'counselor_signup_enabled' });
    // Both halves: "registration was open between 2pm and 5pm" is the question this log answers,
    // and the current value of the row cannot answer it.
    expect(latest?.oldValues).toEqual({ counselor_signup_enabled: false });
    expect(latest?.newValues).toEqual({ counselor_signup_enabled: true });

    const stored = await db().query.appSettings.findFirst({
      where: eq(appSettings.key, 'counselor_signup_enabled'),
    });

    expect(stored?.updatedBy).toBe(admin.id);
  });

  it('refuses a body naming a setting that does not exist', async () => {
    const token = await login(await createStaffUser({ role: 'admin' }));

    const response = await api('PATCH', '/admin/settings', {
      token,
      body: { counselor_signup_enabled: true, allow_everything: true },
    });

    // Refused rather than partially applied: "we quietly did nothing about the key you did not
    // recognise" is the wrong answer to a client that believes it changed something.
    expect(response.status).toBe(422);
  });

  it('refuses an empty body rather than reporting a change that did not happen', async () => {
    const token = await login(await createStaffUser({ role: 'admin' }));

    const response = await api('PATCH', '/admin/settings', { token, body: {} });

    expect(response.status).toBe(422);
  });

  it('refuses a non-boolean value', async () => {
    const token = await login(await createStaffUser({ role: 'admin' }));

    const response = await api('PATCH', '/admin/settings', {
      token,
      body: { counselor_signup_enabled: 'yes' },
    });

    expect(response.status).toBe(422);
  });
});

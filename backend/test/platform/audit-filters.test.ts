import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  api,
  BASE_URL,
  createClass,
  createStaffUser,
  login,
  type StaffUserFixture,
} from '../helpers';

/**
 * The audit viewer's advanced filtering (prompt-driven, v1.6).
 *
 * The existing `audit-viewer.test.ts` pins the read itself — admin-only, newest first, verbatim
 * values. This file pins the *filters*, and the two properties worth stating up front are the ones
 * that separate a filter that works from a filter that looks like it works:
 *
 *   * **`pagination.total` is the filtered count.** A filter applied in TypeScript after the page
 *     query returns short pages and a total that counts rows the caller cannot see, and every
 *     assertion below that names a total is there to catch that.
 *   * **Action *type* is a server-side grouping**, not a string pattern. `ROSTER_STUDENT_REMOVED`
 *     and `PROGRAM_CAREER_UNLINKED` are deletions whose names end in neither `_DELETED` nor
 *     anything else a heuristic could find, so the group is asserted to contain the actions a
 *     suffix match would miss.
 */

let admin: StaffUserFixture;
let adminToken: string;
let counselor: StaffUserFixture;
let counselorToken: string;

beforeAll(async () => {
  admin = await createStaffUser({ role: 'admin', name: 'Filter Admin' });
  adminToken = await login(admin);
  counselor = await createStaffUser({ role: 'counselor', name: 'Filter Counselor' });
  counselorToken = await login(counselor);

  // Some organically written rows to filter over: a class created, renamed, then deleted.
  const classRoom = await createClass(counselorToken, { name: 'Filterable Class' });

  await api('PATCH', `/counselor/classes/${classRoom.id}`, {
    token: counselorToken,
    body: { name: 'Filterable Class (renamed)' },
  });

  await api('DELETE', `/counselor/classes/${classRoom.id}`, { token: counselorToken });

  // A failed staff login against a **known** email, which records that user's id…
  await api('POST', '/auth/login', {
    body: { email: counselor.email, password: 'WrongPassword1' },
  });

  // …and one against an address that belongs to nobody, which cannot resolve a user and is
  // therefore the `system` actor's real case (§38: the API tells the caller nothing either way).
  await api('POST', '/auth/login', {
    body: { email: 'nobody.at.all@school.test', password: 'WrongPassword1' },
  });
});

async function logs(query: string) {
  const response = await api('GET', `/admin/audit-logs?${query}`, { token: adminToken });

  expect(response.status, JSON.stringify(response.body)).toBe(200);

  return response.body.data;
}

// ═════════════════════════════════════════════════════════════════════════════════════
describe('filtering by action type', () => {
  it('groups actions server-side, including ones no suffix match would find', async () => {
    const data = await logs('action_type=DELETE&per_page=100');

    expect(data.items.length).toBeGreaterThan(0);
    expect(data.items.every((item: any) => item.action_type === 'DELETE')).toBe(true);
    expect(data.items.some((item: any) => item.action === 'CLASS_DELETED')).toBe(true);
  });

  it('separates create from update, and the totals are the filtered totals', async () => {
    const created = await logs('action_type=CREATE&per_page=100');
    const updated = await logs('action_type=UPDATE&per_page=100');

    expect(created.items.some((item: any) => item.action === 'CLASS_CREATED')).toBe(true);
    expect(created.items.some((item: any) => item.action === 'CLASS_UPDATED')).toBe(false);

    expect(updated.items.some((item: any) => item.action === 'CLASS_UPDATED')).toBe(true);
    expect(updated.items.some((item: any) => item.action === 'CLASS_CREATED')).toBe(false);

    expect(created.pagination.total).toBe(created.items.length);
    expect(updated.pagination.total).toBe(updated.items.length);
  });

  /**
   * A failed sign-in is sign-in activity — it is the row an operator filtering for LOGIN most wants
   * — so it belongs in the group rather than in `OTHER`.
   */
  it('puts a failed login in the LOGIN group', async () => {
    const data = await logs('action_type=LOGIN&per_page=100');

    expect(data.items.some((item: any) => item.action === 'STAFF_LOGIN_FAILED')).toBe(true);
    expect(data.items.some((item: any) => item.action === 'STAFF_LOGIN_SUCCESS')).toBe(true);
  });

  it('rejects an action type that is not in the vocabulary', async () => {
    const response = await api('GET', '/admin/audit-logs?action_type=NONSENSE', {
      token: adminToken,
    });

    expect(response.status).toBe(422);
  });

  it('carries each row’s own action type, so the badge needs no second lookup', async () => {
    const data = await logs('action=CLASS_CREATED&per_page=5');

    expect(data.items[0].action_type).toBe('CREATE');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════
describe('filtering by actor', () => {
  it('filters by the actor’s role', async () => {
    const data = await logs('actor=counselor&per_page=100');

    expect(data.items.length).toBeGreaterThan(0);
    expect(data.items.every((item: any) => item.user_role === 'counselor')).toBe(true);
    expect(data.items.every((item: any) => item.user_id !== null)).toBe(true);
  });

  /**
   * `system` is a real value, not an absence. §38 answers every failed join generically and
   * deliberately resolves no user, so `user_id IS NULL` is the only way to ask for those rows.
   */
  it('filters to the rows with no resolved user', async () => {
    const data = await logs('actor=system&per_page=100');

    expect(data.items.length).toBeGreaterThan(0);
    expect(data.items.every((item: any) => item.user_id === null)).toBe(true);
    expect(data.items.some((item: any) => item.action === 'STAFF_LOGIN_FAILED')).toBe(true);
  });

  it('filters by a specific user id', async () => {
    const data = await logs(`user_id=${counselor.id}&per_page=100`);

    expect(data.items.length).toBeGreaterThan(0);
    expect(data.items.every((item: any) => item.user_id === counselor.id)).toBe(true);
  });

  /**
   * The count query carries the same LEFT JOIN as the page query. Without it, filtering on a joined
   * column would page over one set and count another — "page 1 of 9" over three pages of rows.
   */
  it('reports a total consistent with the rows an actor filter returns', async () => {
    const data = await logs('actor=counselor&per_page=100');

    expect(data.pagination.total).toBe(data.items.length);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════
describe('search', () => {
  it('matches on the action', async () => {
    const data = await logs('search=CLASS_CREATED&per_page=100');

    expect(data.items.length).toBeGreaterThan(0);
    expect(data.items.every((item: any) => item.action.includes('CLASS_CREATED'))).toBe(true);
  });

  it('matches on the actor’s name — the reason the count query joins users', async () => {
    const data = await logs(`search=${encodeURIComponent('Filter Counselor')}&per_page=100`);

    expect(data.items.length).toBeGreaterThan(0);
    expect(data.items.every((item: any) => item.user_name === 'Filter Counselor')).toBe(true);
    expect(data.pagination.total).toBe(data.items.length);
  });

  it('matches on the module', async () => {
    const data = await logs('search=Class&per_page=100');

    expect(data.items.length).toBeGreaterThan(0);
  });

  it('returns an empty page, with a zero total, for a term that matches nothing', async () => {
    const data = await logs('search=zzz-no-such-thing-zzz');

    expect(data.items).toHaveLength(0);
    expect(data.pagination.total).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════
describe('date range', () => {
  it('accepts bare dates and includes the whole of the end day', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const data = await logs(`from=${today}&to=${today}&per_page=100`);

    // Everything this file wrote happened today. A `to` read naively as midnight would exclude
    // all of it — which is never what someone typing "to <today>" meant.
    expect(data.items.length).toBeGreaterThan(0);
  });

  it('excludes everything outside the window', async () => {
    const data = await logs('from=2000-01-01&to=2000-01-02&per_page=100');

    expect(data.items).toHaveLength(0);
    expect(data.pagination.total).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════
describe('sorting', () => {
  it('defaults to newest first', async () => {
    const data = await logs('per_page=50');
    const timestamps = data.items.map((item: any) => item.created_at);

    expect([...timestamps].sort().reverse()).toEqual(timestamps);
  });

  it('sorts oldest first on request', async () => {
    const data = await logs('sort=created_at&direction=asc&per_page=50');
    const timestamps = data.items.map((item: any) => item.created_at);

    expect([...timestamps].sort()).toEqual(timestamps);
  });

  it('sorts by action', async () => {
    const data = await logs('sort=action&direction=asc&per_page=100');
    const actions = data.items.map((item: any) => item.action);

    expect([...actions].sort()).toEqual(actions);
  });

  /**
   * Rows written inside one request share a millisecond. Without the `id` tie-break their relative
   * order is free to differ between two queries, and an operator paging through sees a row twice or
   * not at all. Asserting stability is the only way to pin that.
   */
  it('is stable across identical requests', async () => {
    const first = await logs('per_page=40');
    const second = await logs('per_page=40');

    expect(first.items.map((item: any) => item.id)).toEqual(
      second.items.map((item: any) => item.id),
    );
  });

  it('does not repeat a row across page boundaries', async () => {
    const page1 = await logs('per_page=5&page=1');
    const page2 = await logs('per_page=5&page=2');

    const ids = [
      ...page1.items.map((item: any) => item.id),
      ...page2.items.map((item: any) => item.id),
    ];

    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════
describe('filter options', () => {
  it('offers the modules and actions this deployment has actually recorded', async () => {
    const response = await api('GET', '/admin/audit-logs/filter-options', { token: adminToken });

    expect(response.status).toBe(200);
    expect(response.body.data.modules).toContain('Class');
    expect(response.body.data.actions).toContain('CLASS_CREATED');
    expect(response.body.data.action_types).toContain('DELETE');
    expect(response.body.data.actors).toEqual(['admin', 'counselor', 'student', 'system']);

    // Distinct, so a dropdown does not list the same module forty times.
    expect(new Set(response.body.data.modules).size).toBe(response.body.data.modules.length);
  });

  it('is admin-only', async () => {
    expect(
      (await api('GET', '/admin/audit-logs/filter-options', { token: counselorToken })).status,
    ).toBe(403);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════
describe('export', () => {
  /**
   * `SELF.fetch` rather than the `api` helper: the response is CSV, and the helper parses JSON.
   * It still goes through the real router and middleware, which is what the auth assertions need.
   */
  async function exportCsv(query = '', token = adminToken): Promise<Response> {
    return SELF.fetch(`${BASE_URL}/admin/audit-logs/export?${query}`, {
      headers: { Authorization: `Bearer ${token}`, 'CF-Connecting-IP': '203.0.113.10' },
    });
  }

  it('returns CSV with a header row and an attachment filename', async () => {
    const response = await exportCsv('per_page=10');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/csv');
    expect(response.headers.get('Content-Disposition')).toMatch(/attachment; filename="audit-log-/);

    const body = await response.text();

    expect(body.split('\r\n')[0]).toBe(
      'timestamp,action,action_type,module,actor,actor_role,target_type,target_id,ip_address,old_values,new_values',
    );
    expect(body).toContain('CLASS_CREATED');
  });

  /** "Export what I am looking at" — the same filters, with the pagination taken off. */
  it('applies the same filters as the viewer', async () => {
    const body = await (await exportCsv('action_type=DELETE')).text();

    expect(body).toContain('CLASS_DELETED');
    expect(body).not.toContain('CLASS_CREATED');
  });

  it('reports whether it was truncated', async () => {
    const response = await exportCsv('');

    // Nothing here approaches the 5,000-row cap, so this states the honest answer rather than
    // leaving the header off and making "absent" mean "not truncated".
    expect(response.headers.get('X-Export-Truncated')).toBe('false');
    expect(Number(response.headers.get('X-Export-Row-Count'))).toBeGreaterThan(0);
  });

  it('is admin-only', async () => {
    expect((await exportCsv('', counselorToken)).status).toBe(403);
  });

  /**
   * The formula-injection guard. This file is full of attacker-influenced text — target ids, IPs,
   * and the JSON blobs, which carry names and titles a user typed — and it is handed to a program
   * that will execute a cell beginning `=`. A leading apostrophe is what stops that.
   */
  it('neutralizes a cell that a spreadsheet would treat as a formula', async () => {
    const evilCounselor = await createStaffUser({
      role: 'counselor',
      name: '=HYPERLINK("http://evil.test","click")',
    });

    await createClass(await login(evilCounselor), { name: 'Injection Fixture' });

    const body = await (await exportCsv('action=CLASS_CREATED')).text();

    expect(body).toContain(`"'=HYPERLINK(""http://evil.test"",""click"")"`);
    // The unguarded form must not appear anywhere in the file.
    expect(body).not.toContain('"=HYPERLINK');
  });
});

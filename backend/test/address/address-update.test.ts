import { describe, expect, it } from 'vitest';

import { api, createStaffUser, login } from '../helpers';

/**
 * Editing one place (prompt-driven, v1.5) — `PATCH /admin/{level}/{id}`. A rename (or a code fix) that
 * never re-parents, with duplicate names caught per parent scope, exactly as the bulk import dedupes.
 *
 * Also the regression net for the bulk-import 500: a large paste is inserted in chunks small enough to
 * stay under D1's 100-bound-parameter cap, and the whole set must still land. Miniflare does not
 * enforce that cap, so this asserts the *result* — every pasted row created — rather than the limit.
 */

async function adminToken(): Promise<string> {
  return login(await createStaffUser({ role: 'admin' }));
}

async function createRegion(token: string, name: string): Promise<string> {
  const response = await api('POST', '/admin/regions/bulk', { token, body: { items: [{ name }] } });
  expect(response.status).toBe(201);

  return response.body.data.created[0].id;
}

async function createProvince(token: string, regionId: string, name: string): Promise<string> {
  const response = await api('POST', `/admin/regions/${regionId}/provinces/bulk`, {
    token,
    body: { items: [{ name }] },
  });
  expect(response.status).toBe(201);

  return response.body.data.created[0].id;
}

describe('PATCH /admin/regions/:id', () => {
  it('renames a region and reflects it in the list', async () => {
    const token = await adminToken();
    const id = await createRegion(token, `Before ${crypto.randomUUID()}`);
    const after = `After ${crypto.randomUUID()}`;

    const response = await api('PATCH', `/admin/regions/${id}`, { token, body: { name: after } });

    expect(response.status).toBe(200);
    expect(response.body.data.name).toBe(after);

    const list = await api('GET', `/admin/regions?search=${encodeURIComponent(after)}`, { token });
    expect(list.body.data.items.map((r: any) => r.name)).toContain(after);
  });

  it('rejects a rename that collides with another live region, case-insensitively', async () => {
    const token = await adminToken();
    const taken = `Taken ${crypto.randomUUID()}`;
    await createRegion(token, taken);
    const id = await createRegion(token, `Mover ${crypto.randomUUID()}`);

    const response = await api('PATCH', `/admin/regions/${id}`, {
      token,
      body: { name: taken.toUpperCase() },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.name).toBeDefined();
  });

  it('allows renaming a row to a case-variant of its own name (not a false clash)', async () => {
    const token = await adminToken();
    const name = `Manila ${crypto.randomUUID()}`;
    const id = await createRegion(token, name);

    const response = await api('PATCH', `/admin/regions/${id}`, {
      token,
      body: { name: name.toUpperCase() },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.name).toBe(name.toUpperCase());
  });

  it('404s on a region that does not exist', async () => {
    const response = await api('PATCH', '/admin/regions/does-not-exist', {
      token: await adminToken(),
      body: { name: 'Whatever' },
    });

    expect(response.status).toBe(404);
  });

  it('rejects an empty name', async () => {
    const token = await adminToken();
    const id = await createRegion(token, `Named ${crypto.randomUUID()}`);

    const response = await api('PATCH', `/admin/regions/${id}`, { token, body: { name: '  ' } });

    expect(response.status).toBe(422);
  });
});

describe('PATCH scopes uniqueness to the parent and preserves it', () => {
  it('renames a province without re-parenting it', async () => {
    const token = await adminToken();
    const regionId = await createRegion(token, `R ${crypto.randomUUID()}`);
    const provinceId = await createProvince(token, regionId, 'Old Province');

    const renamed = await api('PATCH', `/admin/provinces/${provinceId}`, {
      token,
      body: { name: 'New Province' },
    });
    expect(renamed.status).toBe(200);

    // Still listed under the same region — the parent was preserved.
    const list = await api('GET', `/admin/regions/${regionId}/provinces`, { token });
    const names = list.body.data.items.map((p: any) => p.name);
    expect(names).toContain('New Province');
    expect(names).not.toContain('Old Province');
  });

  it('lets two provinces in different regions share a name after a rename', async () => {
    const token = await adminToken();
    const regionA = await createRegion(token, `A ${crypto.randomUUID()}`);
    const regionB = await createRegion(token, `B ${crypto.randomUUID()}`);
    await createProvince(token, regionA, 'Shared Name');
    const bId = await createProvince(token, regionB, 'Different Name');

    // Same name as region A's province, but under region B — a different scope, so allowed.
    const response = await api('PATCH', `/admin/provinces/${bId}`, {
      token,
      body: { name: 'Shared Name' },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.name).toBe('Shared Name');
  });
});

describe('bulk import stays under D1 limits (the 500 regression)', () => {
  it('creates every province in a paste large enough to overflow one statement', async () => {
    const token = await adminToken();
    const regionId = await createRegion(token, `Big ${crypto.randomUUID()}`);

    // A province row is seven columns, so 40 rows is 280 bound parameters — far past D1's 100 cap for
    // a single statement. Chunked, every row must still be created.
    const items = Array.from({ length: 40 }, (_, i) => ({ name: `Prov ${i}` }));

    const response = await api('POST', `/admin/regions/${regionId}/provinces/bulk`, {
      token,
      body: { items },
    });

    expect(response.status).toBe(201);
    expect(response.body.data.created).toHaveLength(40);
    expect(response.body.data.skipped).toHaveLength(0);

    const list = await api('GET', `/admin/regions/${regionId}/provinces?per_page=100`, { token });
    expect(list.body.data.pagination.total).toBe(40);
  });
});

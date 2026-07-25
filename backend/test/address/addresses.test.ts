import { describe, expect, it } from 'vitest';

import { api, createStaffUser, login } from '../helpers';

/**
 * The Philippine address hierarchy — Region → Province → Town → Barangay (migration 0011).
 *
 * The load-bearing rule under test is the bulk import's "ignore duplicates": it must dedupe both
 * against what is already stored and within the pasted payload, case-insensitively, and it must do
 * so *per parent scope* — the same town name under two different provinces is two real places.
 */

async function adminToken(): Promise<string> {
  return login(await createStaffUser({ role: 'admin' }));
}

/** Create a region and return its id — the root every deeper level hangs off. */
async function createRegion(token: string, name = `Region ${crypto.randomUUID()}`): Promise<string> {
  const response = await api('POST', '/admin/regions/bulk', {
    token,
    body: { items: [{ name }] },
  });

  expect(response.status).toBe(201);

  return response.body.data.created[0].id;
}

describe('POST /admin/regions/bulk', () => {
  it('creates the checked regions, reporting what it added', async () => {
    const token = await adminToken();
    const a = `NCR ${crypto.randomUUID()}`;
    const b = `CAR ${crypto.randomUUID()}`;

    const response = await api('POST', '/admin/regions/bulk', {
      token,
      body: { items: [{ name: a }, { name: b }] },
    });

    expect(response.status).toBe(201);
    expect(response.body.data.created).toHaveLength(2);
    expect(response.body.data.skipped).toHaveLength(0);
    expect(response.body.data.created.map((r: any) => r.name)).toEqual([a, b]);
  });

  it('ignores duplicates against stored rows and within the payload, case-insensitively', async () => {
    const token = await adminToken();
    const existing = `Calabarzon ${crypto.randomUUID()}`;
    await createRegion(token, existing);

    const fresh = `Mimaropa ${crypto.randomUUID()}`;

    const response = await api('POST', '/admin/regions/bulk', {
      token,
      body: {
        items: [
          { name: existing.toUpperCase() }, // duplicate of a stored row, different case
          { name: fresh },
          { name: fresh.toLowerCase() }, // duplicate within this same payload
        ],
      },
    });

    expect(response.status).toBe(201);
    expect(response.body.data.created).toHaveLength(1);
    expect(response.body.data.created[0].name).toBe(fresh);
    expect(response.body.data.skipped).toHaveLength(2);
    expect(response.body.data.skipped.every((s: any) => s.reason === 'duplicate')).toBe(true);
  });

  it('rejects an empty item list', async () => {
    const response = await api('POST', '/admin/regions/bulk', {
      token: await adminToken(),
      body: { items: [] },
    });

    expect(response.status).toBe(422);
  });
});

describe('the hierarchy is scoped to its parent', () => {
  it('lets the same town name live under two different provinces', async () => {
    const token = await adminToken();
    const regionId = await createRegion(token);

    const provinces = await api('POST', `/admin/regions/${regionId}/provinces/bulk`, {
      token,
      body: { items: [{ name: 'Province One' }, { name: 'Province Two' }] },
    });
    const [p1, p2] = provinces.body.data.created;

    const town = 'San Isidro'; // a genuinely common PH town name

    const first = await api('POST', `/admin/provinces/${p1.id}/towns/bulk`, {
      token,
      body: { items: [{ name: town }] },
    });
    const second = await api('POST', `/admin/provinces/${p2.id}/towns/bulk`, {
      token,
      body: { items: [{ name: town }] },
    });

    expect(first.body.data.created).toHaveLength(1);
    // Same name, different province — not a duplicate.
    expect(second.body.data.created).toHaveLength(1);
    expect(second.body.data.skipped).toHaveLength(0);
  });

  it('404s importing under a parent that does not exist', async () => {
    const response = await api('POST', '/admin/regions/does-not-exist/provinces/bulk', {
      token: await adminToken(),
      body: { items: [{ name: 'Orphan' }] },
    });

    expect(response.status).toBe(404);
  });
});

describe('GET list endpoints', () => {
  it('searches by name, omits soft-deleted rows, and paginates', async () => {
    const token = await adminToken();
    const regionId = await createRegion(token);

    const kept = `Batangas ${crypto.randomUUID()}`;
    const removed = `Bulacan ${crypto.randomUUID()}`;

    const created = await api('POST', `/admin/regions/${regionId}/provinces/bulk`, {
      token,
      body: { items: [{ name: kept }, { name: removed }] },
    });
    const removedId = created.body.data.created.find((p: any) => p.name === removed).id;

    await api('DELETE', `/admin/provinces/${removedId}`, { token });

    const list = await api('GET', `/admin/regions/${regionId}/provinces?per_page=100`, { token });
    const names = list.body.data.items.map((p: any) => p.name);

    expect(list.status).toBe(200);
    expect(names).toContain(kept);
    expect(names).not.toContain(removed);

    const searched = await api(
      'GET',
      `/admin/regions/${regionId}/provinces?search=${encodeURIComponent(kept)}`,
      { token },
    );
    expect(searched.body.data.items).toHaveLength(1);
    expect(searched.body.data.items[0].name).toBe(kept);
  });

  it('frees a name again once the row is soft-deleted', async () => {
    const token = await adminToken();
    const name = `Freed ${crypto.randomUUID()}`;

    const first = await api('POST', '/admin/regions/bulk', { token, body: { items: [{ name }] } });
    const id = first.body.data.created[0].id;

    await api('DELETE', `/admin/regions/${id}`, { token });

    // The partial unique index only covers live rows, so the name is available again.
    const second = await api('POST', '/admin/regions/bulk', { token, body: { items: [{ name }] } });

    expect(second.body.data.created).toHaveLength(1);
    expect(second.body.data.skipped).toHaveLength(0);
  });

  it('clamps per_page to 100', async () => {
    const response = await api('GET', '/admin/regions?per_page=101', { token: await adminToken() });

    expect(response.status).toBe(422);
  });
});

describe('deleting a region cascades to its whole subtree', () => {
  it('soft-deletes provinces, towns and barangays beneath it', async () => {
    const token = await adminToken();
    const regionId = await createRegion(token);

    const province = await api('POST', `/admin/regions/${regionId}/provinces/bulk`, {
      token,
      body: { items: [{ name: 'Prov' }] },
    });
    const provinceId = province.body.data.created[0].id;

    const town = await api('POST', `/admin/provinces/${provinceId}/towns/bulk`, {
      token,
      body: { items: [{ name: 'Town' }] },
    });
    const townId = town.body.data.created[0].id;

    await api('POST', `/admin/towns/${townId}/barangays/bulk`, {
      token,
      body: { items: [{ name: 'Brgy 1' }, { name: 'Brgy 2' }] },
    });

    const deleted = await api('DELETE', `/admin/regions/${regionId}`, { token });
    expect(deleted.status).toBe(204);

    // The town is gone with its region, so listing its barangays 404s on the missing town.
    const barangays = await api('GET', `/admin/towns/${townId}/barangays`, { token });
    expect(barangays.status).toBe(404);

    // And the province list for the region comes back empty.
    const provinces = await api('GET', `/admin/regions/${regionId}/provinces`, { token });
    expect(provinces.status).toBe(404); // the region itself is gone
  });
});

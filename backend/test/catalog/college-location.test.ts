import { describe, expect, it } from 'vitest';

import { api, createStaffUser, login } from '../helpers';

/**
 * The college school address + Google Maps link (backend migration 0012).
 *
 * The address is four FKs into the §0011 hierarchy, not free text — so the rules under test are the
 * ones only a live-row lookup can enforce: the chain must be contiguous and correctly parented, and
 * the map link must actually be a Google Maps URL. The cascading dropdowns exist to keep an admin
 * from ever submitting a broken chain; these tests are the net under that.
 */

async function adminToken(): Promise<string> {
  return login(await createStaffUser({ role: 'admin' }));
}

const unique = () => crypto.randomUUID().slice(0, 8);

async function importOne(
  token: string,
  url: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const response = await api('POST', url, { token, body: { items: [{ name }] } });

  if (response.status !== 201) {
    throw new Error(`Fixture import failed: ${JSON.stringify(response.body)}`);
  }

  return response.body.data.created[0];
}

/** Build a full Region → Province → Town → Barangay chain through the real bulk endpoints. */
async function addressChain(token: string) {
  const region = await importOne(token, '/admin/regions/bulk', `Region ${unique()}`);
  const province = await importOne(
    token,
    `/admin/regions/${region.id}/provinces/bulk`,
    `Province ${unique()}`,
  );
  const town = await importOne(
    token,
    `/admin/provinces/${province.id}/towns/bulk`,
    `Town ${unique()}`,
  );
  const barangay = await importOne(
    token,
    `/admin/towns/${town.id}/barangays/bulk`,
    `Barangay ${unique()}`,
  );

  return { region, province, town, barangay };
}

describe('college school address (migration 0012)', () => {
  it('stores the four FKs and returns each level resolved to a name', async () => {
    const token = await adminToken();
    const { region, province, town, barangay } = await addressChain(token);

    const response = await api('POST', '/admin/colleges', {
      token,
      body: {
        name: `University of ${unique()}`,
        region_id: region.id,
        province_id: province.id,
        town_id: town.id,
        barangay_id: barangay.id,
        map_link: 'https://maps.app.goo.gl/abc123',
      },
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      region: { id: region.id, name: region.name },
      province: { id: province.id, name: province.name },
      town: { id: town.id, name: town.name },
      barangay: { id: barangay.id, name: barangay.name },
      map_link: 'https://maps.app.goo.gl/abc123',
    });
  });

  it('rejects a province that does not belong to the chosen region', async () => {
    const token = await adminToken();
    const chain = await addressChain(token);
    const otherRegion = await importOne(token, '/admin/regions/bulk', `Region ${unique()}`);

    const response = await api('POST', '/admin/colleges', {
      token,
      body: {
        name: `University of ${unique()}`,
        region_id: otherRegion.id,
        province_id: chain.province.id,
      },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.province_id).toBeDefined();
  });

  it('rejects a gap in the chain — a province with no region', async () => {
    const token = await adminToken();
    const chain = await addressChain(token);

    const response = await api('POST', '/admin/colleges', {
      token,
      body: { name: `University of ${unique()}`, province_id: chain.province.id },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.region_id).toBeDefined();
  });

  it('accepts a partial chain — region and province, no town', async () => {
    const token = await adminToken();
    const { region, province } = await addressChain(token);

    const response = await api('POST', '/admin/colleges', {
      token,
      body: { name: `University of ${unique()}`, region_id: region.id, province_id: province.id },
    });

    expect(response.status).toBe(201);
    expect(response.body.data.town).toBeNull();
    expect(response.body.data.barangay).toBeNull();
  });

  it('lets an admin edit the address as a unit and clear the map link', async () => {
    const token = await adminToken();
    const { region, province } = await addressChain(token);

    const college = (
      await api('POST', '/admin/colleges', {
        token,
        body: {
          name: `University of ${unique()}`,
          region_id: region.id,
          province_id: province.id,
          map_link: 'https://www.google.com/maps/place/Manila',
        },
      })
    ).body.data;

    const response = await api('PATCH', `/admin/colleges/${college.id}`, {
      token,
      body: { region_id: region.id, province_id: null, town_id: null, barangay_id: null, map_link: null },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.province).toBeNull();
    expect(response.body.data.map_link).toBeNull();
    expect(response.body.data.region).toMatchObject({ id: region.id });
  });
});

describe('the school map link', () => {
  it('rejects a link that is not a Google Maps URL', async () => {
    const response = await api('POST', '/admin/colleges', {
      token: await adminToken(),
      body: { name: `University of ${unique()}`, map_link: 'https://example.com/place' },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.map_link).toBeDefined();
  });

  it('rejects a javascript: payload masquerading as a link', async () => {
    const response = await api('POST', '/admin/colleges', {
      token: await adminToken(),
      body: { name: `University of ${unique()}`, map_link: 'javascript:alert(1)' },
    });

    expect(response.status).toBe(422);
  });

  it('accepts the common Google Maps link shapes', async () => {
    const token = await adminToken();

    for (const link of [
      'https://maps.app.goo.gl/abc123',
      'https://maps.google.com/?q=14.6,121.0',
      'https://www.google.com/maps/place/UST',
      'https://goo.gl/maps/xyz',
    ]) {
      const response = await api('POST', '/admin/colleges', {
        token,
        body: { name: `University of ${unique()}`, map_link: link },
      });

      expect(response.status, `link: ${link}`).toBe(201);
      expect(response.body.data.map_link).toBe(link);
    }
  });

  it('treats an empty map link as "no map"', async () => {
    const response = await api('POST', '/admin/colleges', {
      token: await adminToken(),
      body: { name: `University of ${unique()}`, map_link: '' },
    });

    expect(response.status).toBe(201);
    expect(response.body.data.map_link).toBeNull();
  });

  it('preserves the map link on an update that does not mention it', async () => {
    const token = await adminToken();

    const college = (
      await api('POST', '/admin/colleges', {
        token,
        body: { name: `University of ${unique()}`, map_link: 'https://maps.app.goo.gl/keep' },
      })
    ).body.data;

    // A status-only PATCH — like the "Archive" button — must not wipe the map link.
    const response = await api('PATCH', `/admin/colleges/${college.id}`, {
      token,
      body: { status: 'archived' },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.map_link).toBe('https://maps.app.goo.gl/keep');
  });
});

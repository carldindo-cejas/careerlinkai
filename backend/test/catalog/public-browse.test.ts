import { describe, expect, it } from 'vitest';

import { api, createProgram, createStaffUser, login } from '../helpers';

/**
 * The public Colleges and Careers browse (prompt-driven, v1.5) — `GET /colleges/public`,
 * `/careers/public`, `/regions/public`, `/employment-outlooks/public`. All unauthenticated, all
 * active-chain only (what the engine would recommend is what the public may see), and the college
 * cards carry the resolved address, the map link, and a capped program preview with the true total.
 *
 * The shared test database is written by many suites at once, so every assertion here is scoped to
 * ids and names this test created rather than to global counts.
 */

async function adminToken(): Promise<string> {
  return login(await createStaffUser({ role: 'admin' }));
}

async function createRegion(token: string, name: string): Promise<string> {
  const response = await api('POST', '/admin/regions/bulk', { token, body: { items: [{ name }] } });
  expect(response.status).toBe(201);

  return response.body.data.created[0].id;
}

async function createCollegeWith(
  token: string,
  body: Record<string, unknown>,
): Promise<{ id: string; name: string }> {
  const response = await api('POST', '/admin/colleges', { token, body });
  expect(response.status).toBe(201);

  return response.body.data;
}

describe('GET /colleges/public', () => {
  it('needs no token and returns active colleges with address, map link and a capped program preview', async () => {
    const token = await adminToken();
    const regionName = `NCR ${crypto.randomUUID()}`;
    const regionId = await createRegion(token, regionName);

    const mapLink = 'https://maps.app.goo.gl/abc123';
    const college = await createCollegeWith(token, {
      name: `Public College ${crypto.randomUUID()}`,
      region_id: regionId,
      map_link: mapLink,
    });

    // Four active programs — the card previews at most three and reports the true total.
    for (let i = 0; i < 4; i += 1) {
      await createProgram(token, college.id, { name: `Program ${i}` });
    }

    const response = await api('GET', '/colleges/public');
    expect(response.status).toBe(200);

    const served = response.body.data.colleges.find((entry: any) => entry.id === college.id);
    expect(served).toBeDefined();
    expect(served.region.name).toBe(regionName);
    expect(served.map_link).toBe(mapLink);
    expect(served.programs).toHaveLength(3);
    expect(served.programs_count).toBe(4);
  });

  it('omits archived colleges', async () => {
    const token = await adminToken();
    const college = await createCollegeWith(token, { name: `Archived ${crypto.randomUUID()}` });

    await api('PATCH', `/admin/colleges/${college.id}`, { token, body: { status: 'archived' } });

    const response = await api('GET', '/colleges/public');
    const ids = response.body.data.colleges.map((entry: any) => entry.id);
    expect(ids).not.toContain(college.id);
  });

  it('filters by region', async () => {
    const token = await adminToken();
    const regionA = await createRegion(token, `RA ${crypto.randomUUID()}`);
    const regionB = await createRegion(token, `RB ${crypto.randomUUID()}`);
    const inA = await createCollegeWith(token, {
      name: `In A ${crypto.randomUUID()}`,
      region_id: regionA,
    });
    const inB = await createCollegeWith(token, {
      name: `In B ${crypto.randomUUID()}`,
      region_id: regionB,
    });

    const response = await api('GET', `/colleges/public?region_id=${regionA}`);
    const ids = response.body.data.colleges.map((entry: any) => entry.id);

    expect(ids).toContain(inA.id);
    expect(ids).not.toContain(inB.id);
  });

  it('hides the map link as null when none is set', async () => {
    const token = await adminToken();
    const college = await createCollegeWith(token, { name: `No Map ${crypto.randomUUID()}` });

    const response = await api('GET', '/colleges/public');
    const served = response.body.data.colleges.find((entry: any) => entry.id === college.id);

    expect(served.map_link).toBeNull();
  });
});

describe('GET /regions/public', () => {
  it('lists only regions that actually have an active college', async () => {
    const token = await adminToken();
    const withCollege = `Populated ${crypto.randomUUID()}`;
    const empty = `Empty ${crypto.randomUUID()}`;
    const populatedId = await createRegion(token, withCollege);
    await createRegion(token, empty); // no college hangs off it

    await createCollegeWith(token, {
      name: `Anchor ${crypto.randomUUID()}`,
      region_id: populatedId,
    });

    const response = await api('GET', '/regions/public');
    expect(response.status).toBe(200);

    const names = response.body.data.regions.map((region: any) => region.name);
    expect(names).toContain(withCollege);
    expect(names).not.toContain(empty);
  });
});

describe('GET /careers/public and /employment-outlooks/public', () => {
  async function outlookIdByName(token: string, name: string): Promise<string> {
    const response = await api('GET', '/admin/employment-outlooks', { token });

    return response.body.data.find((row: { name: string }) => row.name === name).id;
  }

  it('returns active careers with their outlook resolved and raw salary bounds', async () => {
    const token = await adminToken();
    const outlookId = await outlookIdByName(token, 'High Demand');
    const title = `Data Scientist ${crypto.randomUUID()}`;

    const created = await api('POST', '/admin/careers', {
      token,
      body: {
        title,
        typical_riasec_code: 'IEC',
        salary_min: 40000,
        salary_max: 120000,
        employment_outlook_id: outlookId,
      },
    });
    expect(created.status).toBe(201);

    const response = await api('GET', '/careers/public');
    expect(response.status).toBe(200);

    const served = response.body.data.careers.find((career: any) => career.title === title);
    expect(served).toBeDefined();
    expect(served.salary_min).toBe(40000);
    expect(served.salary_max).toBe(120000);
    expect(served.employment_outlook).toEqual({ id: outlookId, name: 'High Demand' });
  });

  it('omits archived careers', async () => {
    const token = await adminToken();
    const title = `Archived Career ${crypto.randomUUID()}`;
    const created = await api('POST', '/admin/careers', {
      token,
      body: { title, typical_riasec_code: 'IEC' },
    });

    await api('PATCH', `/admin/careers/${created.body.data.id}`, {
      token,
      body: { status: 'archived' },
    });

    const response = await api('GET', '/careers/public');
    const titles = response.body.data.careers.map((career: any) => career.title);
    expect(titles).not.toContain(title);
  });

  it('serves the four seeded employment outlooks without a token', async () => {
    const response = await api('GET', '/employment-outlooks/public');

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(4);
  });
});

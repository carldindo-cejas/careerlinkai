import { describe, expect, it } from 'vitest';

import { api, createCareer, createStaffUser, login } from '../helpers';

/**
 * Careers (FULLPLAN §13.3, §20), and the Holland code — the field that makes a career
 * scoreable. §27 reads `typical_riasec_code` *positionally*, weighting `[0.5, 0.3, 0.2]`, so
 * every rule enforced here exists because the engine would otherwise **misread** the value
 * rather than reject it.
 */

async function adminToken(): Promise<string> {
  return login(await createStaffUser({ role: 'admin' }));
}

describe('POST /admin/careers', () => {
  it('creates a career, always active', async () => {
    const token = await adminToken();

    const response = await api('POST', '/admin/careers', {
      token,
      body: {
        title: `Software Engineer ${Date.now()}`,
        salary_range: 'PHP 30,000 - 80,000/mo',
        employment_outlook: 'High demand',
        typical_riasec_code: 'IEC',
        status: 'archived',
      },
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      salary_range: 'PHP 30,000 - 80,000/mo',
      typical_riasec_code: 'IEC',
      // Not accepted at creation — archiving is an explicit PATCH.
      status: 'active',
    });
  });

  it('rejects a duplicate title among live careers', async () => {
    const token = await adminToken();
    const title = `Data Analyst ${Date.now()}`;

    await createCareer(token, { title });

    const response = await api('POST', '/admin/careers', {
      token,
      body: { title, typical_riasec_code: null },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.title).toBeDefined();
  });

  it('frees the title again once the career is deleted', async () => {
    const token = await adminToken();
    const title = `Nurse ${Date.now()}`;

    const career = await createCareer(token, { title });

    await api('DELETE', `/admin/careers/${career.id}`, { token });

    const response = await api('POST', '/admin/careers', {
      token,
      body: { title, typical_riasec_code: null },
    });

    expect(response.status).toBe(201);
  });
});

describe('the Holland code', () => {
  /** Case is settled once, on write — §27 compares each letter against a dimension key. */
  it('stores a lowercase code uppercased', async () => {
    const career = await createCareer(await adminToken(), { typical_riasec_code: 'iec' });

    expect(career.typical_riasec_code).toBe('IEC');
  });

  /**
   * A career with no code is a legitimate catalog entry that simply cannot be RIASEC-matched.
   * An empty string normalises to null rather than passing through — `""` would reach §27 as a
   * zero-letter code to iterate over.
   */
  it('accepts null, and normalises an empty string to null', async () => {
    const token = await adminToken();

    expect((await createCareer(token, { typical_riasec_code: null })).typical_riasec_code).toBeNull();
    expect((await createCareer(token, { typical_riasec_code: '' })).typical_riasec_code).toBeNull();
  });

  it('rejects a letter outside R I A S E C — §27 would have no dimension to look it up against', async () => {
    const response = await api('POST', '/admin/careers', {
      token: await adminToken(),
      body: { title: `Bad ${Date.now()}`, typical_riasec_code: 'IXC' },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.typical_riasec_code).toBeDefined();
  });

  /**
   * The column is VARCHAR(6) per §13.3, but there are only three position weights. A fourth
   * letter would be read at an index with no weight and silently count for nothing — so it is
   * refused on input rather than accepted and ignored at scoring time.
   */
  it('rejects a fourth letter', async () => {
    const response = await api('POST', '/admin/careers', {
      token: await adminToken(),
      body: { title: `Too long ${Date.now()}`, typical_riasec_code: 'IECR' },
    });

    expect(response.status).toBe(422);
  });

  /**
   * "IIE" would weight Investigative at 0.5 + 0.3 = 0.8, scoring a one-dimensional student as
   * a near-perfect match for a career they are not.
   */
  it('rejects a repeated letter', async () => {
    const response = await api('POST', '/admin/careers', {
      token: await adminToken(),
      body: { title: `Repeat ${Date.now()}`, typical_riasec_code: 'IIE' },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.typical_riasec_code).toContain(
      'A Holland code cannot repeat a letter.',
    );
  });

  it('accepts a single-letter code', async () => {
    const career = await createCareer(await adminToken(), { typical_riasec_code: 'S' });

    expect(career.typical_riasec_code).toBe('S');
  });

  it('enforces the same rules on update', async () => {
    const token = await adminToken();
    const career = await createCareer(token);

    const bad = await api('PATCH', `/admin/careers/${career.id}`, {
      token,
      body: { typical_riasec_code: 'AAA' },
    });

    expect(bad.status).toBe(422);

    const good = await api('PATCH', `/admin/careers/${career.id}`, {
      token,
      body: { typical_riasec_code: 'sea' },
    });

    expect(good.status).toBe(200);
    expect(good.body.data.typical_riasec_code).toBe('SEA');
  });
});

describe('GET /admin/careers', () => {
  it('paginates and omits deleted careers', async () => {
    const token = await adminToken();
    const kept = await createCareer(token);
    const removed = await createCareer(token);

    await api('DELETE', `/admin/careers/${removed.id}`, { token });

    const response = await api('GET', '/admin/careers?per_page=100', { token });
    const ids = response.body.data.items.map((career: any) => career.id);

    expect(response.status).toBe(200);
    expect(ids).toContain(kept.id);
    expect(ids).not.toContain(removed.id);
    expect(response.body.data.pagination.per_page).toBe(100);
  });

  /** The mapping picker asks for the whole catalog in one request; nothing wants 50,000 rows. */
  it('clamps per_page to 100', async () => {
    const response = await api('GET', '/admin/careers?per_page=101', { token: await adminToken() });

    expect(response.status).toBe(422);
  });
});

describe('PATCH /admin/careers/{id}', () => {
  it('makes status writable', async () => {
    const token = await adminToken();
    const career = await createCareer(token);

    const response = await api('PATCH', `/admin/careers/${career.id}`, {
      token,
      body: { status: 'archived' },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('archived');
  });

  it('404s for a deleted career', async () => {
    const token = await adminToken();
    const career = await createCareer(token);

    await api('DELETE', `/admin/careers/${career.id}`, { token });

    const response = await api('PATCH', `/admin/careers/${career.id}`, {
      token,
      body: { title: 'Ghost' },
    });

    expect(response.status).toBe(404);
  });
});

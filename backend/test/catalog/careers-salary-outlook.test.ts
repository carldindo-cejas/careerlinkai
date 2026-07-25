import { describe, expect, it } from 'vitest';

import { api, createCareer, createStaffUser, login } from '../helpers';

/**
 * The careers salary split and employment-outlook lookup (backend migration 0013).
 *
 * Salary is two raw integers with cross-field rules (both-or-neither, `min < max`, positive), and
 * the outlook is an FK into a seeded four-row lookup rather than free text. The rules under test are
 * exactly the ones the migration's move to structured data exists to make enforceable.
 */

async function adminToken(): Promise<string> {
  return login(await createStaffUser({ role: 'admin' }));
}

async function outlookIdByName(token: string, name: string): Promise<string> {
  const response = await api('GET', '/admin/employment-outlooks', { token });
  const outlook = response.body.data.find((row: { name: string }) => row.name === name);

  if (!outlook) {
    throw new Error(`Seeded outlook "${name}" not found: ${JSON.stringify(response.body)}`);
  }

  return outlook.id;
}

describe('GET /admin/employment-outlooks', () => {
  it('returns the four seeded outlooks in display order', async () => {
    const response = await api('GET', '/admin/employment-outlooks', { token: await adminToken() });

    expect(response.status).toBe(200);
    expect(response.body.data.map((row: { name: string }) => row.name)).toEqual([
      'Low Demand',
      'Moderate Demand',
      'High Demand',
      'Emerging Field',
    ]);
  });
});

describe('career salary (min/max)', () => {
  it('stores both bounds and returns them as numbers with the resolved outlook', async () => {
    const token = await adminToken();
    const outlookId = await outlookIdByName(token, 'High Demand');

    const response = await api('POST', '/admin/careers', {
      token,
      body: {
        title: `Software Engineer ${Date.now()}`,
        salary_min: 40000,
        salary_max: 120000,
        employment_outlook_id: outlookId,
        typical_riasec_code: 'IEC',
      },
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      salary_min: 40000,
      salary_max: 120000,
      employment_outlook_id: outlookId,
      employment_outlook: { id: outlookId, name: 'High Demand' },
    });
  });

  it('accepts a career with no salary at all', async () => {
    const career = await createCareer(await adminToken(), { title: `No Salary ${Date.now()}` });

    expect(career.salary_min).toBeNull();
    expect(career.salary_max).toBeNull();
  });

  it('rejects a lone bound — a half-finished range', async () => {
    const response = await api('POST', '/admin/careers', {
      token: await adminToken(),
      body: { title: `Lone ${Date.now()}`, salary_min: 40000, typical_riasec_code: null },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.salary_max).toBeDefined();
  });

  it('rejects a maximum that is not greater than the minimum', async () => {
    const response = await api('POST', '/admin/careers', {
      token: await adminToken(),
      body: {
        title: `Inverted ${Date.now()}`,
        salary_min: 80000,
        salary_max: 80000,
        typical_riasec_code: null,
      },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.salary_max).toBeDefined();
  });

  it('rejects a non-positive salary', async () => {
    const response = await api('POST', '/admin/careers', {
      token: await adminToken(),
      body: {
        title: `Zero ${Date.now()}`,
        salary_min: 0,
        salary_max: 50000,
        typical_riasec_code: null,
      },
    });

    expect(response.status).toBe(422);
  });
});

describe('career employment outlook (FK)', () => {
  it('rejects an unknown outlook id', async () => {
    const response = await api('POST', '/admin/careers', {
      token: await adminToken(),
      body: {
        title: `Bad Outlook ${Date.now()}`,
        employment_outlook_id: crypto.randomUUID(),
        typical_riasec_code: null,
      },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.employment_outlook_id).toBeDefined();
  });

  it('lets a career be created with no outlook, then set one on update', async () => {
    const token = await adminToken();
    const outlookId = await outlookIdByName(token, 'Emerging Field');
    const career = await createCareer(token, { title: `Later ${Date.now()}` });

    const response = await api('PATCH', `/admin/careers/${career.id}`, {
      token,
      body: { employment_outlook_id: outlookId },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.employment_outlook).toMatchObject({ name: 'Emerging Field' });
  });
});

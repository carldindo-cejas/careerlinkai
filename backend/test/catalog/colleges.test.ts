import { describe, expect, it } from 'vitest';

import {
  api,
  attachCareer,
  createCareer,
  createCollege,
  createProgram,
  createStaffUser,
  findCollegeRow,
  findProgramRow,
  login,
} from '../helpers';

/**
 * Colleges (FULLPLAN §13.3, §20 · docs/api/phase-2-academic-catalog.md).
 *
 * Storage is shared across the tests in this file (test/setup.ts), so nothing here asserts on
 * "the only college in the table" — every test identifies its own rows by id.
 */

async function adminToken(): Promise<string> {
  return login(await createStaffUser({ role: 'admin' }));
}

describe('POST /admin/colleges', () => {
  it('creates a college, always active — status is not an accepted input', async () => {
    const token = await adminToken();

    const response = await api('POST', '/admin/colleges', {
      token,
      body: {
        name: `University of Santo Tomas ${Date.now()}`,
        description: 'The oldest existing university in Asia.',
        // Offered, and must be ignored: a new college is always `active`, and archiving one
        // is an explicit PATCH rather than something a create can do in passing.
        status: 'archived',
      },
    });

    expect(response.status).toBe(201);
    expect(response.body.data.status).toBe('active');
    expect(response.body.data.description).toBe('The oldest existing university in Asia.');
  });

  it('rejects a duplicate name among live colleges', async () => {
    const token = await adminToken();
    const name = `Ateneo de Manila ${Date.now()}`;

    await createCollege(token, { name });

    const response = await api('POST', '/admin/colleges', { token, body: { name } });

    expect(response.status).toBe(422);
    expect(response.body.errors.name).toContain(
      'A college with this name is already in the catalog.',
    );
  });

  /**
   * The reason the uniqueness rule is a live-row lookup rather than a DB unique index (§20):
   * colleges are soft-deleted, so a deleted row keeps its name forever. An index would let one
   * deleted "University of Santo Tomas" permanently block anyone from ever adding the real one.
   */
  it('frees the name again once the college is deleted', async () => {
    const token = await adminToken();
    const name = `De La Salle ${Date.now()}`;

    const college = await createCollege(token, { name });

    expect((await api('DELETE', `/admin/colleges/${college.id}`, { token })).status).toBe(204);

    const response = await api('POST', '/admin/colleges', { token, body: { name } });

    expect(response.status).toBe(201);
  });

  /** Naming drift one row apart is exactly what promoting `colleges` to a table was for. */
  it('treats a name differing only in case as a duplicate', async () => {
    const token = await adminToken();
    const name = `Mapua University ${Date.now()}`;

    await createCollege(token, { name });

    const response = await api('POST', '/admin/colleges', {
      token,
      body: { name: name.toLowerCase() },
    });

    expect(response.status).toBe(422);
  });

  it('rejects a blank name', async () => {
    const response = await api('POST', '/admin/colleges', {
      token: await adminToken(),
      body: { name: '   ' },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.name).toBeDefined();
  });
});

describe('GET /admin/colleges', () => {
  it('paginates and carries programs_count, not the programs themselves', async () => {
    const token = await adminToken();
    const college = await createCollege(token);

    await createProgram(token, college.id, { code: 'BSCS' });
    await createProgram(token, college.id, { code: 'BSIT' });

    const response = await api('GET', '/admin/colleges?per_page=100', { token });

    expect(response.status).toBe(200);
    expect(response.body.data.pagination).toMatchObject({ current_page: 1, per_page: 100 });

    const row = response.body.data.items.find((item: any) => item.id === college.id);

    expect(row.programs_count).toBe(2);
    expect(row.programs).toBeUndefined();
  });

  it('omits a deleted college from the list', async () => {
    const token = await adminToken();
    const college = await createCollege(token);

    await api('DELETE', `/admin/colleges/${college.id}`, { token });

    const response = await api('GET', '/admin/colleges?per_page=100', { token });
    const ids = response.body.data.items.map((item: any) => item.id);

    expect(ids).not.toContain(college.id);
  });

  it('clamps per_page to 100', async () => {
    const response = await api('GET', '/admin/colleges?per_page=5000', { token: await adminToken() });

    expect(response.status).toBe(422);
  });
});

describe('GET /admin/colleges/{id}', () => {
  /**
   * The nested view is the admin's picture of one institution and everything it offers. The
   * careers matter because the mapping is what makes a program scoreable at all (§27) — a view
   * that stopped at the program name would hide the only field that decides whether the
   * program can be recommended.
   */
  it('nests the programs, each with its linked careers', async () => {
    const token = await adminToken();
    const college = await createCollege(token);
    const program = await createProgram(token, college.id, { code: 'BSCS' });
    const career = await createCareer(token, { typical_riasec_code: 'IEC' });

    await attachCareer(token, program.id, career.id);

    const response = await api('GET', `/admin/colleges/${college.id}`, { token });

    expect(response.status).toBe(200);
    expect(response.body.data.programs).toHaveLength(1);

    const nested = response.body.data.programs[0];

    expect(nested.id).toBe(program.id);
    expect(nested.careers).toHaveLength(1);
    expect(nested.careers[0]).toMatchObject({ id: career.id, typical_riasec_code: 'IEC' });
  });

  it('404s for a deleted college', async () => {
    const token = await adminToken();
    const college = await createCollege(token);

    await api('DELETE', `/admin/colleges/${college.id}`, { token });

    expect((await api('GET', `/admin/colleges/${college.id}`, { token })).status).toBe(404);
  });
});

describe('PATCH /admin/colleges/{id}', () => {
  it('archives a college without touching its programs', async () => {
    const token = await adminToken();
    const college = await createCollege(token);
    const program = await createProgram(token, college.id);

    const response = await api('PATCH', `/admin/colleges/${college.id}`, {
      token,
      body: { status: 'archived' },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('archived');

    // Archiving is not deleting: the programs stay active, editable and visible. What changes
    // is that §27 will no longer rank them — recommendability is a property of the *chain*.
    const row = await findProgramRow(program.id);

    expect(row?.status).toBe('active');
    expect(row?.deletedAt).toBeNull();
  });

  it('rejects `draft`, which is a program status and not a college one', async () => {
    const token = await adminToken();
    const college = await createCollege(token);

    const response = await api('PATCH', `/admin/colleges/${college.id}`, {
      token,
      body: { status: 'draft' },
    });

    expect(response.status).toBe(422);
  });

  it('lets a college keep its own name on update', async () => {
    const token = await adminToken();
    const college = await createCollege(token);

    const response = await api('PATCH', `/admin/colleges/${college.id}`, {
      token,
      body: { name: college.name, description: 'Edited.' },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.description).toBe('Edited.');
  });

  it('rejects renaming onto another live college', async () => {
    const token = await adminToken();
    const first = await createCollege(token);
    const second = await createCollege(token);

    const response = await api('PATCH', `/admin/colleges/${second.id}`, {
      token,
      body: { name: first.name },
    });

    expect(response.status).toBe(422);
  });
});

describe('DELETE /admin/colleges/{id}', () => {
  /**
   * The cascade is the whole point (§20). Without it a program whose college is deleted is
   * *unreachable but alive*: the college 404s so nothing can list the program again, while
   * PATCH /programs/{id} still edits it happily — and it was still being handed to the
   * recommendation engine. A college and its programs are one unit.
   */
  it('soft-deletes the college and cascades to its programs in the same act', async () => {
    const token = await adminToken();
    const college = await createCollege(token);
    const program = await createProgram(token, college.id);

    expect((await api('DELETE', `/admin/colleges/${college.id}`, { token })).status).toBe(204);

    expect((await findCollegeRow(college.id))?.deletedAt).not.toBeNull();
    expect((await findProgramRow(program.id))?.deletedAt).not.toBeNull();
  });

  it('leaves the cascaded program unreachable through its own endpoints', async () => {
    const token = await adminToken();
    const college = await createCollege(token);
    const program = await createProgram(token, college.id);

    await api('DELETE', `/admin/colleges/${college.id}`, { token });

    // The bug the cascade exists to prevent: an edit that still succeeds on a program nobody
    // can see. Both must now 404.
    expect(
      (await api('PATCH', `/admin/programs/${program.id}`, { token, body: { name: 'Zombie' } }))
        .status,
    ).toBe(404);
    expect((await api('DELETE', `/admin/programs/${program.id}`, { token })).status).toBe(404);
  });

  it('404s for an unknown college', async () => {
    const response = await api('DELETE', '/admin/colleges/00000000-0000-4000-8000-000000000000', {
      token: await adminToken(),
    });

    expect(response.status).toBe(404);
  });
});

import { describe, expect, it } from 'vitest';

import {
  api,
  createCollege,
  createProgram,
  createStaffUser,
  findProgramRow,
  login,
} from '../helpers';

/** Programs (FULLPLAN §13.3, §20). Created and listed under their college; edited by their own id. */

async function adminToken(): Promise<string> {
  return login(await createStaffUser({ role: 'admin' }));
}

describe('POST /admin/colleges/{collegeId}/programs', () => {
  it('creates a program under its college, defaulting to active', async () => {
    const token = await adminToken();
    const college = await createCollege(token);

    const response = await api('POST', `/admin/colleges/${college.id}/programs`, {
      token,
      body: {
        code: 'BSCS',
        name: 'BS Computer Science',
        department_name: 'College of Engineering',
        recommended_strand: 'Academic',
      },
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      college_id: college.id,
      code: 'BSCS',
      recommended_strand: 'Academic',
      status: 'active',
    });
  });

  /**
   * `status` is settable at creation here — unlike on colleges and careers — because a program
   * has a real third state: `draft` is one the admin has entered but is not offering, and §27
   * ranks only `active` programs. Choosing it is a meaningful act, not a workflow artefact.
   */
  it('accepts an explicit draft status', async () => {
    const token = await adminToken();
    const college = await createCollege(token);

    const program = await createProgram(token, college.id, { status: 'draft' });

    expect(program.status).toBe('draft');
  });

  /**
   * The code is uppercased *before* the uniqueness check runs, not after. It has to be: the
   * check is a string comparison, so a stored "BSCS" and an incoming "bscs" would not match,
   * the check would pass, and a second BSCS would land in the same college.
   */
  it('uppercases the code, and a lowercase duplicate still collides', async () => {
    const token = await adminToken();
    const college = await createCollege(token);

    const created = await api('POST', `/admin/colleges/${college.id}/programs`, {
      token,
      body: { code: 'bscs', name: 'BS Computer Science', recommended_strand: null },
    });

    expect(created.status).toBe(201);
    expect(created.body.data.code).toBe('BSCS');

    const duplicate = await api('POST', `/admin/colleges/${college.id}/programs`, {
      token,
      body: { code: 'BsCs', name: 'Another', recommended_strand: null },
    });

    expect(duplicate.status).toBe(422);
    expect(duplicate.body.errors.code).toContain(
      'This college already offers a program with that code.',
    );
  });

  /** Scoped to the college, not global: BSCS at UP and BSCS at DLSU are different programs. */
  it('allows the same code at a different college', async () => {
    const token = await adminToken();
    const first = await createCollege(token);
    const second = await createCollege(token);

    await createProgram(token, first.id, { code: 'BSCS' });

    const response = await api('POST', `/admin/colleges/${second.id}/programs`, {
      token,
      body: { code: 'BSCS', name: 'BS Computer Science', recommended_strand: null },
    });

    expect(response.status).toBe(201);
  });

  /**
   * `null` is a *claim* — "this program has no strand requirement" — which §27 scores as a full
   * 100 for every student. It is not "unknown", and it is not a gap.
   */
  it('accepts a null recommended_strand', async () => {
    const token = await adminToken();
    const college = await createCollege(token);

    const program = await createProgram(token, college.id, { recommended_strand: null });

    expect(program.recommended_strand).toBeNull();
  });

  it('rejects a strand outside the two-value domain', async () => {
    const token = await adminToken();
    const college = await createCollege(token);

    const response = await api('POST', `/admin/colleges/${college.id}/programs`, {
      token,
      body: { code: 'BSX', name: 'X', recommended_strand: 'STEM' },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.recommended_strand).toBeDefined();
  });

  /**
   * The parent always comes from the route. A body naming a different college is ignored, not
   * honoured — moving a program between institutions would silently rewrite the college §27
   * derives for every recommendation already pointing at it.
   */
  it('ignores a college_id in the body', async () => {
    const token = await adminToken();
    const college = await createCollege(token);
    const other = await createCollege(token);

    const response = await api('POST', `/admin/colleges/${college.id}/programs`, {
      token,
      body: {
        code: 'BSCS',
        name: 'BS Computer Science',
        recommended_strand: null,
        college_id: other.id,
      },
    });

    expect(response.status).toBe(201);
    expect(response.body.data.college_id).toBe(college.id);
  });

  it('404s under an unknown college', async () => {
    const response = await api(
      'POST',
      '/admin/colleges/00000000-0000-4000-8000-000000000000/programs',
      { token: await adminToken(), body: { code: 'BSCS', name: 'X', recommended_strand: null } },
    );

    expect(response.status).toBe(404);
  });
});

describe('GET /admin/colleges/{collegeId}/programs', () => {
  it('lists the college’s live programs, unpaginated', async () => {
    const token = await adminToken();
    const college = await createCollege(token);
    const kept = await createProgram(token, college.id, { code: 'BSCS' });
    const removed = await createProgram(token, college.id, { code: 'BSIT' });

    await api('DELETE', `/admin/programs/${removed.id}`, { token });

    const response = await api('GET', `/admin/colleges/${college.id}/programs`, { token });

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.data.map((program: any) => program.id)).toEqual([kept.id]);
  });
});

describe('PATCH /admin/programs/{id}', () => {
  it('edits a program by its own id', async () => {
    const token = await adminToken();
    const college = await createCollege(token);
    const program = await createProgram(token, college.id, { code: 'BSCS' });

    const response = await api('PATCH', `/admin/programs/${program.id}`, {
      token,
      body: { name: 'BS Computer Science (Revised)', status: 'archived' },
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      name: 'BS Computer Science (Revised)',
      status: 'archived',
      college_id: college.id,
    });
  });

  it('cannot move a program to another college', async () => {
    const token = await adminToken();
    const college = await createCollege(token);
    const other = await createCollege(token);
    const program = await createProgram(token, college.id);

    const response = await api('PATCH', `/admin/programs/${program.id}`, {
      token,
      body: { college_id: other.id },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.college_id).toBe(college.id);
    expect((await findProgramRow(program.id))?.collegeId).toBe(college.id);
  });

  it('rejects a code already used by a live sibling', async () => {
    const token = await adminToken();
    const college = await createCollege(token);

    await createProgram(token, college.id, { code: 'BSCS' });
    const second = await createProgram(token, college.id, { code: 'BSIT' });

    const response = await api('PATCH', `/admin/programs/${second.id}`, {
      token,
      body: { code: 'BSCS' },
    });

    expect(response.status).toBe(422);
  });

  it('lets a program keep its own code', async () => {
    const token = await adminToken();
    const college = await createCollege(token);
    const program = await createProgram(token, college.id, { code: 'BSCS' });

    const response = await api('PATCH', `/admin/programs/${program.id}`, {
      token,
      body: { code: 'BSCS', name: 'Renamed' },
    });

    expect(response.status).toBe(200);
  });
});

describe('DELETE /admin/programs/{id}', () => {
  it('soft-deletes the program and leaves its college alone', async () => {
    const token = await adminToken();
    const college = await createCollege(token);
    const program = await createProgram(token, college.id);

    expect((await api('DELETE', `/admin/programs/${program.id}`, { token })).status).toBe(204);

    expect((await findProgramRow(program.id))?.deletedAt).not.toBeNull();
    expect((await api('GET', `/admin/colleges/${college.id}`, { token })).status).toBe(200);
  });

  it('404s on a second delete', async () => {
    const token = await adminToken();
    const college = await createCollege(token);
    const program = await createProgram(token, college.id);

    await api('DELETE', `/admin/programs/${program.id}`, { token });

    expect((await api('DELETE', `/admin/programs/${program.id}`, { token })).status).toBe(404);
  });
});

import { describe, expect, it } from 'vitest';

import {
  api,
  attachCareer,
  createCareer,
  createCollege,
  createProgram,
  createStaffUser,
  findLinksForProgram,
  login,
} from '../helpers';

/**
 * The program ↔ career mapping (FULLPLAN §20, §27).
 *
 * This is the part Phase 4 actually reads: §27 averages `riasec_compatibility` over every
 * career linked to a program to produce that program's RIASEC component, and an unmapped
 * program falls back to a neutral 50. The invariants asserted here are therefore **scoring**
 * invariants, not bookkeeping ones — a duplicate link is a bent score, not an untidy table.
 */

async function adminToken(): Promise<string> {
  return login(await createStaffUser({ role: 'admin' }));
}

/** A college + program + career, the three rows every test here needs. */
async function fixture(token: string) {
  const college = await createCollege(token);
  const program = await createProgram(token, college.id);
  const career = await createCareer(token);

  return { college, program, career };
}

describe('POST /admin/programs/{id}/careers', () => {
  it('links a career and returns the updated program with its careers', async () => {
    const token = await adminToken();
    const { program, career } = await fixture(token);

    const response = await api('POST', `/admin/programs/${program.id}/careers`, {
      token,
      body: { career_id: career.id },
    });

    expect(response.status).toBe(201);
    // The caller never has to refetch to redraw the mapping.
    expect(response.body.data.id).toBe(program.id);
    expect(response.body.data.careers.map((c: any) => c.id)).toEqual([career.id]);
  });

  /**
   * The mapping is a **set**, not a bag. Attaching the same career twice would give it two
   * votes in §27's average and quietly bend the program's score.
   */
  it('refuses a duplicate link with a 422, and writes no second row', async () => {
    const token = await adminToken();
    const { program, career } = await fixture(token);

    await attachCareer(token, program.id, career.id);

    const response = await api('POST', `/admin/programs/${program.id}/careers`, {
      token,
      body: { career_id: career.id },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.career_id[0]).toContain('already linked to this program');

    // The unique index is the guarantee; this asserts the guarantee held, not just the message.
    expect(await findLinksForProgram(program.id)).toHaveLength(1);
  });

  it('links the same career to two different programs', async () => {
    const token = await adminToken();
    const { college, career } = await fixture(token);
    const first = await createProgram(token, college.id, { code: 'BSCS' });
    const second = await createProgram(token, college.id, { code: 'BSIT' });

    await attachCareer(token, first.id, career.id);

    // Careers are global: the same "Software Engineer" is the destination of programs at many
    // institutions, which is exactly what `program_careers` exists to express.
    const response = await api('POST', `/admin/programs/${second.id}/careers`, {
      token,
      body: { career_id: career.id },
    });

    expect(response.status).toBe(201);
  });

  /**
   * A soft-deleted **or archived** career cannot be newly linked: the mapping row would be
   * inert on the day it was made, since §27 drops archived careers from the average.
   */
  it('refuses to link an archived career', async () => {
    const token = await adminToken();
    const { program, career } = await fixture(token);

    await api('PATCH', `/admin/careers/${career.id}`, { token, body: { status: 'archived' } });

    const response = await api('POST', `/admin/programs/${program.id}/careers`, {
      token,
      body: { career_id: career.id },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.career_id).toContain(
      'That career is not in the catalog, or has been archived.',
    );
  });

  it('refuses to link a deleted career, with the same message', async () => {
    const token = await adminToken();
    const { program, career } = await fixture(token);

    await api('DELETE', `/admin/careers/${career.id}`, { token });

    const response = await api('POST', `/admin/programs/${program.id}/careers`, {
      token,
      body: { career_id: career.id },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.career_id).toContain(
      'That career is not in the catalog, or has been archived.',
    );
  });

  it('refuses to link a career that does not exist', async () => {
    const token = await adminToken();
    const { program } = await fixture(token);

    const response = await api('POST', `/admin/programs/${program.id}/careers`, {
      token,
      body: { career_id: '00000000-0000-4000-8000-000000000000' },
    });

    expect(response.status).toBe(422);
  });

  it('404s for an unknown program', async () => {
    const token = await adminToken();
    const { career } = await fixture(token);

    const response = await api(
      'POST',
      '/admin/programs/00000000-0000-4000-8000-000000000000/careers',
      { token, body: { career_id: career.id } },
    );

    expect(response.status).toBe(404);
  });
});

describe('archiving a career, once it is already linked', () => {
  /**
   * **Archiving is not unlinking.** The link survives and the admin still sees the chip —
   * struck through, "archived — not counted" — so restoring the career brings its vote back
   * rather than asking them to re-link it by hand.
   */
  it('keeps the existing link, and keeps showing it to the admin', async () => {
    const token = await adminToken();
    const { college, program, career } = await fixture(token);

    await attachCareer(token, program.id, career.id);
    await api('PATCH', `/admin/careers/${career.id}`, { token, body: { status: 'archived' } });

    expect(await findLinksForProgram(program.id)).toHaveLength(1);

    const response = await api('GET', `/admin/colleges/${college.id}`, { token });
    const nested = response.body.data.programs.find((p: any) => p.id === program.id);

    // Still on the program, and carrying the status the UI needs to strike it through.
    expect(nested.careers).toHaveLength(1);
    expect(nested.careers[0]).toMatchObject({ id: career.id, status: 'archived' });
  });

  /** A deleted career, by contrast, is gone from the admin's view of the program entirely. */
  it('drops a deleted career from the program view', async () => {
    const token = await adminToken();
    const { college, program, career } = await fixture(token);

    await attachCareer(token, program.id, career.id);
    await api('DELETE', `/admin/careers/${career.id}`, { token });

    const response = await api('GET', `/admin/colleges/${college.id}`, { token });
    const nested = response.body.data.programs.find((p: any) => p.id === program.id);

    expect(nested.careers).toHaveLength(0);
  });
});

describe('DELETE /admin/programs/{id}/careers/{careerId}', () => {
  /**
   * A **real** delete, not a soft one — the join row records no event that anyone lived
   * through (it is not `class_students`, an enrollment a real student experienced), and both
   * sides of it survive untouched.
   */
  it('hard-deletes the link, returns 200 with the updated program, and leaves both sides alive', async () => {
    const token = await adminToken();
    const { program, career } = await fixture(token);

    await attachCareer(token, program.id, career.id);

    const response = await api('DELETE', `/admin/programs/${program.id}/careers/${career.id}`, {
      token,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe(program.id);
    expect(response.body.data.careers).toHaveLength(0);

    expect(await findLinksForProgram(program.id)).toHaveLength(0);

    // Both sides survive: unlinking a career from one program does not remove the career.
    expect((await api('GET', '/admin/careers?per_page=100', { token })).body.data.items.map(
      (c: any) => c.id,
    )).toContain(career.id);
  });

  it('404s when the career is not linked to this program', async () => {
    const token = await adminToken();
    const { program, career } = await fixture(token);

    const response = await api('DELETE', `/admin/programs/${program.id}/careers/${career.id}`, {
      token,
    });

    expect(response.status).toBe(404);
  });

  /** Unlinking twice is not idempotent by design — the second call has nothing to unlink. */
  it('404s on a second unlink', async () => {
    const token = await adminToken();
    const { program, career } = await fixture(token);

    await attachCareer(token, program.id, career.id);
    await api('DELETE', `/admin/programs/${program.id}/careers/${career.id}`, { token });

    const response = await api('DELETE', `/admin/programs/${program.id}/careers/${career.id}`, {
      token,
    });

    expect(response.status).toBe(404);
  });
});

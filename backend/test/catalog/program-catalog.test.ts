import { beforeAll, describe, expect, it } from 'vitest';

import {
  api,
  attachCareer,
  classWithStudent,
  createCareer,
  createCollege,
  createProgram,
  createStaffUser,
  login,
} from '../helpers';

/**
 * The canonical program catalog (migration 0018) and the two relationship questions it exists to
 * answer.
 *
 * `programs.college_id` is NOT NULL: a `programs` row *is* "this program, at this college". That
 * leaves **"which colleges offer BS Computer Science?"** unanswerable by any join, because the two
 * BSCS rows share only a string. `program_catalog` promotes that string to a row — the same
 * promotion v1.1 applied to `colleges` (§13.3) — so both directions become joins:
 *
 *   * career → programs, through `program_careers` read backwards, and
 *   * program → colleges, through the canonical entry's sibling offerings.
 */

let adminToken: string;
let counselorToken: string;

beforeAll(async () => {
  adminToken = await login(await createStaffUser({ role: 'admin' }));
  counselorToken = await login(await createStaffUser({ role: 'counselor' }));
});

describe('canonical program assignment', () => {
  /**
   * The normal path, and the reason an admin never has to visit the canonical page first: a
   * program saved with a code nobody has used before *creates* the canonical entry.
   */
  it('creates a canonical entry for an unseen code and links the offering to it', async () => {
    const college = await createCollege(adminToken);
    const program = await createProgram(adminToken, college.id, {
      code: 'BSMARBIO',
      name: 'BS Marine Biology',
    });

    expect(program.program_catalog_id).not.toBeNull();

    const options = await api('GET', '/admin/canonical-programs/options', { token: adminToken });
    const entry = options.body.data.find((row: any) => row.id === program.program_catalog_id);

    expect(entry.code).toBe('BSMARBIO');
    expect(entry.name).toBe('BS Marine Biology');
  });

  /**
   * **The whole point of the table.** Two colleges, the same program, one canonical row — so the
   * student-facing question has an answer.
   */
  it('links two colleges’ offerings of the same program to one canonical entry', async () => {
    const first = await createCollege(adminToken);
    const second = await createCollege(adminToken);

    const a = await createProgram(adminToken, first.id, {
      code: 'BSNURSING',
      name: 'BS Nursing',
    });
    const b = await createProgram(adminToken, second.id, {
      code: 'BSNURSING',
      name: 'BS Nursing',
    });

    expect(a.program_catalog_id).toBe(b.program_catalog_id);
  });

  /**
   * 'BS-CS', 'bs cs' and 'BSCS' are one program three ways. Without the normalization a single
   * hyphen would silently split a canonical entry in two, with no error and no warning — a student
   * shown two colleges where three offer it.
   */
  it('normalizes punctuation and case when matching a code', async () => {
    const first = await createCollege(adminToken);
    const second = await createCollege(adminToken);

    const plain = await createProgram(adminToken, first.id, { code: 'BSCPE' });
    const hyphenated = await createProgram(adminToken, second.id, { code: 'bs-cpe' });

    expect(hyphenated.program_catalog_id).toBe(plain.program_catalog_id);
  });

  /** An explicit id pins the grouping, overriding what the code would have matched. */
  it('honours an explicit canonical id over the code', async () => {
    const created = await api('POST', '/admin/canonical-programs', {
      token: adminToken,
      body: { code: 'BSIT', name: 'BS Information Technology' },
    });
    const college = await createCollege(adminToken);

    const program = await createProgram(adminToken, college.id, {
      code: 'BSINFOTECH',
      name: 'BS Info Tech',
      program_catalog_id: created.body.data.id,
    });

    expect(program.program_catalog_id).toBe(created.body.data.id);
  });
});

describe('GET /student/programs/{id}/colleges', () => {
  it('lists every active college offering the same canonical program', async () => {
    const { studentToken } = await classWithStudent(counselorToken);

    const first = await createCollege(adminToken, { name: 'Alpha University' });
    const second = await createCollege(adminToken, { name: 'Beta University' });
    const mine = await createProgram(adminToken, first.id, {
      code: 'BSPSYCH',
      name: 'BS Psychology',
    });
    await createProgram(adminToken, second.id, { code: 'BSPSYCH', name: 'BS Psychology' });

    const response = await api('GET', `/student/programs/${mine.id}/colleges`, {
      token: studentToken,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.canonical.code).toBe('BSPSYCH');

    const names = response.body.data.offerings.map((row: any) => row.college.name);

    // Ordered by college name, so the list is reproducible (§26).
    expect(names).toEqual(['Alpha University', 'Beta University']);
  });

  /**
   * The same `active` chain §27 uses for recommendability. An active program under an archived
   * college is not offered, and showing it would be advertising a door that is not open.
   */
  it('excludes an offering whose college is archived', async () => {
    const { studentToken } = await classWithStudent(counselorToken);

    const live = await createCollege(adminToken, { name: 'Live University' });
    const archived = await createCollege(adminToken, { name: 'Archived University' });
    const mine = await createProgram(adminToken, live.id, { code: 'BSBIO', name: 'BS Biology' });
    await createProgram(adminToken, archived.id, { code: 'BSBIO', name: 'BS Biology' });

    await api('PATCH', `/admin/colleges/${archived.id}`, {
      token: adminToken,
      body: { status: 'archived' },
    });

    const response = await api('GET', `/student/programs/${mine.id}/colleges`, {
      token: studentToken,
    });

    expect(response.body.data.offerings.map((row: any) => row.college.name)).toEqual([
      'Live University',
    ]);
  });

  /**
   * "We have not decided what this program canonically is" is a real state of the data, and it
   * answers 200 with an empty list rather than a 404 that would imply the program does not exist.
   */
  it('answers 200 with an empty list for an unlinked program', async () => {
    const { studentToken } = await classWithStudent(counselorToken);
    const college = await createCollege(adminToken);
    const program = await createProgram(adminToken, college.id, { code: 'BSTEMP' });

    await api('PATCH', `/admin/programs/${program.id}`, {
      token: adminToken,
      body: { program_catalog_id: null },
    });

    const response = await api('GET', `/student/programs/${program.id}/colleges`, {
      token: studentToken,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.canonical).toBeNull();
    expect(response.body.data.offerings).toEqual([]);
  });
});

describe('GET /student/careers/{id}/programs', () => {
  /**
   * `program_careers` read in the direction nothing needed until now — §27 only ever traversed
   * program → careers, to average their Holland codes.
   */
  it('lists the college programs mapped to a career', async () => {
    const { studentToken } = await classWithStudent(counselorToken);

    const college = await createCollege(adminToken, { name: 'Gamma University' });
    const program = await createProgram(adminToken, college.id, {
      code: 'BSSTAT',
      name: 'BS Statistics',
    });
    const career = await createCareer(adminToken, { title: 'Data Analyst' });

    await attachCareer(adminToken, program.id, career.id);

    const response = await api('GET', `/student/careers/${career.id}/programs`, {
      token: studentToken,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.career.title).toBe('Data Analyst');
    expect(response.body.data.programs).toHaveLength(1);
    expect(response.body.data.programs[0].program.name).toBe('BS Statistics');
    expect(response.body.data.programs[0].college.name).toBe('Gamma University');
    // The canonical entry rides along so the card can offer "colleges offering this" without a
    // second round trip.
    expect(response.body.data.programs[0].program.canonical.code).toBe('BSSTAT');
  });

  /** An unmapped career is an empty list and a message that says so — not an error. */
  it('answers 200 with an empty list for an unmapped career', async () => {
    const { studentToken } = await classWithStudent(counselorToken);
    const career = await createCareer(adminToken, { title: 'Lighthouse Keeper' });

    const response = await api('GET', `/student/careers/${career.id}/programs`, {
      token: studentToken,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.programs).toEqual([]);
  });
});

describe('canonical program administration', () => {
  /** One code, one canonical program — a second row for the same code is the bug this prevents. */
  it('refuses a duplicate code', async () => {
    await api('POST', '/admin/canonical-programs', {
      token: adminToken,
      body: { code: 'BSDUP', name: 'BS Duplicate' },
    });

    const second = await api('POST', '/admin/canonical-programs', {
      token: adminToken,
      body: { code: 'bs-dup', name: 'BS Duplicate Again' },
    });

    expect(second.status).toBe(422);
    expect(second.body.errors.code).toBeDefined();
  });

  /**
   * **The correction path**, and the reason this feature ships with a page rather than only a
   * column: the 0018 backfill groups on a normalized code, which is a guess, and an admin needs
   * somewhere to say it guessed wrong.
   */
  it('merges one entry into another, re-pointing every offering', async () => {
    const first = await createCollege(adminToken);
    const second = await createCollege(adminToken);

    const wrong = await createProgram(adminToken, first.id, {
      code: 'BSACCTCY',
      name: 'BS Accountancy',
    });
    const right = await createProgram(adminToken, second.id, {
      code: 'BSACC',
      name: 'BS Accountancy',
    });

    expect(wrong.program_catalog_id).not.toBe(right.program_catalog_id);

    const merged = await api('POST', `/admin/canonical-programs/${wrong.program_catalog_id}/merge`, {
      token: adminToken,
      body: { target_id: right.program_catalog_id },
    });

    expect(merged.status).toBe(200);
    expect(merged.body.data.offerings_moved).toBe(1);

    // …and the student-facing question now has the right answer.
    const { studentToken } = await classWithStudent(counselorToken);
    const colleges = await api('GET', `/student/programs/${wrong.id}/colleges`, {
      token: studentToken,
    });

    expect(colleges.body.data.canonical.code).toBe('BSACC');
    expect(colleges.body.data.offerings).toHaveLength(2);
  });

  it('refuses to merge an entry into itself', async () => {
    const college = await createCollege(adminToken);
    const program = await createProgram(adminToken, college.id, { code: 'BSSELF' });

    const response = await api(
      'POST',
      `/admin/canonical-programs/${program.program_catalog_id}/merge`,
      { token: adminToken, body: { target_id: program.program_catalog_id } },
    );

    expect(response.status).toBe(422);
  });

  it('reports how many colleges offer each entry', async () => {
    const first = await createCollege(adminToken);
    const second = await createCollege(adminToken);

    const program = await createProgram(adminToken, first.id, {
      code: 'BSCOUNTED',
      name: 'BS Counted',
    });
    await createProgram(adminToken, second.id, { code: 'BSCOUNTED', name: 'BS Counted' });

    const response = await api('GET', '/admin/canonical-programs?per_page=100', {
      token: adminToken,
    });
    const entry = response.body.data.items.find(
      (row: any) => row.id === program.program_catalog_id,
    );

    expect(entry.offerings_count).toBe(2);
  });

  /**
   * The catalog is admin-managed (§5). This route group is the only thing between a counselor and
   * the canonical grouping every student's "colleges offering this" list is built from.
   */
  it('refuses a counselor outright', async () => {
    for (const [method, path, body] of [
      ['GET', '/admin/canonical-programs', undefined],
      ['POST', '/admin/canonical-programs', { code: 'BSNOPE', name: 'Nope' }],
    ] as const) {
      const response = await api(method, path, { token: counselorToken, ...(body ? { body } : {}) });

      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });
});

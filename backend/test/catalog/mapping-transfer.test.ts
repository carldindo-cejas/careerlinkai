import { beforeAll, describe, expect, it } from 'vitest';

import { uuid } from '@/lib/crypto';

import {
  api,
  createCareer,
  createCollege,
  createProgram,
  createStaffUser,
  login,
} from '../helpers';

/**
 * The canonical mapping as a spreadsheet (2026-09-22): export it, edit it, import it back after a
 * preview. A file speaks for the programs it names and only those; nothing is created from it; and
 * a file with any bad line changes nothing.
 */

let token: string;

beforeAll(async () => {
  token = await login(await createStaffUser({ role: 'admin' }));
});

async function canonicalProgram() {
  const code = `BSMT${uuid().slice(0, 5).toUpperCase()}`;
  const program = await createProgram(token, (await createCollege(token)).id, { code });

  return { id: program.program_catalog_id as string, code };
}

async function link(canonicalId: string, careerId: string, relationship = 'direct') {
  const response = await api('POST', `/admin/canonical-programs/${canonicalId}/careers`, {
    token,
    body: { career_id: careerId, relationship },
  });

  expect(response.status).toBe(201);
}

async function linksOf(code: string) {
  const list = await api('GET', `/admin/canonical-programs?search=${code}`, { token });
  const entry = list.body.data.items.find((row: any) => row.code === code);

  return Object.fromEntries(entry.careers.map((row: any) => [row.title, row.relationship]));
}

function importFile(rows: object[], apply = false) {
  return api('POST', '/admin/catalog-mapping/import', { token, body: { rows, apply } });
}

describe('export', () => {
  it('lists every canonical link with its program, career and grade', async () => {
    const program = await canonicalProgram();
    const career = await createCareer(token, { typical_riasec_code: 'SIA' });

    await link(program.id, career.id, 'related');

    const response = await api('GET', '/admin/catalog-mapping/export', { token });

    expect(response.status).toBe(200);
    expect(response.body.data).toContainEqual(
      expect.objectContaining({
        program_code: program.code,
        career_title: career.title,
        career_riasec_code: 'SIA',
        relationship: 'related',
      }),
    );
  });
});

describe('import', () => {
  async function scenario() {
    const edited = await canonicalProgram();
    const untouched = await canonicalProgram();
    const kept = await createCareer(token);
    const dropped = await createCareer(token);
    const added = await createCareer(token);
    const elsewhere = await createCareer(token);

    await link(edited.id, kept.id);
    await link(edited.id, dropped.id);
    await link(untouched.id, elsewhere.id);

    const rows = [
      { program_code: edited.code, career_title: kept.title, relationship: 'related' },
      { program_code: edited.code, career_title: added.title, relationship: '' },
    ];

    return { edited, untouched, kept, dropped, added, elsewhere, rows };
  }

  it('previews the diff for the programs in the file, and changes nothing', async () => {
    const { edited, untouched, kept, dropped, added, elsewhere, rows } = await scenario();

    const response = await importFile(rows);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(
      expect.objectContaining({
        programs_in_file: 1,
        adds: [
          { program_code: edited.code, career_title: added.title, relationship: 'direct' },
        ],
        removes: [
          { program_code: edited.code, career_title: dropped.title, relationship: 'direct' },
        ],
        regrades: [
          {
            program_code: edited.code,
            career_title: kept.title,
            relationship: 'related',
            from: 'direct',
          },
        ],
        unchanged: 0,
        errors: [],
      }),
    );

    expect(await linksOf(edited.code)).toEqual({
      [kept.title]: 'direct',
      [dropped.title]: 'direct',
    });
    expect(await linksOf(untouched.code)).toEqual({ [elsewhere.title]: 'direct' });
  });

  it('applies the diff, and leaves programs the file does not name alone', async () => {
    const { edited, untouched, kept, added, elsewhere, rows } = await scenario();

    const response = await importFile(rows, true);

    expect(response.status).toBe(200);
    expect(await linksOf(edited.code)).toEqual({
      [kept.title]: 'related',
      [added.title]: 'direct',
    });
    expect(await linksOf(untouched.code)).toEqual({ [elsewhere.title]: 'direct' });
  });

  it('matches careers by title regardless of case and spacing', async () => {
    const program = await canonicalProgram();
    const career = await createCareer(token);

    const response = await importFile(
      [
        {
          program_code: program.code.toLowerCase(),
          career_title: `  ${career.title.toUpperCase()} `,
          relationship: 'Direct',
        },
      ],
      true,
    );

    expect(response.status).toBe(200);
    expect(await linksOf(program.code)).toEqual({ [career.title]: 'direct' });
  });

  it('empties a program named with no career', async () => {
    const program = await canonicalProgram();
    const career = await createCareer(token);

    await link(program.id, career.id);
    await importFile(
      [{ program_code: program.code, career_title: '', relationship: '' }],
      true,
    );

    expect(await linksOf(program.code)).toEqual({});
  });

  it('reports every bad line by its spreadsheet line number', async () => {
    const program = await canonicalProgram();
    const career = await createCareer(token);

    const response = await importFile([
      { program_code: program.code, career_title: career.title, relationship: 'direct' },
      { program_code: 'NOSUCHCODE', career_title: career.title, relationship: 'direct' },
      {
        program_code: program.code,
        career_title: 'No Such Career Anywhere',
        relationship: 'direct',
      },
      { program_code: program.code, career_title: career.title, relationship: 'direct' },
      { program_code: program.code, career_title: career.title, relationship: 'broad' },
    ]);

    expect(response.body.data.errors.map((error: any) => error.line)).toEqual([3, 4, 5, 6]);
  });

  it('refuses to apply a file with any error, and changes nothing', async () => {
    const program = await canonicalProgram();
    const kept = await createCareer(token);
    const added = await createCareer(token);

    await link(program.id, kept.id);

    const response = await importFile(
      [
        { program_code: program.code, career_title: added.title, relationship: 'direct' },
        { program_code: program.code, career_title: 'Typo Careeer', relationship: 'direct' },
      ],
      true,
    );

    expect(response.status).toBe(422);
    expect(response.body.errors.rows[0]).toContain('Line 3');
    expect(await linksOf(program.code)).toEqual({ [kept.title]: 'direct' });
  });

  it('does not newly link an archived career', async () => {
    const program = await canonicalProgram();
    const career = await createCareer(token);

    await api('PATCH', `/admin/careers/${career.id}`, { token, body: { status: 'archived' } });

    const response = await importFile([
      { program_code: program.code, career_title: career.title, relationship: 'direct' },
    ]);

    expect(response.body.data.errors[0].message).toContain('archived');
  });
});

import { beforeAll, describe, expect, it } from 'vitest';

import { uuid } from '@/lib/crypto';
import { AcademicCatalogService } from '@/modules/catalog/academic-catalog-service';

import {
  api,
  attachCareer,
  createCareer,
  createCollege,
  createProgram,
  createStaffUser,
  db,
  findLinksForProgram,
  findProgramRow,
  login,
} from '../helpers';

/**
 * What a **canonical** program leads to (migration 0040).
 *
 * Before 0040 a program's careers hung off each college's offering, so "BS Computer Science leads
 * to Software Developer" was one row per campus and one edit per campus. Now it is one link on the
 * canonical entry, inherited by every offering, with `program_careers` left to carry the extras one
 * campus genuinely adds. The invariants below are **scoring** invariants: the scorer, the admin view
 * and the career → programs lookup must all see the same union, and no career may count twice.
 */

let token: string;

beforeAll(async () => {
  token = await login(await createStaffUser({ role: 'admin' }));
});

/** A canonical program offered by two colleges — the shape every test here needs. */
async function twoCampuses(overrides: Record<string, unknown> = {}) {
  const code = `BSX${uuid().slice(0, 5).toUpperCase()}`;
  const first = await createProgram(token, (await createCollege(token)).id, {
    code,
    ...overrides,
  });
  const second = await createProgram(token, (await createCollege(token)).id, {
    code,
    ...overrides,
  });

  expect(first.program_catalog_id).toBe(second.program_catalog_id);

  return { canonicalId: first.program_catalog_id as string, first, second };
}

async function linkCanonical(canonicalId: string, careerId: string) {
  return api('POST', `/admin/canonical-programs/${canonicalId}/careers`, {
    token,
    body: { career_id: careerId },
  });
}

async function careersOnOffering(collegeId: string, programId: string) {
  const detail = await api('GET', `/admin/colleges/${collegeId}`, { token });

  return detail.body.data.programs.find((program: any) => program.id === programId).careers;
}

describe('linking a career on a canonical program', () => {
  it('links it on every college offering at once, marked as inherited', async () => {
    const { canonicalId, first, second } = await twoCampuses();
    const career = await createCareer(token);

    const response = await linkCanonical(canonicalId, career.id);

    expect(response.status).toBe(201);
    expect(response.body.data.careers.map((row: any) => row.id)).toEqual([career.id]);

    for (const offering of [first, second]) {
      const careers = await careersOnOffering(offering.college_id, offering.id);

      expect(careers).toEqual([expect.objectContaining({ id: career.id, inherited: true })]);
    }
  });

  /** The scorer reads the union — this is what actually moves a student's program ranking. */
  it('is what the scorer counts, for every offering', async () => {
    const { canonicalId, first, second } = await twoCampuses();
    const career = await createCareer(token);

    await linkCanonical(canonicalId, career.id);

    const scorable = await new AcademicCatalogService(db()).scorableCareersForMany([
      first.id,
      second.id,
    ]);

    expect(scorable.get(first.id)?.map((row) => row.id)).toEqual([career.id]);
    expect(scorable.get(second.id)?.map((row) => row.id)).toEqual([career.id]);
  });

  it('answers "which programs lead to this career?" with every offering', async () => {
    const { canonicalId, first, second } = await twoCampuses();
    const career = await createCareer(token);

    await linkCanonical(canonicalId, career.id);

    const rows = await new AcademicCatalogService(db()).programsForCareer(career.id);

    expect(rows.map((row) => row.program.id).sort()).toEqual([first.id, second.id].sort());
  });

  /**
   * One vote per career. A college extra that duplicates the new canonical link is absorbed —
   * otherwise it would lie dormant and reappear on that one campus if the canonical link were ever
   * removed.
   */
  it('absorbs a college extra for the same career instead of counting it twice', async () => {
    const { canonicalId, first } = await twoCampuses();
    const career = await createCareer(token);

    await attachCareer(token, first.id, career.id);
    await linkCanonical(canonicalId, career.id);

    expect(await findLinksForProgram(first.id)).toHaveLength(0);

    const scorable = await new AcademicCatalogService(db()).scorableCareersForMany([first.id]);

    expect(scorable.get(first.id)).toHaveLength(1);
  });

  it('refuses a duplicate link with a 422', async () => {
    const { canonicalId } = await twoCampuses();
    const career = await createCareer(token);

    await linkCanonical(canonicalId, career.id);
    const response = await linkCanonical(canonicalId, career.id);

    expect(response.status).toBe(422);
    expect(response.body.errors.career_id[0]).toContain('already linked');
  });

  it('refuses an archived career', async () => {
    const { canonicalId } = await twoCampuses();
    const career = await createCareer(token);

    await api('PATCH', `/admin/careers/${career.id}`, { token, body: { status: 'archived' } });

    expect((await linkCanonical(canonicalId, career.id)).status).toBe(422);
  });

  it('shows up on the canonical list and on the career’s side', async () => {
    const { canonicalId, first } = await twoCampuses();
    const career = await createCareer(token);

    await linkCanonical(canonicalId, career.id);

    const list = await api('GET', `/admin/canonical-programs?search=${first.code}`, { token });
    const entry = list.body.data.items.find((row: any) => row.id === canonicalId);

    expect(entry.careers.map((row: any) => row.id)).toEqual([career.id]);

    const reverse = await api('GET', `/admin/careers/${career.id}/canonical-programs`, {
      token,
    });

    expect(reverse.status).toBe(200);
    expect(reverse.body.data.map((row: any) => row.id)).toEqual([canonicalId]);
  });
});

describe('college extras alongside inherited careers', () => {
  it('keeps an extra on its own campus only, marked as not inherited', async () => {
    const { canonicalId, first, second } = await twoCampuses();
    const shared = await createCareer(token);
    const extra = await createCareer(token);

    await linkCanonical(canonicalId, shared.id);
    await attachCareer(token, first.id, extra.id);

    const onFirst = await careersOnOffering(first.college_id, first.id);
    const onSecond = await careersOnOffering(second.college_id, second.id);

    expect(onFirst.map((row: any) => [row.id, row.inherited]).sort()).toEqual(
      [
        [shared.id, true],
        [extra.id, false],
      ].sort(),
    );
    expect(onSecond.map((row: any) => row.id)).toEqual([shared.id]);
  });

  it('refuses to add an inherited career as an extra, naming where it comes from', async () => {
    const { canonicalId, first } = await twoCampuses();
    const career = await createCareer(token);

    await linkCanonical(canonicalId, career.id);

    const response = await api('POST', `/admin/programs/${first.id}/careers`, {
      token,
      body: { career_id: career.id },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.career_id[0]).toContain('every college offering it shares');
  });

  /** Not a 404: the link is real, it is just not this college's to remove. */
  it('refuses to unlink an inherited career from one campus, and says where to do it', async () => {
    const { canonicalId, first } = await twoCampuses();
    const career = await createCareer(token);

    await linkCanonical(canonicalId, career.id);

    const response = await api('DELETE', `/admin/programs/${first.id}/careers/${career.id}`, {
      token,
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.career_id[0]).toContain('Canonical programs page');
  });
});

describe('unlinking a career from a canonical program', () => {
  it('removes it from every offering and leaves college extras alone', async () => {
    const { canonicalId, first, second } = await twoCampuses();
    const shared = await createCareer(token);
    const extra = await createCareer(token);

    await linkCanonical(canonicalId, shared.id);
    await attachCareer(token, first.id, extra.id);

    const response = await api(
      'DELETE',
      `/admin/canonical-programs/${canonicalId}/careers/${shared.id}`,
      {
        token,
      },
    );

    expect(response.status).toBe(200);
    expect(response.body.data.careers).toEqual([]);

    expect(
      (await careersOnOffering(first.college_id, first.id)).map((row: any) => row.id),
    ).toEqual([extra.id]);
    expect(await careersOnOffering(second.college_id, second.id)).toEqual([]);
  });

  it('is a 404 for a career that is not linked', async () => {
    const { canonicalId } = await twoCampuses();
    const career = await createCareer(token);

    const response = await api(
      'DELETE',
      `/admin/canonical-programs/${canonicalId}/careers/${career.id}`,
      {
        token,
      },
    );

    expect(response.status).toBe(404);
  });
});

describe('the canonical strand', () => {
  it('is applied to every offering when it changes', async () => {
    const { canonicalId, first, second } = await twoCampuses({
      recommended_strand: 'Academic',
    });

    const response = await api('PATCH', `/admin/canonical-programs/${canonicalId}`, {
      token,
      body: { recommended_strand: 'Technical-Professional' },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.recommended_strand).toBe('Technical-Professional');
    expect(response.body.message).toContain('2 college offerings');

    expect((await findProgramRow(first.id))?.recommendedStrand).toBe('Technical-Professional');
    expect((await findProgramRow(second.id))?.recommendedStrand).toBe('Technical-Professional');
  });

  /**
   * A campus may deliberately differ, and a rename that resends the unchanged strand must not
   * flatten it — the write fires on a *change*, not on the key being present.
   */
  it('does not overwrite a campus that differs when the strand is resent unchanged', async () => {
    const { canonicalId, first, second } = await twoCampuses({
      recommended_strand: 'Academic',
    });

    await api('PATCH', `/admin/programs/${second.id}`, {
      token,
      body: { recommended_strand: null },
    });

    await api('PATCH', `/admin/canonical-programs/${canonicalId}`, {
      token,
      body: { name: 'Renamed Program', recommended_strand: 'Academic' },
    });

    expect((await findProgramRow(first.id))?.recommendedStrand).toBe('Academic');
    expect((await findProgramRow(second.id))?.recommendedStrand).toBeNull();
  });

  it('is the default for a new offering that states no strand of its own', async () => {
    const { canonicalId, first } = await twoCampuses({
      recommended_strand: 'Technical-Professional',
    });

    const college = await createCollege(token);
    const response = await api('POST', `/admin/colleges/${college.id}/programs`, {
      token,
      body: { code: first.code, name: first.name, program_catalog_id: canonicalId },
    });

    expect(response.status).toBe(201);
    expect(response.body.data.recommended_strand).toBe('Technical-Professional');
  });
});

describe('merging canonical programs', () => {
  /**
   * The moved offerings stop inheriting from the source. Whatever the source linked and the target
   * does not is carried down onto them as extras, so nothing a student was matched on disappears.
   */
  it('carries the source’s careers onto the moved offerings as extras', async () => {
    const source = await twoCampuses();
    const target = await twoCampuses();
    const onlyInSource = await createCareer(token);
    const inBoth = await createCareer(token);

    await linkCanonical(source.canonicalId, onlyInSource.id);
    await linkCanonical(source.canonicalId, inBoth.id);
    await linkCanonical(target.canonicalId, inBoth.id);

    const merged = await api('POST', `/admin/canonical-programs/${source.canonicalId}/merge`, {
      token,
      body: { target_id: target.canonicalId },
    });

    expect(merged.status).toBe(200);

    const careers = await careersOnOffering(source.first.college_id, source.first.id);

    expect(careers.map((row: any) => [row.id, row.inherited]).sort()).toEqual(
      [
        [inBoth.id, true],
        [onlyInSource.id, false],
      ].sort(),
    );

    // The target's own offerings are untouched by a merge about others.
    expect(
      (await careersOnOffering(target.first.college_id, target.first.id)).map(
        (row: any) => row.id,
      ),
    ).toEqual([inBoth.id]);
  });
});

/**
 * Link strength (migration 0041): direct / related / conditional. Every link defaults to `direct`,
 * so grading is opt-in; a re-grade on the canonical program applies to every college offering it.
 */
describe('link strength', () => {
  it('links as direct unless told otherwise, and carries the grade to every offering', async () => {
    const { canonicalId, first } = await twoCampuses();
    const plain = await createCareer(token);
    const related = await createCareer(token);

    await linkCanonical(canonicalId, plain.id);
    const response = await api('POST', `/admin/canonical-programs/${canonicalId}/careers`, {
      token,
      body: { career_id: related.id, relationship: 'related' },
    });

    expect(response.status).toBe(201);

    const grades = Object.fromEntries(
      response.body.data.careers.map((row: any) => [row.id, row.relationship]),
    );
    expect(grades).toEqual({ [plain.id]: 'direct', [related.id]: 'related' });

    const onOffering = await careersOnOffering(first.college_id, first.id);
    expect(onOffering.find((row: any) => row.id === related.id).relationship).toBe('related');

    const scorable = await new AcademicCatalogService(db()).scorableCareersForMany([first.id]);
    expect(scorable.get(first.id)?.find((row) => row.id === related.id)?.relationship).toBe(
      'related',
    );
  });

  it('re-grades a canonical link', async () => {
    const { canonicalId } = await twoCampuses();
    const career = await createCareer(token);

    await linkCanonical(canonicalId, career.id);

    const response = await api(
      'PATCH',
      `/admin/canonical-programs/${canonicalId}/careers/${career.id}`,
      { token, body: { relationship: 'conditional' } },
    );

    expect(response.status).toBe(200);
    expect(response.body.data.careers[0].relationship).toBe('conditional');
  });

  it('refuses a grade that does not exist', async () => {
    const { canonicalId } = await twoCampuses();
    const career = await createCareer(token);

    await linkCanonical(canonicalId, career.id);

    const response = await api(
      'PATCH',
      `/admin/canonical-programs/${canonicalId}/careers/${career.id}`,
      { token, body: { relationship: 'broad' } },
    );

    expect(response.status).toBe(422);
  });

  it('re-grades a college extra, but sends an inherited link to its canonical program', async () => {
    const { canonicalId, first } = await twoCampuses();
    const inherited = await createCareer(token);
    const extra = await createCareer(token);

    await linkCanonical(canonicalId, inherited.id);
    await attachCareer(token, first.id, extra.id);

    const onExtra = await api('PATCH', `/admin/programs/${first.id}/careers/${extra.id}`, {
      token,
      body: { relationship: 'related' },
    });

    expect(onExtra.status).toBe(200);
    expect(onExtra.body.data.careers.find((row: any) => row.id === extra.id).relationship).toBe(
      'related',
    );

    const onInherited = await api(
      'PATCH',
      `/admin/programs/${first.id}/careers/${inherited.id}`,
      {
        token,
        body: { relationship: 'related' },
      },
    );

    expect(onInherited.status).toBe(422);
    expect(onInherited.body.errors.relationship[0]).toContain('Canonical programs page');
  });

  it('keeps the grade when a merge carries a career down to the moved offerings', async () => {
    const source = await twoCampuses();
    const target = await twoCampuses();
    const career = await createCareer(token);

    await api('POST', `/admin/canonical-programs/${source.canonicalId}/careers`, {
      token,
      body: { career_id: career.id, relationship: 'conditional' },
    });
    await api('POST', `/admin/canonical-programs/${source.canonicalId}/merge`, {
      token,
      body: { target_id: target.canonicalId },
    });

    const careers = await careersOnOffering(source.first.college_id, source.first.id);

    expect(careers).toEqual([
      expect.objectContaining({ id: career.id, inherited: false, relationship: 'conditional' }),
    ]);
  });
});

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { createDatabase } from '@/db/client';
import { AcademicCatalogService } from '@/modules/catalog/academic-catalog-service';

import {
  api,
  attachCareer,
  createCareer,
  createCollege,
  createProgram,
  createStaffUser,
  login,
} from '../helpers';

/**
 * The Phase 4 read path — the two methods §27 will call, tested now, while the rules that
 * shape them are fresh and the engine that depends on them does not exist yet to paper over
 * a mistake.
 *
 * `rankablePrograms()` is **the single place recommendability is decided**, and Phase 4 is
 * meant to ask nothing else. `scorableCareersFor()` is the set §27 averages over.
 */

function service() {
  return new AcademicCatalogService(createDatabase(env.DB));
}

async function adminToken(): Promise<string> {
  return login(await createStaffUser({ role: 'admin' }));
}

describe('rankablePrograms()', () => {
  /**
   * **Recommendability is a property of the chain, not of the program row.** An `active`
   * program under an `archived` college would otherwise be recommended at an institution the
   * admin has retired — `programs.status` says nothing about whether the college still offers
   * it.
   */
  it('ranks an active program under an active college', async () => {
    const token = await adminToken();
    const college = await createCollege(token);
    const program = await createProgram(token, college.id, { status: 'active' });

    const ids = (await service().rankablePrograms()).map((row) => row.program.id);

    expect(ids).toContain(program.id);
  });

  it('excludes a draft program — §27 ranks only active ones', async () => {
    const token = await adminToken();
    const college = await createCollege(token);
    const program = await createProgram(token, college.id, { status: 'draft' });

    const ids = (await service().rankablePrograms()).map((row) => row.program.id);

    expect(ids).not.toContain(program.id);
  });

  it('excludes an archived program', async () => {
    const token = await adminToken();
    const college = await createCollege(token);
    const program = await createProgram(token, college.id, { status: 'archived' });

    const ids = (await service().rankablePrograms()).map((row) => row.program.id);

    expect(ids).not.toContain(program.id);
  });

  /** The rule the whole method exists for. */
  it('excludes an ACTIVE program whose college is archived', async () => {
    const token = await adminToken();
    const college = await createCollege(token);
    const program = await createProgram(token, college.id, { status: 'active' });

    await api('PATCH', `/admin/colleges/${college.id}`, { token, body: { status: 'archived' } });

    const ids = (await service().rankablePrograms()).map((row) => row.program.id);

    expect(ids).not.toContain(program.id);
  });

  it('ranks it again once the college is restored', async () => {
    const token = await adminToken();
    const college = await createCollege(token);
    const program = await createProgram(token, college.id, { status: 'active' });

    await api('PATCH', `/admin/colleges/${college.id}`, { token, body: { status: 'archived' } });
    await api('PATCH', `/admin/colleges/${college.id}`, { token, body: { status: 'active' } });

    const ids = (await service().rankablePrograms()).map((row) => row.program.id);

    expect(ids).toContain(program.id);
  });

  it('excludes a program whose college was deleted', async () => {
    const token = await adminToken();
    const college = await createCollege(token);
    const program = await createProgram(token, college.id);

    await api('DELETE', `/admin/colleges/${college.id}`, { token });

    const ids = (await service().rankablePrograms()).map((row) => row.program.id);

    expect(ids).not.toContain(program.id);
  });

  it('carries the college alongside the program, so §27 can name it without a second query', async () => {
    const token = await adminToken();
    const college = await createCollege(token);
    const program = await createProgram(token, college.id);

    const row = (await service().rankablePrograms()).find((r) => r.program.id === program.id);

    expect(row?.college.id).toBe(college.id);
    expect(row?.college.name).toBe(college.name);
  });
});

describe('scorableCareersFor()', () => {
  it('returns the active careers linked to the program', async () => {
    const token = await adminToken();
    const college = await createCollege(token);
    const program = await createProgram(token, college.id);
    const career = await createCareer(token, { typical_riasec_code: 'IEC' });

    await attachCareer(token, program.id, career.id);

    const scorable = await service().scorableCareersFor(program.id);

    expect(scorable.map((c) => c.id)).toEqual([career.id]);
  });

  /**
   * The reconciliation FULLPLAN never made: §27 says "for every ACTIVE career" when ranking
   * career matches, but "over all careers linked to this program" for the program score.
   * Resolved in favour of §8 — archiving means "stop recommending this", so a career that is
   * no longer recommended on its own must not keep voting on the score of every program
   * linked to it.
   */
  it('drops an archived career, even though the link survives', async () => {
    const token = await adminToken();
    const college = await createCollege(token);
    const program = await createProgram(token, college.id);
    const career = await createCareer(token);

    await attachCareer(token, program.id, career.id);
    await api('PATCH', `/admin/careers/${career.id}`, { token, body: { status: 'archived' } });

    expect(await service().scorableCareersFor(program.id)).toHaveLength(0);
  });

  it('brings the archived career’s vote back when it is restored', async () => {
    const token = await adminToken();
    const college = await createCollege(token);
    const program = await createProgram(token, college.id);
    const career = await createCareer(token);

    await attachCareer(token, program.id, career.id);
    await api('PATCH', `/admin/careers/${career.id}`, { token, body: { status: 'archived' } });
    await api('PATCH', `/admin/careers/${career.id}`, { token, body: { status: 'active' } });

    expect(await service().scorableCareersFor(program.id)).toHaveLength(1);
  });

  it('drops a deleted career', async () => {
    const token = await adminToken();
    const college = await createCollege(token);
    const program = await createProgram(token, college.id);
    const career = await createCareer(token);

    await attachCareer(token, program.id, career.id);
    await api('DELETE', `/admin/careers/${career.id}`, { token });

    expect(await service().scorableCareersFor(program.id)).toHaveLength(0);
  });

  /**
   * A program whose careers are all archived is **indistinguishable from an unmapped one**,
   * and takes §27's neutral 50 — rather than an average over nothing (which would be NaN, and
   * would silently poison the composite score).
   */
  it('returns an empty set for an unmapped program, exactly as for an all-archived one', async () => {
    const token = await adminToken();
    const college = await createCollege(token);
    const unmapped = await createProgram(token, college.id, { code: 'BSUN' });
    const allArchived = await createProgram(token, college.id, { code: 'BSAR' });
    const career = await createCareer(token);

    await attachCareer(token, allArchived.id, career.id);
    await api('PATCH', `/admin/careers/${career.id}`, { token, body: { status: 'archived' } });

    expect(await service().scorableCareersFor(unmapped.id)).toEqual(
      await service().scorableCareersFor(allArchived.id),
    );
  });
});

import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import { appSettings, recommendations } from '@/db/schema';
import { DEFAULT_FORMULA } from '@/lib/scoring-formula';
import { FORMULA_SETTING_KEY } from '@/modules/recommendation/formula-service';

import {
  answerAll,
  api,
  assignVersion,
  classWithStudent,
  createCareer,
  createCollege,
  createProgram,
  createStaffUser,
  db,
  login,
  seedInstruments,
  type StaffUserFixture,
} from '../helpers';

/**
 * Keeping recommendation sets current (2026-09-22).
 *
 * Sets are snapshots, and since migration 0040 the catalog links and the formula are both edited
 * by admins. A change stamps `recommendation_inputs_changed_at`; any set generated before it is
 * **stale** — shown as such, counted on the admin Matching page, and recomputed from there page by
 * page. The preview scores a hypothetical student against the live (or a draft) configuration and
 * writes nothing.
 */

let admin: StaffUserFixture;
let adminToken: string;
let counselorToken: string;
let assessed: { studentId: string; studentToken: string };
let canonicalId: string;
let careerId: string;

beforeAll(async () => {
  admin = await createStaffUser({ role: 'admin' });
  adminToken = await login(admin);
  counselorToken = await login(await createStaffUser({ role: 'counselor' }));

  const seeded = await seedInstruments(admin);
  const college = await createCollege(adminToken);
  const program = await createProgram(adminToken, college.id, {
    code: `BSFRESH${Date.now() % 1000}`,
  });
  const career = await createCareer(adminToken, { typical_riasec_code: 'IEC' });

  canonicalId = program.program_catalog_id;
  careerId = career.id;

  await api('POST', `/admin/canonical-programs/${canonicalId}/careers`, {
    token: adminToken,
    body: { career_id: careerId },
  });

  const { classRoom, student, studentToken } = await classWithStudent(counselorToken);

  for (const [versionId, pick] of [
    [seeded.riasecVersionId!, (q: any) => (q.section_label === 'Investigative' ? 4 : 0)],
    [seeded.scctVersionId!, () => 3],
  ] as const) {
    const assignment = await assignVersion(counselorToken, classRoom.id, versionId);
    const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });
    await answerAll(studentToken, started.body.data, pick);
    await api('POST', `/student/attempts/${started.body.data.id}/submit`, {
      token: studentToken,
    });
  }

  assessed = { studentId: student.student_id, studentToken };
});

async function freshness() {
  return (await api('GET', '/admin/recommendations/freshness', { token: adminToken })).body
    .data;
}

async function studentSet() {
  return (await api('GET', '/student/recommendations', { token: assessed.studentToken })).body
    .data;
}

async function recomputeAll() {
  let result: any;

  do {
    result = (
      await api('POST', '/admin/recommendations/recompute', { token: adminToken, body: {} })
    ).body.data;
  } while (result.remaining > 0 && result.regenerated > 0);

  return result;
}

describe('stale sets', () => {
  it('a freshly generated set is current', async () => {
    await recomputeAll();

    expect((await studentSet()).stale).toBe(false);
  });

  it('a catalog change makes existing sets stale, and the admin can see how many', async () => {
    await recomputeAll();

    const other = await createCareer(adminToken, { typical_riasec_code: 'IRC' });
    await api('POST', `/admin/canonical-programs/${canonicalId}/careers`, {
      token: adminToken,
      body: { career_id: other.id },
    });

    expect((await studentSet()).stale).toBe(true);

    const summary = await freshness();

    expect(summary.inputs_changed_at).not.toBeNull();
    expect(summary.stale_sets).toBeGreaterThanOrEqual(1);
    expect(summary.students_with_sets).toBeGreaterThanOrEqual(summary.stale_sets);
  });

  it('a formula change makes existing sets stale', async () => {
    await recomputeAll();
    expect((await studentSet()).stale).toBe(false);

    await api('PUT', '/admin/recommendation-formula', {
      token: adminToken,
      body: { ...DEFAULT_FORMULA, topN: 9, current_password: admin.password },
    });

    try {
      expect((await studentSet()).stale).toBe(true);
    } finally {
      await db().delete(appSettings).where(eq(appSettings.key, FORMULA_SETTING_KEY));
    }
  });

  it('recompute works the stale sets down to zero, and says so when there is nothing left', async () => {
    await api('PATCH', `/admin/careers/${careerId}`, {
      token: adminToken,
      body: { typical_riasec_code: 'ICE' },
    });

    expect((await freshness()).stale_sets).toBeGreaterThanOrEqual(1);

    const last = await recomputeAll();

    expect(last.remaining).toBe(0);
    expect((await freshness()).stale_sets).toBe(0);
    expect((await studentSet()).stale).toBe(false);

    const idle = await api('POST', '/admin/recommendations/recompute', {
      token: adminToken,
      body: {},
    });

    expect(idle.body.data).toEqual({ regenerated: 0, failed: 0, remaining: 0 });
    expect(idle.body.message).toContain('current');
  });

  it('refuses a page larger than the subrequest budget allows', async () => {
    const response = await api('POST', '/admin/recommendations/recompute', {
      token: adminToken,
      body: { limit: 50 },
    });

    expect(response.status).toBe(422);
  });
});

describe('preview', () => {
  const investigative = {
    riasec: { R: 10, I: 95, A: 20, S: 15, E: 30, C: 40 },
    career_confidence: 80,
    academic_average: 88,
    strand: 'Academic',
  };

  it('ranks the live catalog for a hypothetical student and writes nothing', async () => {
    const before = await db()
      .select()
      .from(recommendations)
      .where(eq(recommendations.studentId, assessed.studentId));

    const response = await api('POST', '/admin/recommendations/preview', {
      token: adminToken,
      body: investigative,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.careers.length).toBeGreaterThan(0);
    expect(response.body.data.programs.length).toBeGreaterThan(0);

    const top = response.body.data.careers[0];
    expect(top).toEqual(
      expect.objectContaining({ match_score: expect.any(Number), reason: expect.any(String) }),
    );

    const after = await db()
      .select()
      .from(recommendations)
      .where(eq(recommendations.studentId, assessed.studentId));

    expect(after.map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort());
  });

  it('scores against a draft formula without saving it', async () => {
    const live = await api('POST', '/admin/recommendations/preview', {
      token: adminToken,
      body: investigative,
    });
    const draft = await api('POST', '/admin/recommendations/preview', {
      token: adminToken,
      body: {
        ...investigative,
        formula: {
          ...DEFAULT_FORMULA,
          career: { riasecCompatibility: 0.1, careerConfidence: 0.8, studentPreference: 0.1 },
          topN: 5,
        },
      },
    });

    expect(draft.status).toBe(200);
    expect(draft.body.data.careers.length).toBeLessThanOrEqual(5);
    expect(draft.body.data.careers[0].match_score).not.toBe(
      live.body.data.careers[0].match_score,
    );

    const stored = await api('GET', '/admin/recommendation-formula', { token: adminToken });
    expect(stored.body.data.is_default).toBe(true);
  });

  it('refuses a draft formula that would not save', async () => {
    const response = await api('POST', '/admin/recommendations/preview', {
      token: adminToken,
      body: {
        ...investigative,
        formula: {
          ...DEFAULT_FORMULA,
          career: { ...DEFAULT_FORMULA.career, careerConfidence: 0.9 },
        },
      },
    });

    expect(response.status).toBe(422);
  });
});

describe('authorization', () => {
  it.each([
    ['GET', '/admin/recommendations/freshness'],
    ['POST', '/admin/recommendations/recompute'],
    ['POST', '/admin/recommendations/preview'],
  ])('%s %s is admin-only', async (method, path) => {
    const response = await api(method, path, {
      token: counselorToken,
      ...(method === 'GET' ? {} : { body: {} }),
    });

    expect(response.status).toBe(403);
  });
});

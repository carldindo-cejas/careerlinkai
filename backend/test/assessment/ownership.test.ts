import { beforeAll, describe, expect, it } from 'vitest';

import {
  api,
  assignVersion,
  classWithStudent,
  createStaffUser,
  login,
  seedInstruments,
  type StaffUserFixture,
} from '../helpers';

/**
 * **Counselor-owned assessment versions, and the isolation between them** (prompt §1–§3).
 *
 * The rules this file pins, all of them server-side and none of them satisfied by hiding a button:
 *
 * | act                                             | counselor A (owner) | counselor B | admin |
 * |---|---|---|---|
 * | copy a GLOBAL instrument                        | ✅ (→ their own)     | ✅ (→ theirs) | ✅ (→ global) |
 * | see A's copy in the list                        | ✅                  | ❌          | ✅ |
 * | open A's copy by id                             | ✅                  | ❌ 404      | ✅ |
 * | edit / publish / archive A's copy               | ✅                  | ❌ 404      | ✅ |
 * | assign A's copy to their own class              | ✅                  | ❌ 404      | ✅ |
 * | assign anything **globally**                    | ❌ 403              | ❌ 403      | ✅ |
 *
 * Two of these are the ones that cannot be reconstructed from the role table and must not be lost:
 *
 *   1. **Assigning globally is administrator-only.** Not because breadth is a seniority matter, but
 *      because `scope = 'GLOBAL'` is a *standing instruction*: `applyGlobalAssignmentsToClass`
 *      replays it onto every class created afterwards, including classes belonging to counselors
 *      who do not exist yet. A per-act filter protects the classes that exist now and cannot
 *      protect those.
 *   2. **A counselor cannot assign another counselor's private version to their own class.** The
 *      class-scoped assign endpoint authorized the *class* and the version's *status*, and nothing
 *      about whose instrument it was — so a leaked version id plus a class you legitimately own was
 *      a complete bypass. The test drives it through the real endpoint with a real id.
 */

let admin: StaffUserFixture;
let adminToken: string;
let counselorA: StaffUserFixture;
let tokenA: string;
let counselorB: StaffUserFixture;
let tokenB: string;
let riasecTemplateId: string;
let scctTemplateId: string;

beforeAll(async () => {
  admin = await createStaffUser({ role: 'admin' });
  adminToken = await login(admin);

  counselorA = await createStaffUser({ role: 'counselor', name: 'Counselor Alpha' });
  tokenA = await login(counselorA);

  counselorB = await createStaffUser({ role: 'counselor', name: 'Counselor Beta' });
  tokenB = await login(counselorB);

  await seedInstruments(admin);

  const list = await api('GET', '/assessments?per_page=100', { token: adminToken });

  riasecTemplateId = list.body.data.items.find((row: any) => row.category === 'RIASEC').id;
  scctTemplateId = list.body.data.items.find((row: any) => row.category === 'SCCT').id;
});

/** Copy an instrument as `token` and return the new row. */
async function copy(token: string, templateId: string): Promise<any> {
  const response = await api('POST', `/assessment-templates/${templateId}/copy`, { token });

  if (response.status !== 201) {
    throw new Error(`Copy failed: ${JSON.stringify(response.body)}`);
  }

  return response.body.data;
}

describe('copying a curated instrument', () => {
  it('gives the counselor a private DRAFT they own, carrying the questions and the dimensions', async () => {
    const copied = await copy(tokenA, riasecTemplateId);

    expect(copied.assessment.ownership).toBe('COUNSELOR_PRIVATE');
    expect(copied.assessment.author.id).toBe(counselorA.id);
    expect(copied.assessment.source_template_id).toBe(riasecTemplateId);
    // Still RIASEC. That is what keeps §5's permanent AI rule attached to the copy.
    expect(copied.assessment.category).toBe('RIASEC');
    expect(copied.assessment.ai_generatable).toBe(false);
    expect(copied.assessment.can_manage).toBe(true);

    // A draft the counselor publishes themselves — copying does not publish on their behalf.
    expect(copied.version.status).toBe('DRAFT');
    expect(copied.version.version_number).toBe(1);
    expect(copied.version.source_version_id).not.toBeNull();
    expect(copied.question_count).toBe(60);

    const detail = await api(`GET`, `/assessment-templates/${copied.assessment.id}`, {
      token: tokenA,
    });

    expect(detail.status).toBe(200);
    // Without these the copy would publish as an ungraded survey that looks identical in the builder.
    expect(detail.body.data.dimensions.map((d: any) => d.code)).toEqual([
      'R',
      'I',
      'A',
      'S',
      'E',
      'C',
    ]);
  });

  it('carries SCCT’s weighted scoring config, not a rebuilt default', async () => {
    const copied = await copy(tokenA, scctTemplateId);

    expect(copied.version.scoring_algorithm).toBe('WEIGHTED_COMPOSITE');

    const row = await api('GET', `/assessment-versions/${copied.version.id}`, { token: tokenA });

    expect(row.status).toBe(200);
    expect(row.body.data.questions).toHaveLength(30);
  });

  it('names the copy after its owner, and keeps a second copy distinct', async () => {
    const first = await copy(tokenA, riasecTemplateId);
    const second = await copy(tokenA, riasecTemplateId);

    expect(first.assessment.title).not.toBe(second.assessment.title);
    expect(first.assessment.title).toContain('Counselor Alpha');
  });

  it('is refused for another counselor’s private instrument — a 404, not a 403', async () => {
    const mine = await copy(tokenA, riasecTemplateId);

    const response = await api('POST', `/assessment-templates/${mine.assessment.id}/copy`, {
      token: tokenB,
    });

    expect(response.status).toBe(404);
  });
});

describe('ownership isolation between counselors', () => {
  it('keeps A’s copy out of B’s list while leaving it in A’s and the admin’s', async () => {
    const copied = await copy(tokenA, riasecTemplateId);
    const id = copied.assessment.id;

    const forA = await api('GET', '/assessments?per_page=100', { token: tokenA });
    const forB = await api('GET', '/assessments?per_page=100', { token: tokenB });
    const forAdmin = await api('GET', '/assessments?per_page=100', { token: adminToken });

    expect(forA.body.data.items.some((row: any) => row.id === id)).toBe(true);
    expect(forB.body.data.items.some((row: any) => row.id === id)).toBe(false);
    expect(forAdmin.body.data.items.some((row: any) => row.id === id)).toBe(true);
  });

  it('refuses B every act on A’s copy, by direct id', async () => {
    const copied = await copy(tokenA, riasecTemplateId);
    const templateId = copied.assessment.id;
    const versionId = copied.version.id;

    // Read — the template, and the version beneath it.
    expect((await api('GET', `/assessment-templates/${templateId}`, { token: tokenB })).status).toBe(404);
    expect((await api('GET', `/assessment-versions/${versionId}`, { token: tokenB })).status).toBe(404);

    // Write.
    expect(
      (
        await api('PATCH', `/assessment-templates/${templateId}`, {
          token: tokenB,
          body: { title: 'Taken over', description: null, ...(await taxonomyOf(templateId, tokenA)) },
        })
      ).status,
    ).toBe(404);

    expect(
      (await api('POST', `/assessment-templates/${templateId}/archive`, { token: tokenB })).status,
    ).toBe(404);

    expect(
      (await api('POST', `/assessment-versions/${versionId}/publish`, { token: tokenB })).status,
    ).toBe(404);

    expect(
      (
        await api('PATCH', `/assessment-templates/${templateId}/presentation-mode`, {
          token: tokenB,
          body: { presentation_mode: 'RANDOM' },
        })
      ).status,
    ).toBe(404);
  });

  it('lets A edit, publish and archive their own copy end to end', async () => {
    const copied = await copy(tokenA, riasecTemplateId);
    const versionId = copied.version.id;

    const review = await api('GET', `/assessment-versions/${versionId}`, { token: tokenA });
    const firstQuestion = review.body.data.questions[0];

    const edited = await api('PATCH', `/assessment-questions/${firstQuestion.id}`, {
      token: tokenA,
      body: { question_text: 'I enjoy working with tools in a workshop.' },
    });

    expect(edited.status).toBe(200);
    expect(edited.body.data.question_text).toBe('I enjoy working with tools in a workshop.');

    const published = await api('POST', `/assessment-versions/${versionId}/publish`, {
      token: tokenA,
    });

    expect(published.status).toBe(200);
    expect(published.body.data.status).toBe('PUBLISHED');

    const archived = await api('POST', `/assessment-templates/${copied.assessment.id}/archive`, {
      token: tokenA,
    });

    expect(archived.status).toBe(200);
    expect(archived.body.data.is_archived).toBe(true);

    // The published version is still there — archiving retires the instrument, it does not delete
    // the version a student's result would point at.
    const detail = await api('GET', `/assessment-templates/${copied.assessment.id}`, {
      token: tokenA,
    });

    expect(detail.body.data.versions.some((v: any) => v.status === 'PUBLISHED')).toBe(true);
  });
});

describe('assignment', () => {
  it('refuses a counselor a GLOBAL assignment — 403, at the endpoint', async () => {
    const copied = await copy(tokenA, riasecTemplateId);

    await api('POST', `/assessment-versions/${copied.version.id}/publish`, { token: tokenA });

    const response = await api('POST', `/assessment-templates/${copied.assessment.id}/assignments`, {
      token: tokenA,
      body: { scope: 'GLOBAL' },
    });

    expect(response.status).toBe(403);
    expect(response.body.message).toMatch(/administrator/i);
  });

  it('still lets the admin assign globally', async () => {
    const response = await api('POST', `/assessment-templates/${riasecTemplateId}/assignments`, {
      token: adminToken,
      body: { scope: 'GLOBAL' },
    });

    // 201 whether or not there were classes to add it to — what matters is that it is not refused.
    expect([201, 422]).toContain(response.status);
    expect(response.status).not.toBe(403);
  });

  it('refuses B assigning A’s private version to B’s own class', async () => {
    const copied = await copy(tokenA, riasecTemplateId);

    await api('POST', `/assessment-versions/${copied.version.id}/publish`, { token: tokenA });

    const { classRoom } = await classWithStudent(tokenB, 'Beta Student');

    // The class is genuinely B's, and the version id is genuinely published. The only thing wrong
    // with this request is whose instrument it is — which is exactly what used to go unchecked.
    const response = await api('POST', `/counselor/classes/${classRoom.id}/assignments`, {
      token: tokenB,
      body: { assessment_version_id: copied.version.id },
    });

    expect(response.status).toBe(404);
  });

  it('lets A assign their own published copy to their own class, and the student sees it', async () => {
    const copied = await copy(tokenA, riasecTemplateId);

    await api('POST', `/assessment-versions/${copied.version.id}/publish`, { token: tokenA });

    // Two classes, both A's. Only one of them gets the assignment.
    const assigned = await classWithStudent(tokenA, 'Alpha Student');
    const unassigned = await classWithStudent(tokenA, 'Alpha Student Two');

    await assignVersion(tokenA, assigned.classRoom.id, copied.version.id);

    const mine = await api('GET', '/student/assignments', { token: assigned.studentToken });

    expect(mine.status).toBe(200);
    expect(
      mine.body.data.some((row: any) => row.assessment.version_id === copied.version.id),
    ).toBe(true);

    // …and a student of a *different* class does not see it — the assignment is the only route in.
    const others = await api('GET', '/student/assignments', {
      token: unassigned.studentToken,
    });

    expect(
      others.body.data.some((row: any) => row.assessment.version_id === copied.version.id),
    ).toBe(false);
  });

  it('keeps a private assessment out of an unrelated counselor’s students’ lists', async () => {
    const copied = await copy(tokenA, scctTemplateId);

    await api('POST', `/assessment-versions/${copied.version.id}/publish`, { token: tokenA });

    const ownClass = await classWithStudent(tokenA, 'Alpha Three');

    await assignVersion(tokenA, ownClass.classRoom.id, copied.version.id);

    const otherCounselorsStudent = await classWithStudent(tokenB, 'Beta Two');
    const list = await api('GET', '/student/assignments', {
      token: otherCounselorsStudent.studentToken,
    });

    expect(
      list.body.data.some((row: any) => row.assessment.version_id === copied.version.id),
    ).toBe(false);
  });
});

describe('a counselor reading a curated instrument', () => {
  it('may open it, and is told they cannot author it', async () => {
    const response = await api('GET', `/assessment-templates/${riasecTemplateId}`, {
      token: tokenA,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.can_manage).toBe(false);
    expect(response.body.data.can_copy).toBe(true);
  });

  it('may not write to it', async () => {
    const response = await api('POST', `/assessment-templates/${riasecTemplateId}/archive`, {
      token: tokenA,
    });

    expect(response.status).toBe(404);
  });
});

/** The taxonomy fields a PATCH of an existing template has to echo back. */
async function taxonomyOf(templateId: string, token: string) {
  const detail = await api('GET', `/assessment-templates/${templateId}`, { token });

  return {
    assessment_type_id: detail.body.data.assessment_type_id,
    scoring_ids: detail.body.data.scorings.map((scoring: any) => scoring.id),
  };
}

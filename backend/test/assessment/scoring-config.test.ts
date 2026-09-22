import { beforeAll, describe, expect, it } from 'vitest';

import { ScoringService } from '@/modules/assessment/scoring-service';

import {
  allAuditRows,
  answerAll,
  api,
  assignVersion,
  classWithStudent,
  createStaffUser,
  db,
  login,
  seedInstruments,
} from '../helpers';

/**
 * **The Scoring panel's contract** — editing SCCT's composite weights and bands on a draft.
 *
 * The property this file exists to pin is the last one: re-weighting SCCT and publishing the next
 * version must not move a single existing student's career-confidence score. Every score is
 * recomputed from the version the student took, so the only way this could break is if an edit
 * reached a published version — which is what the rest of the file refuses.
 */

let adminToken: string;
let counselorToken: string;
let scctVersionId: string;

const BANDS = [
  { min: 0, max: 50, label: 'Developing' },
  { min: 50, max: 80, label: 'Solid' },
  { min: 80, max: 100, label: 'Strong' },
];

beforeAll(async () => {
  const admin = await createStaffUser({ role: 'admin' });
  adminToken = await login(admin);
  counselorToken = await login(await createStaffUser({ role: 'counselor' }));
  scctVersionId = (await seedInstruments(admin)).scctVersionId!;
});

/** A fresh draft of SCCT, copied from the published seed version. */
async function scctDraft(): Promise<string> {
  const copied = await api('POST', `/assessment-versions/${scctVersionId}/duplicate`, {
    token: adminToken,
  });

  expect(copied.status).toBe(201);

  return copied.body.data.id as string;
}

function patchScoring(versionId: string, body: unknown) {
  return api('PATCH', `/assessment-versions/${versionId}/scoring-config`, {
    token: adminToken,
    body,
  });
}

describe('editing weights on a draft', () => {
  it('saves weights and bands, highest band first, and audits the old and new values', async () => {
    const draftId = await scctDraft();

    const saved = await patchScoring(draftId, {
      composite_weights: { SE: 0.5, OE: 0.25, GO: 0.25 },
      composite_ranges: BANDS,
    });

    expect(saved.status).toBe(200);
    expect(saved.body.data.composite_weights).toEqual({ SE: 0.5, OE: 0.25, GO: 0.25 });
    expect(saved.body.data.composite_ranges.map((r: any) => r.label)).toEqual([
      'Strong',
      'Solid',
      'Developing',
    ]);

    const row = (await allAuditRows()).find(
      (r) => r.action === 'VERSION_SCORING_CONFIG_UPDATED' && r.targetId === draftId,
    );

    expect((row!.oldValues as any).composite_weights).toEqual({ SE: 0.4, OE: 0.3, GO: 0.3 });
    expect((row!.newValues as any).composite_weights).toEqual({ SE: 0.5, OE: 0.25, GO: 0.25 });
  });

  it('refuses a published version with a 422', async () => {
    const refused = await patchScoring(scctVersionId, {
      composite_weights: { SE: 0.5, OE: 0.25, GO: 0.25 },
      composite_ranges: BANDS,
    });

    expect(refused.status).toBe(422);
    expect(refused.body.errors.version).toBeDefined();

    const read = await api('GET', `/assessment-versions/${scctVersionId}`, { token: adminToken });

    expect(read.body.data.composite_weights).toEqual({ SE: 0.4, OE: 0.3, GO: 0.3 });
  });

  it("refuses a counselor editing a version they cannot manage", async () => {
    const draftId = await scctDraft();
    const refused = await api('PATCH', `/assessment-versions/${draftId}/scoring-config`, {
      token: counselorToken,
      body: { composite_weights: { SE: 1 }, composite_ranges: BANDS },
    });

    expect([403, 404]).toContain(refused.status);
  });

  it.each([
    ['a total under 100%', { SE: 0.4, OE: 0.3, GO: 0.2 }, 'composite_weights'],
    ['a total over 100%', { SE: 0.5, OE: 0.3, GO: 0.3 }, 'composite_weights'],
    ['an unknown dimension', { SE: 0.4, OE: 0.3, XX: 0.3 }, 'composite_weights'],
    ['a zero weight', { SE: 0.7, OE: 0.3, GO: 0 }, 'composite_weights'],
    ['no weights at all', {}, 'composite_weights'],
  ])('refuses %s', async (_name, weights, field) => {
    const draftId = await scctDraft();
    const refused = await patchScoring(draftId, {
      composite_weights: weights,
      composite_ranges: BANDS,
    });

    expect(refused.status).toBe(422);
    expect(refused.body.errors[field]).toBeDefined();
  });

  it('accepts thirds that only add up to 100% within float slack', async () => {
    const draftId = await scctDraft();
    const saved = await patchScoring(draftId, {
      composite_weights: { SE: 0.333, OE: 0.333, GO: 0.334 },
      composite_ranges: BANDS,
    });

    expect(saved.status).toBe(200);
  });

  it.each([
    ['a gap', [{ min: 0, max: 40, label: 'Low' }, { min: 50, max: 100, label: 'High' }]],
    ['an overlap', [{ min: 0, max: 60, label: 'Low' }, { min: 50, max: 100, label: 'High' }]],
    ['a band not starting at 0', [{ min: 10, max: 100, label: 'All' }]],
    ['a band not ending at 100', [{ min: 0, max: 90, label: 'All' }]],
    ['a blank label', [{ min: 0, max: 100, label: '  ' }]],
    ['no bands', []],
  ])('refuses bands with %s', async (_name, ranges) => {
    const draftId = await scctDraft();
    const refused = await patchScoring(draftId, {
      composite_weights: { SE: 0.4, OE: 0.3, GO: 0.3 },
      composite_ranges: ranges,
    });

    expect(refused.status).toBe(422);
    expect(refused.body.errors.composite_ranges).toBeDefined();
  });
});

describe('publishing and duplicating', () => {
  it('blocks publishing an SCCT draft whose weights are missing', async () => {
    const draftId = await scctDraft();

    // Only reachable by writing the column directly — the endpoint cannot produce it — which is
    // exactly the state the publish check exists for (the scorer would quietly average instead).
    const { assessmentVersions } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');

    await db()
      .update(assessmentVersions)
      .set({ scoringConfig: { algorithm: 'WEIGHTED_COMPOSITE' } })
      .where(eq(assessmentVersions.id, draftId));

    const refused = await api('POST', `/assessment-versions/${draftId}/publish`, {
      token: adminToken,
    });

    expect(refused.status).toBe(422);
    expect(refused.body.errors.composite_weights).toBeDefined();
  });

  it('carries edited weights into the next duplicate, and leaves the source untouched', async () => {
    const draftId = await scctDraft();

    await patchScoring(draftId, {
      composite_weights: { SE: 0.6, OE: 0.2, GO: 0.2 },
      composite_ranges: BANDS,
    });

    const copied = await api('POST', `/assessment-versions/${draftId}/duplicate`, {
      token: adminToken,
    });

    expect(copied.body.data.composite_weights).toEqual({ SE: 0.6, OE: 0.2, GO: 0.2 });

    await patchScoring(copied.body.data.id, {
      composite_weights: { SE: 0.2, OE: 0.4, GO: 0.4 },
      composite_ranges: BANDS,
    });

    const source = await api('GET', `/assessment-versions/${draftId}`, { token: adminToken });

    expect(source.body.data.composite_weights).toEqual({ SE: 0.6, OE: 0.2, GO: 0.2 });
  });

  it("keeps a v1 student's career-confidence score after a re-weighted version publishes", async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const assignment = await assignVersion(counselorToken, classRoom.id, scctVersionId);
    const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });

    // Uneven on purpose: high self-efficacy, low everything else, so any change to SE's weight
    // would move the index.
    await answerAll(studentToken, started.body.data, (question) =>
      question.section_label === 'Self-Efficacy' ? 4 : 0,
    );

    const submitted = await api('POST', `/student/attempts/${started.body.data.id}/submit`, {
      token: studentToken,
    });

    expect(submitted.status).toBe(200);

    const scoring = new ScoringService(db());
    const before = await scoring.compositeIndexFor(started.body.data.id);

    const draftId = await scctDraft();

    await patchScoring(draftId, {
      composite_weights: { SE: 0.1, OE: 0.45, GO: 0.45 },
      composite_ranges: BANDS,
    });

    const published = await api('POST', `/assessment-versions/${draftId}/publish`, {
      token: adminToken,
    });

    expect(published.status).toBe(200);
    expect(before).not.toBeNull();

    // The count an author sees before re-weighting: v1 has this student (and any others this file
    // scored), the new version has nobody yet.
    const v1 = await api('GET', `/assessment-versions/${scctVersionId}`, { token: adminToken });
    const v2 = await api('GET', `/assessment-versions/${draftId}`, { token: adminToken });

    expect(v1.body.data.scored_student_count).toBeGreaterThanOrEqual(1);
    expect(v2.body.data.scored_student_count).toBe(0);

    const template = await api('GET', `/assessment-templates/${v1.body.data.template.id}`, {
      token: adminToken,
    });
    const listed = template.body.data.versions.find((v: any) => v.id === scctVersionId);

    expect(listed.scored_student_count).toBe(v1.body.data.scored_student_count);
    expect(await scoring.compositeIndexFor(started.body.data.id)).toBe(before);
  });
});

describe('whose students a scored count covers', () => {
  /** One fresh counselor with one student who has completed SCCT v1 through their class. */
  async function counselorWithScoredStudent(): Promise<string> {
    const token = await login(await createStaffUser({ role: 'counselor' }));
    const { classRoom, studentToken } = await classWithStudent(token);
    const assignment = await assignVersion(token, classRoom.id, scctVersionId);
    const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });

    await answerAll(studentToken, started.body.data, () => 2);

    const submitted = await api('POST', `/student/attempts/${started.body.data.id}/submit`, {
      token: studentToken,
    });

    expect(submitted.status).toBe(200);

    return token;
  }

  async function scoredCount(token: string): Promise<number> {
    const read = await api('GET', `/assessment-versions/${scctVersionId}`, { token });

    return read.body.data.scored_student_count;
  }

  it("shows a counselor only their own classes' students on SCCT, and an admin everyone", async () => {
    const first = await counselorWithScoredStudent();
    const second = await counselorWithScoredStudent();
    const bystander = await login(await createStaffUser({ role: 'counselor' }));

    expect(await scoredCount(first)).toBe(1);
    expect(await scoredCount(second)).toBe(1);
    expect(await scoredCount(bystander)).toBe(0);
    expect(await scoredCount(adminToken)).toBeGreaterThanOrEqual(2);

    // The version list on the template agrees with the single-version read.
    const read = await api('GET', `/assessment-versions/${scctVersionId}`, { token: first });
    const template = await api('GET', `/assessment-templates/${read.body.data.template.id}`, {
      token: first,
    });

    expect(
      template.body.data.versions.find((v: any) => v.id === scctVersionId).scored_student_count,
    ).toBe(1);
  });
});

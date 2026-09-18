import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  answerAll,
  api,
  assignVersion,
  classWithStudent,
  createStaffUser,
  login,
  seedInstruments,
  type StaffUserFixture,
} from '../helpers';

/**
 * **Archiving a published version, and what must survive it** (prompt §4).
 *
 * The brief's requirement is precise and the risk in it is specific: *"Do not permanently delete
 * published assessment versions if doing so would break historical student results"* and *"Do not
 * allow later editing of a published version to silently change the historical meaning of an
 * already-completed assessment."*
 *
 * So this file archives a version a student has already sat, and then checks that the student's
 * result is **byte-for-byte the same as before** — the Holland Code, every dimension score, and the
 * item-by-item report appendix that names the exact questions they were asked and what each answer
 * scored. If archiving ever became a delete, or ever cascaded, this is the test that fails.
 *
 * The chain it is pinning:
 *
 *     student → attempt → assessment_version_id → questions/options → answers (frozen score)
 *
 * and the property that makes it hold: **the version row is never removed, only re-statused**, and
 * `assessment_answers.score` is a server-side snapshot rather than a live join (§13.5).
 */

let admin: StaffUserFixture;
let adminToken: string;
let counselorToken: string;
let riasecVersionId: string;
let riasecTemplateId: string;

beforeAll(async () => {
  admin = await createStaffUser({ role: 'admin' });
  adminToken = await login(admin);

  const counselor = await createStaffUser({ role: 'counselor' });
  counselorToken = await login(counselor);

  const seeded = await seedInstruments(admin);

  riasecVersionId = seeded.riasecVersionId!;

  const list = await api('GET', '/assessments?per_page=100', { token: adminToken });

  riasecTemplateId = list.body.data.items.find((row: any) => row.category === 'RIASEC').id;
});

/** A student who has completed RIASEC, and their scored result. */
async function completedAttempt() {
  const { classRoom, studentToken } = await classWithStudent(counselorToken);
  const assignment = await assignVersion(counselorToken, classRoom.id, riasecVersionId);
  const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
    token: studentToken,
  });

  await answerAll(studentToken, started.body.data, (question) =>
    question.section_label === 'Investigative' ? 4 : 1,
  );

  const submitted = await api('POST', `/student/attempts/${started.body.data.id}/submit`, {
    token: studentToken,
  });

  expect(submitted.status).toBe(200);

  return { studentToken, attemptId: started.body.data.id, result: submitted.body.data };
}

describe('archiving a published version', () => {
  it('stops it being offered and refuses a new attempt, without deleting anything', async () => {
    const before = await api('GET', `/assessment-versions/${riasecVersionId}`, {
      token: adminToken,
    });

    expect(before.body.data.status).toBe('PUBLISHED');

    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const assignment = await assignVersion(counselorToken, classRoom.id, riasecVersionId);

    const archived = await api('POST', `/assessment-versions/${riasecVersionId}/archive`, {
      token: adminToken,
    });

    expect(archived.status).toBe(200);
    expect(archived.body.data.status).toBe('ARCHIVED');

    // Gone from what the student is offered…
    const offered = await api('GET', '/student/assignments', { token: studentToken });

    expect(
      offered.body.data.some((row: any) => row.assessment.version_id === riasecVersionId),
    ).toBe(false);

    // …and refused as an act, not merely hidden.
    const start = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });

    expect(start.status).toBe(422);

    // The version and all sixty of its questions are still there. Archiving is a status.
    const rows = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM assessment_versions WHERE id = ?1) AS versions,
              (SELECT COUNT(*) FROM assessment_questions WHERE assessment_version_id = ?1) AS questions`,
    )
      .bind(riasecVersionId)
      .first<{ versions: number; questions: number }>();

    expect(rows?.versions).toBe(1);
    expect(rows?.questions).toBe(60);

    await api('POST', `/assessment-versions/${riasecVersionId}/restore`, { token: adminToken });
  });

  /** The requirement, stated as a test: a completed result does not move. */
  it('leaves a completed student’s result and report exactly as they were', async () => {
    const { studentToken, attemptId, result } = await completedAttempt();

    const reportBefore = await api('GET', `/student/results/${attemptId}/report`, {
      token: studentToken,
    });

    expect(reportBefore.status).toBe(200);

    const archived = await api('POST', `/assessment-versions/${riasecVersionId}/archive`, {
      token: adminToken,
    });

    expect(archived.status).toBe(200);

    const resultAfter = await api('GET', `/student/results/${attemptId}`, { token: studentToken });
    const reportAfter = await api('GET', `/student/results/${attemptId}/report`, {
      token: studentToken,
    });

    expect(resultAfter.status).toBe(200);
    expect(resultAfter.body.data.result.result_code).toBe(result.result.result_code);
    expect(resultAfter.body.data.dimensions).toEqual(result.dimensions);

    // The item appendix — the exact questions asked and what each answer scored — is untouched.
    expect(reportAfter.body.data.items).toEqual(reportBefore.body.data.items);
    expect(reportAfter.body.data.items).toHaveLength(60);

    await api('POST', `/assessment-versions/${riasecVersionId}/restore`, { token: adminToken });
  });

  it('restores to PUBLISHED, because that is what it was', async () => {
    await api('POST', `/assessment-versions/${riasecVersionId}/archive`, { token: adminToken });

    const restored = await api('POST', `/assessment-versions/${riasecVersionId}/restore`, {
      token: adminToken,
    });

    expect(restored.status).toBe(200);
    // `published_at` is the record of the act (migration 0016), and it is what decides this — a
    // draft archived before release must not be promoted by a restore.
    expect(restored.body.data.status).toBe('PUBLISHED');
  });

  it('is idempotent in both directions', async () => {
    await api('POST', `/assessment-versions/${riasecVersionId}/archive`, { token: adminToken });

    const again = await api('POST', `/assessment-versions/${riasecVersionId}/archive`, {
      token: adminToken,
    });

    expect(again.status).toBe(200);
    expect(again.body.data.status).toBe('ARCHIVED');

    await api('POST', `/assessment-versions/${riasecVersionId}/restore`, { token: adminToken });

    const restoredAgain = await api('POST', `/assessment-versions/${riasecVersionId}/restore`, {
      token: adminToken,
    });

    expect(restoredAgain.status).toBe(200);
    expect(restoredAgain.body.data.status).toBe('PUBLISHED');
  });

  it('is refused to a counselor against a global instrument, and allowed on their own copy', async () => {
    const refused = await api('POST', `/assessment-versions/${riasecVersionId}/archive`, {
      token: counselorToken,
    });

    expect(refused.status).toBe(404);

    const copied = await api('POST', `/assessment-templates/${riasecTemplateId}/copy`, {
      token: counselorToken,
    });

    expect(copied.status).toBe(201);

    await api('POST', `/assessment-versions/${copied.body.data.version.id}/publish`, {
      token: counselorToken,
    });

    const own = await api('POST', `/assessment-versions/${copied.body.data.version.id}/archive`, {
      token: counselorToken,
    });

    expect(own.status).toBe(200);
    expect(own.body.data.status).toBe('ARCHIVED');
  });
});

/**
 * The other half of §4's requirement: a published version's *content* cannot be edited at all, so
 * "editing a published version silently changes history" is not a thing that can happen.
 *
 * Covered from another angle in `invariants.test.ts`; asserted here too, next to the archive it is
 * easily confused with — archiving writes a status, and that is the only thing about a published
 * version that may ever change.
 */
describe('a published version’s content', () => {
  it('cannot be edited, even by the administrator who published it', async () => {
    const review = await api('GET', `/assessment-versions/${riasecVersionId}`, {
      token: adminToken,
    });

    const [question] = review.body.data.questions;

    const edit = await api('PATCH', `/assessment-questions/${question.id}`, {
      token: adminToken,
      body: { question_text: 'Rewritten after the fact.' },
    });

    expect(edit.status).toBe(422);

    const unchanged = await api('GET', `/assessment-versions/${riasecVersionId}`, {
      token: adminToken,
    });

    expect(unchanged.body.data.questions[0].question_text).toBe(question.question_text);
  });
});

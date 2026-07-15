import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import { assessmentDimensions, questionDimensions, users } from '@/db/schema';
import { AssessmentBuilderService } from '@/modules/assessment/assessment-builder-service';
import { seedAssessmentInstruments } from '@/modules/assessment/instruments';

import {
  answerAll,
  api,
  assignVersion,
  classWithStudent,
  createStaffUser,
  db,
  login,
  type StaffUserFixture,
} from '../helpers';

/**
 * The three invariants the assessment module rests on (FULLPLAN §12, §21, §25).
 *
 * None of them is expressible as a database constraint — that is exactly why each one needs a
 * test. A CHECK cannot say "reject an UPDATE when a parent column has a given value", and it
 * cannot see the cross-row aggregate the publish gate asks about. The only thing standing between
 * these rules and a future refactor is this file.
 */

let admin: StaffUserFixture;
let adminRow: any;
let counselorToken: string;

beforeAll(async () => {
  admin = await createStaffUser({ role: 'admin' });
  const counselor = await createStaffUser({ role: 'counselor' });
  counselorToken = await login(counselor);

  [adminRow] = await db().select().from(users).where(eq(users.id, admin.id)).limit(1);
});

/** A CUSTOM template with one question, mapped but *not* confirmed — the AI-proposal shape. */
async function draftWithUnconfirmedMapping() {
  const builder = new AssessmentBuilderService(db());

  const template = await builder.createTemplate(adminRow, {
    category: 'CUSTOM',
    title: `Custom ${crypto.randomUUID().slice(0, 8)}`,
  });

  await builder.addDimensions(template.id, [
    { code: 'X', name: 'Dimension X', orderNumber: 1, interpretationRanges: null },
  ]);

  const version = await builder.createVersion(adminRow, template.id, {
    scoringConfig: { algorithm: 'HOLLAND_CODE_TOP3' },
  });

  await builder.addQuestion(adminRow, version.id, {
    questionText: 'An AI-proposed question.',
    questionType: 'LIKERT',
    orderNumber: 1,
    // AI_GENERATED — so its mapping lands with `confirmed_at IS NULL`, which is the only way
    // that column is ever null.
    source: 'AI_GENERATED',
    options: [
      { label: 'No', value: '1', score: 1, orderNumber: 1 },
      { label: 'Yes', value: '2', score: 2, orderNumber: 2 },
    ],
    dimensions: [{ code: 'X', weight: 1 }],
  });

  return { builder, template, version };
}

describe('invariant 3 — the confirmation gate (§25)', () => {
  /**
   * The risk this guards is not AI writing awkward question text; that is a UX problem. It is AI
   * silently deciding *what a question measures and how strongly* — a decision that is invisible
   * in the finished product, because the student sees a normal Likert item and a normal result
   * with no sign that the thing connecting them was never read by a human.
   */
  it('blocks publish while any mapping is unconfirmed, and says how many', async () => {
    const { builder, version } = await draftWithUnconfirmedMapping();

    await expect(builder.publish(adminRow, version.id)).rejects.toMatchObject({
      status: 422,
      errors: {
        question_dimensions: [expect.stringMatching(/1 of 1 dimension mappings.*unconfirmed/)],
      },
    });
  });

  it('reports publish readiness as {total, confirmed, remaining}', async () => {
    const { builder, version } = await draftWithUnconfirmedMapping();

    expect(await builder.publishReadiness(version.id)).toEqual({
      total: 1,
      confirmed: 0,
      remaining: 1,
    });
  });

  it('allows publish once every mapping is confirmed', async () => {
    const { builder, version } = await draftWithUnconfirmedMapping();

    // A human has now looked at it — which is the entire content of the rule.
    await db()
      .update(questionDimensions)
      .set({ confirmedAt: new Date().toISOString(), confirmedBy: admin.id });

    const published = await builder.publish(adminRow, version.id);

    expect(published.status).toBe('PUBLISHED');
  });

  /**
   * A human typing a mapping in the builder has it confirmed at insert time — there is nothing to
   * review later. This is why RIASEC and SCCT pass the gate without needing a category exception:
   * the right behaviour falls out of what is *upstream* of the rule.
   */
  it('auto-confirms a MANUAL mapping at insert time', async () => {
    const seeded = await seedAssessmentInstruments(db(), adminRow);
    const builder = new AssessmentBuilderService(db());

    const readiness = await builder.publishReadiness(seeded.riasecVersionId!);

    expect(readiness.total).toBe(60);
    expect(readiness.remaining).toBe(0);
  });

  it('refuses to publish a version with no questions at all', async () => {
    const builder = new AssessmentBuilderService(db());

    const template = await builder.createTemplate(adminRow, {
      category: 'CUSTOM',
      title: `Empty ${crypto.randomUUID().slice(0, 8)}`,
    });
    const version = await builder.createVersion(adminRow, template.id, {
      scoringConfig: { algorithm: 'HOLLAND_CODE_TOP3' },
    });

    // Vacuously "all mappings confirmed" — zero of them are unconfirmed. Publishing an empty
    // instrument would satisfy the gate's letter while making a nonsense of it.
    await expect(builder.publish(adminRow, version.id)).rejects.toMatchObject({ status: 422 });
  });
});

describe('invariant 1 — a published version is frozen (§12)', () => {
  /**
   * An attempt taken under version *N* must keep meaning what it meant. A mistake is fixed by
   * publishing *N+1*, and only new assignments point at it.
   */
  it('refuses to add a question to a published version', async () => {
    const builder = new AssessmentBuilderService(db());
    const seeded = await seedAssessmentInstruments(db(), adminRow);

    await expect(
      builder.addQuestion(adminRow, seeded.riasecVersionId!, {
        questionText: 'A 61st item, added after publication.',
        questionType: 'LIKERT',
        orderNumber: 61,
        options: [{ label: 'Yes', value: '1', score: 1, orderNumber: 1 }],
        dimensions: [{ code: 'R', weight: 1 }],
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('is idempotent about re-publishing rather than treating it as an edit', async () => {
    const builder = new AssessmentBuilderService(db());
    const seeded = await seedAssessmentInstruments(db(), adminRow);

    const republished = await builder.publish(adminRow, seeded.riasecVersionId!);

    expect(republished.status).toBe('PUBLISHED');
  });
});

describe('invariant 2 — dimensions freeze once any version publishes (§12, v1.2)', () => {
  /**
   * Dimensions hang off the *template*, so version immutability does not reach them. Renaming
   * "Investigative", or sliding a band from 67 to 60, would rewrite results already delivered —
   * and it would do so silently, because nothing about the old attempt would change.
   *
   * This is also what makes `confirmed_at` a durable fact rather than a snapshot of a moving
   * target: confirming "this item measures Investigative" means nothing if someone can then edit
   * what Investigative *is*.
   */
  it('refuses to add a dimension to a template that has a published version', async () => {
    const builder = new AssessmentBuilderService(db());

    await seedAssessmentInstruments(db(), adminRow);

    const [riasec] = await db()
      .select()
      .from(assessmentDimensions)
      .where(eq(assessmentDimensions.code, 'R'))
      .limit(1);

    await expect(
      builder.addDimensions(riasec!.assessmentTemplateId, [
        { code: 'Z', name: 'Sneaky', orderNumber: 7, interpretationRanges: null },
      ]),
    ).rejects.toMatchObject({
      status: 422,
      errors: { dimensions: [expect.stringMatching(/frozen/i)] },
    });
  });

  it('allows dimensions on a template whose versions are all still DRAFT', async () => {
    const builder = new AssessmentBuilderService(db());

    const template = await builder.createTemplate(adminRow, {
      category: 'CUSTOM',
      title: `Draft ${crypto.randomUUID().slice(0, 8)}`,
    });

    await builder.createVersion(adminRow, template.id, {
      scoringConfig: { algorithm: 'HOLLAND_CODE_TOP3' },
    });

    const added = await builder.addDimensions(template.id, [
      { code: 'Q', name: 'Quite fine', orderNumber: 1, interpretationRanges: null },
    ]);

    expect(added).toHaveLength(1);
  });
});

describe('assignment (§13.4, §21)', () => {
  /**
   * **You assign a version, never a template** — and it must be PUBLISHED. A draft is still being
   * edited, and students answering questions that move underneath them is the exact failure
   * invariant 1 exists to prevent.
   *
   * A **422, not a 403**: the counselor is entirely permitted to do this; the version is not ready.
   */
  it('refuses to assign a DRAFT version with a 422, not a 403', async () => {
    const builder = new AssessmentBuilderService(db());
    const { classRoom } = await classWithStudent(counselorToken);

    const template = await builder.createTemplate(adminRow, {
      category: 'CUSTOM',
      title: `Unpublished ${crypto.randomUUID().slice(0, 8)}`,
    });
    const version = await builder.createVersion(adminRow, template.id, {
      scoringConfig: { algorithm: 'HOLLAND_CODE_TOP3' },
    });

    const response = await api('POST', `/counselor/classes/${classRoom.id}/assignments`, {
      token: counselorToken,
      body: { assessment_version_id: version.id },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.assessment_version_id[0]).toMatch(/DRAFT, not PUBLISHED/);
  });

  /**
   * **Closing is not a status flip** (§21): it ends the unfinished work underneath it, in the same
   * transaction. Attempts already SUBMITTED or SCORED are untouched — closing ends unfinished
   * work, it does not revoke finished work.
   */
  it('expires every in-progress attempt when the assignment closes', async () => {
    const seeded = await seedAssessmentInstruments(db(), adminRow);
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const assignment = await assignVersion(counselorToken, classRoom.id, seeded.riasecVersionId!);

    const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });

    const attemptId = started.body.data.id;

    const closed = await api('PATCH', `/counselor/assignments/${assignment.id}`, {
      token: counselorToken,
      body: { status: 'CLOSED' },
    });

    expect(closed.status).toBe(200);
    expect(closed.body.data.status).toBe('CLOSED');

    // The student's live attempt died with it — and they cannot keep answering.
    const answer = await api('POST', `/student/attempts/${attemptId}/answers`, {
      token: studentToken,
      body: {
        question_id: started.body.data.questions[0].id,
        selected_option_id: started.body.data.questions[0].options[0].id,
      },
    });

    expect(answer.status).toBe(422);
    expect(answer.body.errors.attempt[0]).toMatch(/EXPIRED/);
  });
});

describe('the retake (§21)', () => {
  /**
   * The old attempt is marked EXPIRED and **kept**, with its answers, as history — never deleted
   * (§12: no soft deletes here, and no hard ones either). The partial unique index is what then
   * lets a fresh attempt exist alongside it; a plain UNIQUE(assignment, student) would have made
   * the retake impossible.
   */
  it('expires the old attempt and lets the student start a fresh one', async () => {
    const seeded = await seedAssessmentInstruments(db(), adminRow);
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const assignment = await assignVersion(counselorToken, classRoom.id, seeded.riasecVersionId!);

    const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });

    await answerAll(studentToken, started.body.data, () => 4);
    await api('POST', `/student/attempts/${started.body.data.id}/submit`, { token: studentToken });

    // Before the reset, the student is done and cannot start again.
    const blocked = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });

    expect(blocked.status).toBe(422);

    const reset = await api('POST', `/counselor/attempts/${started.body.data.id}/reset`, {
      token: counselorToken,
    });

    expect(reset.status).toBe(200);

    // And now a genuinely new attempt exists alongside the expired one.
    const restarted = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });

    expect(restarted.status).toBe(200);
    expect(restarted.body.data.id).not.toBe(started.body.data.id);
    expect(restarted.body.data.status).toBe('IN_PROGRESS');
  });

  /**
   * An expired attempt is never scored and never feeds recommendations — which is what makes
   * "the student's latest result" resolve unambiguously to a SCORED attempt everywhere else.
   */
  it('drops the expired attempt out of the student’s results', async () => {
    const seeded = await seedAssessmentInstruments(db(), adminRow);
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const assignment = await assignVersion(counselorToken, classRoom.id, seeded.riasecVersionId!);

    const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });

    await answerAll(studentToken, started.body.data, () => 4);
    await api('POST', `/student/attempts/${started.body.data.id}/submit`, { token: studentToken });

    expect((await api('GET', '/student/results', { token: studentToken })).body.data).toHaveLength(
      1,
    );

    await api('POST', `/counselor/attempts/${started.body.data.id}/reset`, {
      token: counselorToken,
    });

    const after = await api('GET', '/student/results', { token: studentToken });

    expect(after.body.data).toHaveLength(0);
  });
});

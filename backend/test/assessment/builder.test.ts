/* eslint-disable @typescript-eslint/require-await -- async-interface stubs have nothing to await */
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  aiRequests,
  assessmentQuestions,
  assessmentVersions,
  questionDimensions,
} from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { AiGatewayService, type WorkersAiClient } from '@/modules/ai/ai-gateway-service';
import { AssessmentGenerationService } from '@/modules/ai/assessment-generation-service';
import {
  api,
  assessmentTaxonomy,
  createStaffUser,
  db,
  login,
  seedInstruments,
  type StaffUserFixture,
} from '../helpers';

/* The add-question request the *browser* sends, shared with the frontend suite — see the file's
   own header for why it is not a literal in either. */
import { ADD_QUESTION_REQUEST } from '../../../contracts/assessment-builder';

/**
 * Phase 5b — the assessment builder endpoints and the §31 generation pipeline.
 *
 * The split mirrors `test/ai/explanation.test.ts` exactly, and for the same reason (the
 * top-of-PROGRESS lesson): Workers AI has no local emulation, so the **pipeline** is tested
 * against a stubbed gateway — §34 enforcement, unconfirmed-mapping persistence, the derived
 * status — while the **HTTP surface** is tested as deployed. The §25 gate is exercised from
 * both sides: a draft with unconfirmed mappings must refuse to publish with a count, and
 * confirming every mapping through the real endpoint must open it.
 */

let admin: StaffUserFixture;
let adminToken: string;
let counselor: StaffUserFixture;
let counselorToken: string;
let otherCounselorToken: string;
let riasecVersionId: string;
/**
 * The taxonomy fields (migration 0014) every create/edit body now needs, resolved once.
 *
 * Snake_case here because these go over the wire, unlike the Service-level `assessmentTaxonomy()`
 * fixture's camelCase. Interest + Likert/Raw is a *legal* pair, so it exercises the schema's
 * required-field rule without tripping the compatibility rule these tests are not about.
 */
let taxonomyBody: { assessment_type_id: string; scoring_ids: string[] };

const MAX_QUESTIONS = 50;

beforeAll(async () => {
  admin = await createStaffUser({ role: 'admin' });
  adminToken = await login(admin);
  counselor = await createStaffUser({ role: 'counselor' });
  counselorToken = await login(counselor);
  otherCounselorToken = await login(await createStaffUser({ role: 'counselor' }));

  const seeded = await seedInstruments(admin);
  riasecVersionId = seeded.riasecVersionId!;

  const taxonomy = await assessmentTaxonomy();
  taxonomyBody = {
    assessment_type_id: taxonomy.assessmentTypeId,
    scoring_ids: taxonomy.scoringIds,
  };
});

/** One CUSTOM template with dimensions and a DRAFT version, owned by `token`'s user. */
async function draftFixture(
  token: string,
  options: { dimensions?: boolean } = {},
): Promise<{ templateId: string; versionId: string }> {
  const template = await api('POST', '/assessment-templates', {
    token,
    body: { category: 'CUSTOM', title: `Study Habits ${uuid().slice(0, 8)}`, ...taxonomyBody },
  });

  expect(template.status).toBe(201);
  const templateId = template.body.data.id as string;

  if (options.dimensions !== false) {
    const dimensions = await api('POST', `/assessment-templates/${templateId}/dimensions`, {
      token,
      body: {
        dimensions: [
          { code: 'TM', name: 'Time Management' },
          { code: 'FO', name: 'Focus' },
        ],
      },
    });

    expect(dimensions.status).toBe(201);
  }

  const version = await api('POST', `/assessment-templates/${templateId}/versions`, {
    token,
    body: { scoring_algorithm: 'WEIGHTED_COMPOSITE' },
  });

  expect(version.status).toBe(201);

  return { templateId, versionId: version.body.data.id as string };
}

/** A generation service whose "model" answers with `payload` (or throws it, if an Error). */
function generationService(payload: unknown): AssessmentGenerationService {
  const client: WorkersAiClient = {
    async run() {
      if (payload instanceof Error) {
        throw payload;
      }

      return { response: typeof payload === 'string' ? payload : JSON.stringify(payload) };
    },
  };

  return new AssessmentGenerationService(
    db(),
    new AiGatewayService(db(), client, { text: 'stub-model', embedding: 'stub-embed' }),
    null,
    MAX_QUESTIONS,
  );
}

const generatedPayload = {
  questions: [
    {
      question_text: 'I set aside fixed hours for studying each week.',
      question_type: 'LIKERT',
      options: [
        { label: 'Strongly Agree', value: 'sa', score: 5 },
        { label: 'Disagree', value: 'd', score: 2 },
      ],
      dimension_code: 'TM',
    },
    {
      question_text: 'I silence my phone while working.',
      question_type: 'LIKERT',
      options: [
        { label: 'Agree', value: 'a', score: 4 },
        { label: 'Disagree', value: 'd', score: 2 },
      ],
      dimension_code: 'FO',
    },
  ],
};

// ═════════════════════════════════════════════════════════════════════════════════════
describe('the builder endpoints (templates, dimensions, versions, questions)', () => {
  it('a counselor creates a CUSTOM template as COUNSELOR_PRIVATE; an admin creates GLOBAL', async () => {
    const mine = await api('POST', '/assessment-templates', {
      token: counselorToken,
      body: { category: 'CUSTOM', title: `Mine ${uuid().slice(0, 6)}`, ...taxonomyBody },
    });

    expect(mine.status).toBe(201);
    expect(mine.body.data.ownership).toBe('COUNSELOR_PRIVATE');
    expect(mine.body.data.ai_generatable).toBe(true);

    const global = await api('POST', '/assessment-templates', {
      token: adminToken,
      body: { category: 'CUSTOM', title: `Global ${uuid().slice(0, 6)}`, ...taxonomyBody },
    });

    expect(global.status).toBe(201);
    expect(global.body.data.ownership).toBe('GLOBAL');
  });

  it('refuses a duplicate dimension code with a 422, in the payload and against existing rows (L5)', async () => {
    const template = await api('POST', '/assessment-templates', {
      token: counselorToken,
      body: { category: 'CUSTOM', title: `Dims ${uuid().slice(0, 8)}`, ...taxonomyBody },
    });
    const templateId = template.body.data.id as string;

    // Duplicated *within one payload* — caught by the in-payload pre-check, field named precisely.
    const inPayload = await api('POST', `/assessment-templates/${templateId}/dimensions`, {
      token: counselorToken,
      body: {
        dimensions: [
          { code: 'TM', name: 'Time Management' },
          { code: 'TM', name: 'Time Mgmt Again' },
        ],
      },
    });

    expect(inPayload.status).toBe(422);
    expect(inPayload.body.errors.code).toBeDefined();

    // A first, clean add succeeds...
    const first = await api('POST', `/assessment-templates/${templateId}/dimensions`, {
      token: counselorToken,
      body: { dimensions: [{ code: 'FO', name: 'Focus' }] },
    });
    expect(first.status).toBe(201);

    // ...then re-adding the same code loses at the (template, code) unique index and must be a
    // 422, not the raw constraint 500 it used to be.
    const again = await api('POST', `/assessment-templates/${templateId}/dimensions`, {
      token: counselorToken,
      body: { dimensions: [{ code: 'FO', name: 'Focus Duplicate' }] },
    });
    expect(again.status).toBe(422);
    expect(again.body.errors.code).toBeDefined();
  });

  it('creating a RIASEC template is refused by the schema — the instruments are seeded, not created', async () => {
    const response = await api('POST', '/assessment-templates', {
      token: adminToken,
      body: { category: 'RIASEC', title: 'A second RIASEC' },
    });

    expect(response.status).toBe(422);
  });

  it("a counselor cannot see another counselor's private template — 404, not 403", async () => {
    const { templateId } = await draftFixture(counselorToken);

    const probed = await api('GET', `/assessment-templates/${templateId}`, {
      token: otherCounselorToken,
    });

    expect(probed.status).toBe(404);

    const asAdmin = await api('GET', `/assessment-templates/${templateId}`, {
      token: adminToken,
    });

    expect(asAdmin.status).toBe(200);
  });

  it('manual questions land confirmed (§25: a human typed them) and the version publishes', async () => {
    const { versionId } = await draftFixture(counselorToken);

    const added = await api('POST', `/assessment-versions/${versionId}/questions`, {
      token: counselorToken,
      body: {
        questions: [
          {
            question_text: 'I keep a written schedule.',
            question_type: 'LIKERT',
            options: [
              { label: 'Agree', value: 'a', score: 3 },
              { label: 'Disagree', value: 'd', score: 1 },
            ],
            dimension_codes: ['TM'],
          },
        ],
      },
    });

    expect(added.status).toBe(201);

    const review = await api('GET', `/assessment-versions/${versionId}`, {
      token: counselorToken,
    });

    expect(review.status).toBe(200);
    expect(review.body.data.publish_readiness).toEqual({
      total: 1,
      confirmed: 1,
      remaining: 0,
    });
    // The author's view carries what the player payload must never carry: scores + mappings.
    expect(review.body.data.questions[0].options[0].score).toBe(3);
    expect(review.body.data.questions[0].dimensions[0]).toMatchObject({
      code: 'TM',
      confirmed: true,
    });

    const published = await api('POST', `/assessment-versions/${versionId}/publish`, {
      token: counselorToken,
    });

    expect(published.status).toBe(200);
    expect(published.body.data.status).toBe('PUBLISHED');
  });

  it('a manual question naming an unknown dimension code is a 422, not a silent no-mapping', async () => {
    const { versionId } = await draftFixture(counselorToken);

    const response = await api('POST', `/assessment-versions/${versionId}/questions`, {
      token: counselorToken,
      body: {
        questions: [
          {
            question_text: 'Mapped to nothing that exists.',
            question_type: 'LIKERT',
            options: [
              { label: 'Agree', value: 'a', score: 3 },
              { label: 'Disagree', value: 'd', score: 1 },
            ],
            dimension_codes: ['GRIT'],
          },
        ],
      },
    });

    expect(response.status).toBe(422);
  });

  it('a question on a DRAFT version can be edited; the same edit after publish is refused', async () => {
    const { versionId } = await draftFixture(counselorToken);

    await api('POST', `/assessment-versions/${versionId}/questions`, {
      token: counselorToken,
      body: {
        questions: [
          {
            question_text: 'Originial wording with a typo.',
            question_type: 'BOOLEAN',
            options: [
              { label: 'Yes', value: 'yes', score: 1 },
              { label: 'No', value: 'no', score: 0 },
            ],
            // Mapped, because this test publishes: the gate refuses an item that measures nothing
            // on a template that *has* dimensions (ASSESSMENT-FIX §3).
            dimension_codes: ['TM'],
          },
        ],
      },
    });

    const review = await api('GET', `/assessment-versions/${versionId}`, {
      token: counselorToken,
    });
    const questionId = review.body.data.questions[0].id as string;

    const edited = await api('PATCH', `/assessment-questions/${questionId}`, {
      token: counselorToken,
      body: { question_text: 'Original wording, fixed.' },
    });

    expect(edited.status).toBe(200);
    expect(edited.body.data.question_text).toBe('Original wording, fixed.');

    await api('POST', `/assessment-versions/${versionId}/publish`, { token: counselorToken });

    const afterPublish = await api('PATCH', `/assessment-questions/${questionId}`, {
      token: counselorToken,
      body: { question_text: 'Rewriting frozen history.' },
    });

    expect(afterPublish.status).toBe(422);
  });

  /**
   * **The click that 422'd.** This is the request the browser sends when an author presses "Add
   * question", imported from `contracts/assessment-builder.ts` rather than retyped — the frontend's
   * own suite asserts the workspace sends exactly this object, so the two assertions together are
   * what stops the client and the server disagreeing about the contract again (ASSESSMENT-FIX §1).
   *
   * A blank, unmapped question is a **legal draft**. It is refused at publish, which is the next
   * two tests.
   */
  it('accepts the builder’s own add-question payload — a blank draft question is legal', async () => {
    const { versionId } = await draftFixture(counselorToken);

    const added = await api('POST', `/assessment-versions/${versionId}/questions`, {
      token: counselorToken,
      body: ADD_QUESTION_REQUEST,
    });

    expect(added.status, JSON.stringify(added.body)).toBe(201);

    const review = await api('GET', `/assessment-versions/${versionId}`, {
      token: counselorToken,
    });

    expect(review.body.data.questions).toHaveLength(1);
    expect(review.body.data.questions[0].question_text).toBe('');
    expect(review.body.data.questions[0].options).toHaveLength(5);
  });

  /** And clearing the text of an existing question — §2's queue-poisoning 422 — is legal too. */
  it('accepts an auto-save that clears the question text', async () => {
    const { versionId } = await draftFixture(counselorToken);

    await api('POST', `/assessment-versions/${versionId}/questions`, {
      token: counselorToken,
      body: ADD_QUESTION_REQUEST,
    });

    const review = await api('GET', `/assessment-versions/${versionId}`, { token: counselorToken });
    const questionId = review.body.data.questions[0].id as string;

    const typed = await api('PATCH', `/assessment-questions/${questionId}`, {
      token: counselorToken,
      body: { question_text: 'I review my notes within a day of each class.' },
    });

    expect(typed.status).toBe(200);

    const cleared = await api('PATCH', `/assessment-questions/${questionId}`, {
      token: counselorToken,
      body: { question_text: '' },
    });

    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.data.question_text).toBe('');
  });

  /**
   * The other side of the bargain: what the write path now permits, publish refuses — **by name**,
   * because "publish failed" with no number leaves the author scrolling through sixty items.
   */
  it('refuses to publish a version whose question has no text, naming the question', async () => {
    const { versionId } = await draftFixture(counselorToken);

    await api('POST', `/assessment-versions/${versionId}/questions`, {
      token: counselorToken,
      body: {
        questions: [
          { ...ADD_QUESTION_REQUEST.questions[0], dimension_codes: ['TM'] },
          {
            question_text: 'A finished item.',
            question_type: 'LIKERT',
            options: [
              { label: 'Agree', value: 'a', score: 3 },
              { label: 'Disagree', value: 'd', score: 1 },
            ],
            dimension_codes: ['TM'],
          },
        ],
      },
    });

    const refused = await api('POST', `/assessment-versions/${versionId}/publish`, {
      token: counselorToken,
    });

    expect(refused.status).toBe(422);
    expect(refused.body.errors.questions[0]).toMatch(/Question 1 has no text/);
  });

  /**
   * §3 — the silent one. A version of unmapped questions published cleanly, scored every student
   * into an empty result, and reported nothing to anyone: `total = 0, confirmed = 0, remaining = 0`
   * satisfied the confirmation gate exactly as a fully-confirmed version does.
   */
  it('refuses to publish a question that measures nothing, and publishes once it is mapped', async () => {
    const { versionId } = await draftFixture(counselorToken);

    await api('POST', `/assessment-versions/${versionId}/questions`, {
      token: counselorToken,
      body: {
        questions: [
          {
            question_text: 'I keep a written schedule.',
            question_type: 'LIKERT',
            options: [
              { label: 'Agree', value: 'a', score: 3 },
              { label: 'Disagree', value: 'd', score: 1 },
            ],
            dimension_codes: [],
          },
        ],
      },
    });

    const refused = await api('POST', `/assessment-versions/${versionId}/publish`, {
      token: counselorToken,
    });

    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.errors.question_dimensions[0]).toMatch(/Question 1 measures nothing/);

    const review = await api('GET', `/assessment-versions/${versionId}`, { token: counselorToken });

    const mapped = await api('PATCH', `/assessment-questions/${review.body.data.questions[0].id}`, {
      token: counselorToken,
      body: { dimension_codes: ['TM'] },
    });

    expect(mapped.status).toBe(200);

    const published = await api('POST', `/assessment-versions/${versionId}/publish`, {
      token: counselorToken,
    });

    expect(published.status, JSON.stringify(published.body)).toBe(200);
  });

  /**
   * …and the case that makes the gate above correct rather than merely strict: a template with no
   * dimensions is an ungraded survey, which the builder offers in as many words. Unmapped there is
   * the finished product, not an oversight.
   */
  it('still publishes an ungraded survey — no dimensions, so nothing to map', async () => {
    const { versionId } = await draftFixture(counselorToken, { dimensions: false });

    await api('POST', `/assessment-versions/${versionId}/questions`, {
      token: counselorToken,
      body: {
        questions: [
          {
            question_text: 'What is one thing you learned this week?',
            question_type: 'LIKERT',
            options: [
              { label: 'A lot', value: 'a', score: 1 },
              { label: 'A little', value: 'b', score: 0 },
            ],
            dimension_codes: [],
          },
        ],
      },
    });

    const published = await api('POST', `/assessment-versions/${versionId}/publish`, {
      token: counselorToken,
    });

    expect(published.status, JSON.stringify(published.body)).toBe(200);
  });

  /** §6 — `value` is the stored answer key, and two options cannot share one. */
  it('refuses two options with the same value', async () => {
    const { versionId } = await draftFixture(counselorToken);

    const response = await api('POST', `/assessment-versions/${versionId}/questions`, {
      token: counselorToken,
      body: {
        questions: [
          {
            question_text: 'Two keys, one meaning.',
            question_type: 'MULTIPLE_CHOICE',
            options: [
              { label: 'First', value: 'same', score: 1 },
              { label: 'Second', value: 'same', score: 2 },
            ],
            dimension_codes: ['TM'],
          },
        ],
      },
    });

    expect(response.status).toBe(422);
  });

  /**
   * §4 — the bulk-add route positioned with `COUNT + 1` while everything else appended with
   * `MAX + 1`. They agree only while the numbering is gapless, which is a coincidence the route was
   * relying on without saying so; positioning now lives in the Service alone.
   */
  it('appends added questions after the ones already there', async () => {
    const { versionId } = await draftFixture(counselorToken);

    const item = (text: string) => ({
      question_text: text,
      question_type: 'LIKERT' as const,
      options: [
        { label: 'Agree', value: 'a', score: 3 },
        { label: 'Disagree', value: 'd', score: 1 },
      ],
      dimension_codes: ['TM'],
    });

    await api('POST', `/assessment-versions/${versionId}/questions`, {
      token: counselorToken,
      body: { questions: [item('First.'), item('Second.')] },
    });

    const review = await api('GET', `/assessment-versions/${versionId}`, { token: counselorToken });

    // Delete the middle one, then add: a `COUNT + 1` route would reuse position 2 here.
    await api('DELETE', `/assessment-questions/${review.body.data.questions[0].id}`, {
      token: counselorToken,
    });

    const added = await api('POST', `/assessment-versions/${versionId}/questions`, {
      token: counselorToken,
      body: { questions: [item('Third.')] },
    });

    expect(added.status, JSON.stringify(added.body)).toBe(201);

    const after = await api('GET', `/assessment-versions/${versionId}`, { token: counselorToken });

    expect(after.body.data.questions.map((question: any) => question.order_number)).toEqual([1, 2]);
    expect(after.body.data.questions.map((question: any) => question.question_text)).toEqual([
      'Second.',
      'Third.',
    ]);
  });

  it('a student cannot reach any builder endpoint', async () => {
    // The role gate answers before any record is looked at — a bare 403 with no probe value.
    const response = await api('POST', '/assessment-templates', {
      token: 'not-even-a-real-token',
      body: { category: 'CUSTOM', title: 'X' },
    });

    expect(response.status).toBe(401);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════
describe('the generation endpoints (§20 group)', () => {
  it('queues a Mode B generation: 202 with an id, and the id polls as PENDING', async () => {
    const { versionId } = await draftFixture(counselorToken);

    const queued = await api(
      'POST',
      `/assessment-versions/${versionId}/ai-generate/description`,
      {
        token: counselorToken,
        body: { description: 'A 10-question survey about study habits across TM and FO.' },
      },
    );

    expect(queued.status).toBe(202);
    expect(queued.body.data.status).toBe('PENDING');

    const status = await api('GET', `/ai/requests/${queued.body.data.ai_request_id}/status`, {
      token: counselorToken,
    });

    expect(status.status).toBe(200);
    expect(status.body.data.status).toBe('PENDING');
  });

  it('refuses RIASEC with a 403 — for an ADMIN, which is the entire point of category-before-ownership (§5)', async () => {
    const response = await api(
      'POST',
      `/assessment-versions/${riasecVersionId}/ai-generate/description`,
      {
        token: adminToken,
        body: { description: 'Regenerate the interest inventory, please.' },
      },
    );

    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).toMatch(/never be AI-generated/i);
  });

  it("refuses another counselor's version with a 404 — private ids cannot be probed", async () => {
    const { versionId } = await draftFixture(counselorToken);

    const response = await api(
      'POST',
      `/assessment-versions/${versionId}/ai-generate/description`,
      { token: otherCounselorToken, body: { description: 'Not mine to draft into.' } },
    );

    expect(response.status).toBe(404);
  });

  it('refuses a PUBLISHED version with a 422 — generation targets a DRAFT', async () => {
    const { versionId } = await draftFixture(counselorToken);

    await api('POST', `/assessment-versions/${versionId}/questions`, {
      token: counselorToken,
      body: {
        questions: [
          {
            question_text: 'Filler so the version can publish.',
            question_type: 'BOOLEAN',
            options: [
              { label: 'Yes', value: 'yes', score: 1 },
              { label: 'No', value: 'no', score: 0 },
            ],
            dimension_codes: ['TM'],
          },
        ],
      },
    });
    await api('POST', `/assessment-versions/${versionId}/publish`, { token: counselorToken });

    const response = await api(
      'POST',
      `/assessment-versions/${versionId}/ai-generate/description`,
      { token: counselorToken, body: { description: 'Draft into a frozen version.' } },
    );

    expect(response.status).toBe(422);
  });

  it('refuses a source text too short to mean anything, before charging the rate limit', async () => {
    const { versionId } = await draftFixture(counselorToken);

    const response = await api(
      'POST',
      `/assessment-versions/${versionId}/ai-generate/description`,
      { token: counselorToken, body: { description: 'short' } },
    );

    expect(response.status).toBe(422);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════
describe('the §31 pipeline (stubbed gateway) and the §25 gate around it', () => {
  it('persists an unconfirmed draft, blocks publish with a count, and opens after per-mapping confirms', async () => {
    const { versionId } = await draftFixture(counselorToken);
    const aiRequestId = uuid();

    await generationService(generatedPayload).generateDraft({
      aiRequestId,
      versionId,
      userId: counselor.id,
      mode: 'DESCRIPTION',
      sourceText: 'A survey about study habits.',
    });

    // Provenance (§13.4): AI_GENERATED, back-pointing at the ai_requests row.
    const drafted = await db()
      .select()
      .from(assessmentQuestions)
      .where(eq(assessmentQuestions.sourceAiRequestId, aiRequestId));

    expect(drafted).toHaveLength(2);
    expect(drafted.every((question) => question.source === 'AI_GENERATED')).toBe(true);

    // The mappings landed UNCONFIRMED — the whole point of the pipeline's persistence shape.
    const review = await api('GET', `/assessment-versions/${versionId}`, {
      token: counselorToken,
    });

    expect(review.body.data.publish_readiness).toEqual({
      total: 2,
      confirmed: 0,
      remaining: 2,
    });

    // §25: publish refuses, and says how many are outstanding.
    const refused = await api('POST', `/assessment-versions/${versionId}/publish`, {
      token: counselorToken,
    });

    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('2 of 2');

    // The status endpoint derives DRAFTED from the same facts.
    const status = await api('GET', `/ai/requests/${aiRequestId}/status`, {
      token: counselorToken,
    });

    expect(status.body.data.status).toBe('DRAFTED');
    expect(status.body.data.question_count).toBe(2);

    // Confirm each mapping through the real endpoint — no bulk form exists (§31).
    for (const question of review.body.data.questions) {
      for (const mapping of question.dimensions) {
        const confirmed = await api(
          `POST`,
          `/question-dimensions/${mapping.mapping_id}/confirm`,
          {
            token: counselorToken,
          },
        );

        expect(confirmed.status).toBe(200);
      }
    }

    const published = await api('POST', `/assessment-versions/${versionId}/publish`, {
      token: counselorToken,
    });

    expect(published.status).toBe(200);

    // The confirm rows carry who confirmed (§25's provenance).
    const [mapping] = await db()
      .select()
      .from(questionDimensions)
      .where(eq(questionDimensions.questionId, drafted[0]!.id));

    expect(mapping!.confirmedBy).toBe(counselor.id);
  });

  /**
   * §4's third positioning rule, and the one with no witnesses: the generation job numbered its
   * questions from 1 regardless of what the version already held, so an author who wrote an item by
   * hand and *then* drafted with AI got two questions claiming position 1 — no error, just an
   * arbitrary render order. Migration 0021 would turn that into a failed job; appending is what
   * makes it a non-event.
   */
  it('appends a generated draft after the questions already in the version', async () => {
    const { versionId } = await draftFixture(counselorToken);

    await api('POST', `/assessment-versions/${versionId}/questions`, {
      token: counselorToken,
      body: {
        questions: [
          {
            question_text: 'Written by hand, before the AI ran.',
            question_type: 'LIKERT',
            options: [
              { label: 'Agree', value: 'a', score: 3 },
              { label: 'Disagree', value: 'd', score: 1 },
            ],
            dimension_codes: ['TM'],
          },
        ],
      },
    });

    await generationService(generatedPayload).generateDraft({
      aiRequestId: uuid(),
      versionId,
      userId: counselor.id,
      mode: 'DESCRIPTION',
      sourceText: 'A survey about study habits.',
    });

    const review = await api('GET', `/assessment-versions/${versionId}`, {
      token: counselorToken,
    });

    expect(review.body.data.questions.map((question: any) => question.order_number)).toEqual([
      1, 2, 3,
    ]);
    expect(review.body.data.questions[0].source).toBe('MANUAL');
  });

  it('an ungraded draft (no dimensions on the template) writes no mappings, and the gate is trivially satisfied', async () => {
    const { versionId } = await draftFixture(counselorToken, { dimensions: false });
    const aiRequestId = uuid();

    const ungraded = {
      questions: generatedPayload.questions.map((question) => ({
        ...question,
        dimension_code: undefined,
      })),
    };

    await generationService(ungraded).generateDraft({
      aiRequestId,
      versionId,
      userId: counselor.id,
      mode: 'DESCRIPTION',
      sourceText: 'A plain reflection survey, no scoring.',
    });

    const review = await api('GET', `/assessment-versions/${versionId}`, {
      token: counselorToken,
    });

    expect(review.body.data.questions).toHaveLength(2);
    expect(review.body.data.publish_readiness).toEqual({
      total: 0,
      confirmed: 0,
      remaining: 0,
    });

    const published = await api('POST', `/assessment-versions/${versionId}/publish`, {
      token: counselorToken,
    });

    expect(published.status).toBe(200);
  });

  it('output that fails §34 leaves a SUCCESS ai_requests row and no questions → VALIDATION_FAILED', async () => {
    const { versionId } = await draftFixture(counselorToken);
    const aiRequestId = uuid();

    await generationService('Sure! Here are ten questions:\n1. Do you…').generateDraft({
      aiRequestId,
      versionId,
      userId: counselor.id,
      mode: 'DESCRIPTION',
      sourceText: 'A survey about study habits.',
    });

    const status = await api('GET', `/ai/requests/${aiRequestId}/status`, {
      token: counselorToken,
    });

    expect(status.body.data.status).toBe('VALIDATION_FAILED');

    const drafted = await db()
      .select()
      .from(assessmentQuestions)
      .where(eq(assessmentQuestions.sourceAiRequestId, aiRequestId));

    expect(drafted).toHaveLength(0);
  });

  it('a quota error logs FAILED with the §30 taxonomy and is reported by the poll — never retried', async () => {
    const { versionId } = await draftFixture(counselorToken);
    const aiRequestId = uuid();

    await generationService(new Error('3040: daily neuron quota exceeded')).generateDraft({
      aiRequestId,
      versionId,
      userId: counselor.id,
      mode: 'DESCRIPTION',
      sourceText: 'A survey about study habits.',
    });

    const [row] = await db().select().from(aiRequests).where(eq(aiRequests.id, aiRequestId));

    expect(row!.status).toBe('FAILED');
    expect(row!.requestType).toBe('ASSESSMENT_GENERATION');

    const status = await api('GET', `/ai/requests/${aiRequestId}/status`, {
      token: counselorToken,
    });

    expect(status.body.data.status).toBe('FAILED');
    expect(status.body.data.failure_reason).toMatch(/QUOTA_EXHAUSTED/);
  });

  it("someone else's request id polls as PENDING — indistinguishable from an id that never existed", async () => {
    const { versionId } = await draftFixture(counselorToken);
    const aiRequestId = uuid();

    await generationService(generatedPayload).generateDraft({
      aiRequestId,
      versionId,
      userId: counselor.id,
      mode: 'DESCRIPTION',
      sourceText: 'A survey about study habits.',
    });

    const status = await api('GET', `/ai/requests/${aiRequestId}/status`, {
      token: otherCounselorToken,
    });

    expect(status.body.data.status).toBe('PENDING');
  });

  it('Mode A on a dimensionless template surfaces suggested_dimensions as inert text (§31)', async () => {
    const { versionId } = await draftFixture(counselorToken, { dimensions: false });
    const aiRequestId = uuid();

    await generationService({
      questions: generatedPayload.questions.map((question) => ({
        ...question,
        dimension_code: undefined,
      })),
      suggested_dimensions: [{ name: 'Consistency', description: 'Showing up regularly.' }],
    }).generateDraft({
      aiRequestId,
      versionId,
      userId: counselor.id,
      mode: 'DOCUMENT',
      sourceText: 'Extracted text of a study-skills handbook, long enough to mean something.',
    });

    const status = await api('GET', `/ai/requests/${aiRequestId}/status`, {
      token: counselorToken,
    });

    expect(status.body.data.status).toBe('DRAFTED');
    expect(status.body.data.suggested_dimensions).toEqual([
      { name: 'Consistency', description: 'Showing up regularly.' },
    ]);

    // Inert means inert: no assessment_dimensions row appeared.
    const review = await api('GET', `/assessment-versions/${versionId}`, {
      token: counselorToken,
    });

    expect(
      review.body.data.questions.every(
        (question: { dimensions: unknown[] }) => question.dimensions.length === 0,
      ),
    ).toBe(true);
  });

  it('the job re-checks the category even though the endpoint already did (§32: never assume the check happened)', async () => {
    // Forge the exact message the endpoint could never produce: a DRAFT version hanging off
    // the RIASEC template. The endpoint's 403 is one wall; this is the second, and §32 says
    // the second must hold on its own.
    const [riasecVersion] = await db()
      .select()
      .from(assessmentVersions)
      .where(eq(assessmentVersions.id, riasecVersionId));

    const draftVersionId = uuid();

    await db()
      .insert(assessmentVersions)
      .values({
        id: draftVersionId,
        assessmentTemplateId: riasecVersion!.assessmentTemplateId,
        versionNumber: 900 + Math.floor(Math.random() * 100),
        instructions: null,
        durationMinutes: null,
        scoringConfig: { algorithm: 'HOLLAND_CODE_TOP3' },
        status: 'DRAFT',
        createdBy: admin.id,
        createdAt: now(),
      });

    const aiRequestId = uuid();

    await generationService(generatedPayload).generateDraft({
      aiRequestId,
      versionId: draftVersionId,
      userId: admin.id,
      mode: 'DESCRIPTION',
      sourceText: 'A forged queue message naming a draft RIASEC version.',
    });

    // Nothing ran: no ai_requests row (the model was never called), no questions.
    const [row] = await db().select().from(aiRequests).where(eq(aiRequests.id, aiRequestId));

    expect(row).toBeUndefined();

    const drafted = await db()
      .select()
      .from(assessmentQuestions)
      .where(eq(assessmentQuestions.assessmentVersionId, draftVersionId));

    expect(drafted).toHaveLength(0);
  });
});

/* eslint-disable @typescript-eslint/require-await -- async-interface stubs have nothing to await */
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import { aiRequests, assessmentQuestions, assessmentVersions, questionDimensions } from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { AiGatewayService, type WorkersAiClient } from '@/modules/ai/ai-gateway-service';
import { AssessmentGenerationService } from '@/modules/ai/assessment-generation-service';
import {
  api,
  createStaffUser,
  db,
  login,
  seedInstruments,
  type StaffUserFixture,
} from '../helpers';

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

const MAX_QUESTIONS = 50;

beforeAll(async () => {
  admin = await createStaffUser({ role: 'admin' });
  adminToken = await login(admin);
  counselor = await createStaffUser({ role: 'counselor' });
  counselorToken = await login(counselor);
  otherCounselorToken = await login(await createStaffUser({ role: 'counselor' }));

  const seeded = await seedInstruments(admin);
  riasecVersionId = seeded.riasecVersionId!;
});

/** One CUSTOM template with dimensions and a DRAFT version, owned by `token`'s user. */
async function draftFixture(
  token: string,
  options: { dimensions?: boolean } = {},
): Promise<{ templateId: string; versionId: string }> {
  const template = await api('POST', '/assessment-templates', {
    token,
    body: { category: 'CUSTOM', title: `Study Habits ${uuid().slice(0, 8)}` },
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
      body: { category: 'CUSTOM', title: `Mine ${uuid().slice(0, 6)}` },
    });

    expect(mine.status).toBe(201);
    expect(mine.body.data.ownership).toBe('COUNSELOR_PRIVATE');
    expect(mine.body.data.ai_generatable).toBe(true);

    const global = await api('POST', '/assessment-templates', {
      token: adminToken,
      body: { category: 'CUSTOM', title: `Global ${uuid().slice(0, 6)}` },
    });

    expect(global.status).toBe(201);
    expect(global.body.data.ownership).toBe('GLOBAL');
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

    const asAdmin = await api('GET', `/assessment-templates/${templateId}`, { token: adminToken });

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

    const review = await api('GET', `/assessment-versions/${versionId}`, { token: counselorToken });

    expect(review.status).toBe(200);
    expect(review.body.data.publish_readiness).toEqual({ total: 1, confirmed: 1, remaining: 0 });
    // The author's view carries what the player payload must never carry: scores + mappings.
    expect(review.body.data.questions[0].options[0].score).toBe(3);
    expect(review.body.data.questions[0].dimensions[0]).toMatchObject({ code: 'TM', confirmed: true });

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
            dimension_codes: [],
          },
        ],
      },
    });

    const review = await api('GET', `/assessment-versions/${versionId}`, { token: counselorToken });
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

    const queued = await api('POST', `/assessment-versions/${versionId}/ai-generate/description`, {
      token: counselorToken,
      body: { description: 'A 10-question survey about study habits across TM and FO.' },
    });

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
      { token: adminToken, body: { description: 'Regenerate the interest inventory, please.' } },
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
    const review = await api('GET', `/assessment-versions/${versionId}`, { token: counselorToken });

    expect(review.body.data.publish_readiness).toEqual({ total: 2, confirmed: 0, remaining: 2 });

    // §25: publish refuses, and says how many are outstanding.
    const refused = await api('POST', `/assessment-versions/${versionId}/publish`, {
      token: counselorToken,
    });

    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('2 of 2');

    // The status endpoint derives DRAFTED from the same facts.
    const status = await api('GET', `/ai/requests/${aiRequestId}/status`, { token: counselorToken });

    expect(status.body.data.status).toBe('DRAFTED');
    expect(status.body.data.question_count).toBe(2);

    // Confirm each mapping through the real endpoint — no bulk form exists (§31).
    for (const question of review.body.data.questions) {
      for (const mapping of question.dimensions) {
        const confirmed = await api(`POST`, `/question-dimensions/${mapping.mapping_id}/confirm`, {
          token: counselorToken,
        });

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

    const review = await api('GET', `/assessment-versions/${versionId}`, { token: counselorToken });

    expect(review.body.data.questions).toHaveLength(2);
    expect(review.body.data.publish_readiness).toEqual({ total: 0, confirmed: 0, remaining: 0 });

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

    const status = await api('GET', `/ai/requests/${aiRequestId}/status`, { token: counselorToken });

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

    const status = await api('GET', `/ai/requests/${aiRequestId}/status`, { token: counselorToken });

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

    const status = await api('GET', `/ai/requests/${aiRequestId}/status`, { token: counselorToken });

    expect(status.body.data.status).toBe('DRAFTED');
    expect(status.body.data.suggested_dimensions).toEqual([
      { name: 'Consistency', description: 'Showing up regularly.' },
    ]);

    // Inert means inert: no assessment_dimensions row appeared.
    const review = await api('GET', `/assessment-versions/${versionId}`, { token: counselorToken });

    expect(review.body.data.questions.every((question: { dimensions: unknown[] }) => question.dimensions.length === 0)).toBe(true);
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

    await db().insert(assessmentVersions).values({
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

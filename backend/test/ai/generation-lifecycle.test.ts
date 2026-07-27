/* eslint-disable @typescript-eslint/require-await -- async-interface stubs have nothing to await */
import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import { aiRequests, assessmentQuestions } from '@/db/schema';
import worker, { type JobMessage } from '@/index';
import { markAiJobFailed } from '@/jobs/ai-jobs';
import { runNightlyCleanup } from '@/jobs/cleanup';
import { uuid } from '@/lib/crypto';
import { AiGatewayService, type WorkersAiClient } from '@/modules/ai/ai-gateway-service';
import {
  AssessmentGenerationService,
  GENERATION_DEADLINE_MS,
} from '@/modules/ai/assessment-generation-service';
import {
  api,
  assessmentTaxonomy,
  createStaffUser,
  db,
  login,
  type StaffUserFixture,
} from '../helpers';

/**
 * **The §31 generation lifecycle: PENDING → PROCESSING → SUCCESS | FAILED.**
 *
 * ── Why this file exists ──────────────────────────────────────────────────────────────────────
 *
 * The generation flow shipped with tests on both ends and nothing in between. `builder.test.ts`
 * proved the endpoint answers 202, and it proved `generateDraft` persists an unconfirmed draft
 * when you call it directly — but nothing ever asserted that the **queue message in the middle
 * actually reaches the handler**, or that a request which never gets that far still reaches a
 * terminal state. That gap is exactly the shape of the bug it hid: in a `wrangler dev` profile
 * with a producer and no consumer, every one of those tests passed while the feature was
 * completely inert in the browser, polling PENDING until the tab closed.
 *
 * So the assertions here are deliberately about the *seams*:
 *
 *   1. the row exists the moment the endpoint answers — not when the model does;
 *   2. a real `worker.queue()` batch reaches `GenerateAssessmentDraft` and moves that row;
 *   3. every way the job can fail ends terminal, with a reason a human can read;
 *   4. a job that never runs at all is timed out rather than pending forever.
 *
 * (4) is the load-bearing one. Correct queue configuration is necessary and, as the outage
 * proved, not sufficient: message delivery is not a guarantee this system can make, so
 * "eventually terminal" has to hold without it.
 */

let counselor: StaffUserFixture;
let counselorToken: string;
let taxonomyBody: { assessment_type_id: string; scoring_ids: string[] };

const MAX_QUESTIONS = 50;

beforeAll(async () => {
  counselor = await createStaffUser({ role: 'counselor' });
  counselorToken = await login(counselor);

  const taxonomy = await assessmentTaxonomy();
  taxonomyBody = {
    assessment_type_id: taxonomy.assessmentTypeId,
    scoring_ids: taxonomy.scoringIds,
  };
});

/** One CUSTOM template with two dimensions and a DRAFT version, owned by the counselor. */
async function draftFixture(): Promise<{ templateId: string; versionId: string }> {
  const template = await api('POST', '/assessment-templates', {
    token: counselorToken,
    body: { category: 'CUSTOM', title: `Lifecycle ${uuid().slice(0, 8)}`, ...taxonomyBody },
  });

  expect(template.status).toBe(201);
  const templateId = template.body.data.id as string;

  const dimensions = await api('POST', `/assessment-templates/${templateId}/dimensions`, {
    token: counselorToken,
    body: {
      dimensions: [
        { code: 'TM', name: 'Time Management' },
        { code: 'FO', name: 'Focus' },
      ],
    },
  });

  expect(dimensions.status).toBe(201);

  const version = await api('POST', `/assessment-templates/${templateId}/versions`, {
    token: counselorToken,
    body: { scoring_algorithm: 'WEIGHTED_COMPOSITE' },
  });

  expect(version.status).toBe(201);

  return { templateId, versionId: version.body.data.id as string };
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
        { label: 'Always', value: 'a', score: 5 },
        { label: 'Never', value: 'n', score: 1 },
      ],
      dimension_code: 'FO',
    },
  ],
};

/** A gateway whose "model" answers with `payload` — or throws it, if it is an Error. */
function stubGateway(payload: unknown): AiGatewayService {
  const client: WorkersAiClient = {
    async run() {
      if (payload instanceof Error) {
        throw payload;
      }

      return { response: typeof payload === 'string' ? payload : JSON.stringify(payload) };
    },
  };

  return new AiGatewayService(db(), client, { text: 'stub-model', embedding: 'stub-embed' });
}

function generationService(payload: unknown): AssessmentGenerationService {
  return new AssessmentGenerationService(db(), stubGateway(payload), null, MAX_QUESTIONS);
}

async function rowFor(aiRequestId: string) {
  const [row] = await db().select().from(aiRequests).where(eq(aiRequests.id, aiRequestId));

  return row;
}

async function pollStatus(aiRequestId: string, token = counselorToken) {
  const response = await api('GET', `/ai/requests/${aiRequestId}/status`, { token });

  expect(response.status).toBe(200);

  return response.body.data as { status: string; failure_reason?: string; question_count?: number };
}

/** Queue one message through the real consumer in `index.ts`, and report ack vs retry. */
async function runQueue(body: JobMessage, queue = 'careerlinkai-ai-queue') {
  const calls = { ack: 0, retry: 0 };
  const batch = {
    queue,
    messages: [
      {
        id: uuid(),
        timestamp: new Date(),
        attempts: 1,
        body,
        ack: () => {
          calls.ack += 1;
        },
        retry: () => {
          calls.retry += 1;
        },
      },
    ],
  } as unknown as MessageBatch<JobMessage>;

  await worker.queue(batch, env);

  return calls;
}

// ═════════════════════════════════════════════════════════════════════════════════════════
describe('the reservation: a queued generation is visible before the job runs', () => {
  it('writes a PENDING ai_requests row at enqueue time, not at model time', async () => {
    const { versionId } = await draftFixture();

    const queued = await api('POST', `/assessment-versions/${versionId}/ai-generate/description`, {
      token: counselorToken,
      body: { description: 'A 10-question survey about study habits across TM and FO.' },
    });

    expect(queued.status).toBe(202);

    /**
     * The heart of the fix. This row used to not exist until the *job* wrote it, so the window
     * between 202 and completion had nothing in it — and a message that was never delivered kept
     * that window open forever. Now the endpoint's own transaction leaves something behind.
     */
    const row = await rowFor(queued.body.data.ai_request_id);

    expect(row).toBeDefined();
    expect(row!.status).toBe('PENDING');
    expect(row!.requestType).toBe('ASSESSMENT_GENERATION');
    expect(row!.userId).toBe(counselor.id);
    expect(row!.failureReason).toBeNull();

    expect((await pollStatus(queued.body.data.ai_request_id)).status).toBe('PENDING');
  });

  it('records the source mode and size on the reserved row, before the model is ever consulted', async () => {
    const { versionId } = await draftFixture();

    const queued = await api('POST', `/assessment-versions/${versionId}/ai-generate/document`, {
      token: counselorToken,
      body: { extracted_text: 'Extracted text of a study-skills handbook, long enough to mean something.' },
    });

    expect(queued.status).toBe(202);

    const row = await rowFor(queued.body.data.ai_request_id);

    expect(row!.inputContext).toMatchObject({ mode: 'DOCUMENT' });
    expect(row!.inputContext!.source_chars).toBeGreaterThan(20);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════
describe('the queue hop: the consumer actually reaches the generation handler', () => {
  /**
   * The leg nothing tested. `builder.test.ts` calls `generateDraft` directly, which proves the
   * pipeline and says nothing about whether a `GenerateAssessmentDraft` message ever arrives at
   * it — the precise thing that was broken in the dev profile, where `send()` succeeded and the
   * message went nowhere. Here the message goes through `worker.queue()`, the same export the
   * runtime calls, and the assertion is on the row it moved.
   */
  it('a GenerateAssessmentDraft message advances its reserved row out of PENDING', async () => {
    const { versionId } = await draftFixture();

    const queued = await api('POST', `/assessment-versions/${versionId}/ai-generate/description`, {
      token: counselorToken,
      body: { description: 'A 10-question survey about study habits across TM and FO.' },
    });

    const aiRequestId = queued.body.data.ai_request_id as string;

    expect((await rowFor(aiRequestId))!.status).toBe('PENDING');

    const calls = await runQueue({
      type: 'GenerateAssessmentDraft',
      payload: {
        aiRequestId,
        versionId,
        userId: counselor.id,
        mode: 'DESCRIPTION',
        sourceText: 'A 10-question survey about study habits across TM and FO.',
      },
    });

    // Acked, never retried: every failure this job can hit is one a retry cannot fix (§30 v1.5).
    expect(calls).toEqual({ ack: 1, retry: 0 });

    /**
     * The suite is hermetic — `wrangler.test.toml` binds no `AI`, because Workers AI has no local
     * emulation — so the real consumer reaches the gateway and finds no model. That is the
     * *correct* outcome to assert here: the point is that the row moved to a terminal state and
     * says why, not that a stub produced questions (which `builder.test.ts` covers). It is also
     * exactly what the offline `npm run dev` profile now does, in seconds, instead of hanging.
     */
    const row = await rowFor(aiRequestId);

    expect(row!.status).toBe('FAILED');
    expect(row!.failureReason).toContain('MODEL_UNAVAILABLE');
    expect(row!.failureReason).toContain('dev:remote');

    const status = await pollStatus(aiRequestId);

    expect(status.status).toBe('FAILED');
    expect(status.failure_reason).toContain('MODEL_UNAVAILABLE');
  });

  it('drives a reserved row all the way to DRAFTED when the model answers (stubbed §31 pipeline)', async () => {
    const { versionId } = await draftFixture();

    const queued = await api('POST', `/assessment-versions/${versionId}/ai-generate/description`, {
      token: counselorToken,
      body: { description: 'A 10-question survey about study habits across TM and FO.' },
    });

    const aiRequestId = queued.body.data.ai_request_id as string;

    const outcome = await generationService(generatedPayload).generateDraft({
      aiRequestId,
      versionId,
      userId: counselor.id,
      mode: 'DESCRIPTION',
      sourceText: 'A survey about study habits.',
    });

    expect(outcome).toEqual({ outcome: 'DRAFTED', questionCount: 2 });

    // The reserved row was *completed in place* — not duplicated. `log` upserts precisely so the
    // id the client polls stays one row through its whole life.
    const rows = await db().select().from(aiRequests).where(eq(aiRequests.id, aiRequestId));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('SUCCESS');
    expect(rows[0]!.responseText).toContain('fixed hours');

    const status = await pollStatus(aiRequestId);

    expect(status.status).toBe('DRAFTED');
    expect(status.question_count).toBe(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════
describe('every failure path is terminal, and says why', () => {
  /**
   * Each of these was a bare `return` before this change: the guard fired, the job ended, and the
   * reserved row was left exactly as it was found — PENDING, forever, with the reviewer watching a
   * spinner for a job that had already decided not to do anything.
   */
  it('a version that published while the message sat in the queue → FAILED, not PENDING', async () => {
    const { versionId } = await draftFixture();

    const queued = await api('POST', `/assessment-versions/${versionId}/ai-generate/description`, {
      token: counselorToken,
      body: { description: 'A 10-question survey about study habits across TM and FO.' },
    });

    const aiRequestId = queued.body.data.ai_request_id as string;

    // Publish it out from under the queued job (a question first — the gate needs one).
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
    expect((await api('POST', `/assessment-versions/${versionId}/publish`, { token: counselorToken })).status).toBe(200);

    const outcome = await generationService(generatedPayload).generateDraft({
      aiRequestId,
      versionId,
      userId: counselor.id,
      mode: 'DESCRIPTION',
      sourceText: 'A survey about study habits.',
    });

    expect(outcome.outcome).toBe('FAILED');

    const status = await pollStatus(aiRequestId);

    expect(status.status).toBe('FAILED');
    expect(status.failure_reason).toContain('PUBLISHED');

    // …and the frozen version is untouched, which is the reason the guard exists at all (§12).
    const drafted = await db()
      .select()
      .from(assessmentQuestions)
      .where(eq(assessmentQuestions.sourceAiRequestId, aiRequestId));

    expect(drafted).toHaveLength(0);
  });

  it('a version that no longer exists → FAILED with a precondition reason', async () => {
    const aiRequestId = uuid();

    await stubGateway(generatedPayload).reserve({
      id: aiRequestId,
      userId: counselor.id,
      requestType: 'ASSESSMENT_GENERATION',
      inputContext: {},
    });

    const outcome = await generationService(generatedPayload).generateDraft({
      aiRequestId,
      versionId: uuid(),
      userId: counselor.id,
      mode: 'DESCRIPTION',
      sourceText: 'A survey about study habits.',
    });

    expect(outcome.outcome).toBe('FAILED');
    expect((await rowFor(aiRequestId))!.failureReason).toContain('no longer exists');
  });

  it('a model that throws → FAILED with the §30 taxonomy, and the job is still acked', async () => {
    const { versionId } = await draftFixture();
    const aiRequestId = uuid();

    await stubGateway(generatedPayload).reserve({
      id: aiRequestId,
      userId: counselor.id,
      requestType: 'ASSESSMENT_GENERATION',
      inputContext: {},
    });

    const outcome = await generationService(
      new Error('3040: daily neuron quota exceeded'),
    ).generateDraft({
      aiRequestId,
      versionId,
      userId: counselor.id,
      mode: 'DESCRIPTION',
      sourceText: 'A survey about study habits.',
    });

    expect(outcome.outcome).toBe('FAILED');
    expect((await pollStatus(aiRequestId)).failure_reason).toContain('QUOTA_EXHAUSTED');
  });

  it('output that fails §34 → VALIDATION_FAILED, with the SUCCESS row intact (the model did answer)', async () => {
    const { versionId } = await draftFixture();
    const aiRequestId = uuid();

    await stubGateway('x').reserve({
      id: aiRequestId,
      userId: counselor.id,
      requestType: 'ASSESSMENT_GENERATION',
      inputContext: {},
    });

    const outcome = await generationService('Sure! Here are ten questions:\n1. Do you…').generateDraft({
      aiRequestId,
      versionId,
      userId: counselor.id,
      mode: 'DESCRIPTION',
      sourceText: 'A survey about study habits.',
    });

    expect(outcome).toEqual({ outcome: 'VALIDATION_FAILED' });

    // The audit trail must not claim the model was down when it answered — the distinction is
    // what tells a reviewer to fix the prompt rather than to try again later.
    expect((await rowFor(aiRequestId))!.status).toBe('SUCCESS');
    expect((await pollStatus(aiRequestId)).status).toBe('VALIDATION_FAILED');
  });

  it('an unexpected throw becomes a FAILED row, not an escape into the retry machinery', async () => {
    const aiRequestId = uuid();

    await stubGateway('x').reserve({
      id: aiRequestId,
      userId: counselor.id,
      requestType: 'ASSESSMENT_GENERATION',
      inputContext: {},
    });

    /**
     * A malformed message: `sourceText` absent, so the very first field access throws a
     * TypeError. This is the catch-all's real job — not the failures the guards above already
     * name, but the ones nobody predicted. A throw that escapes here reaches the consumer, which
     * retries three times and dead-letters, and the reviewer watches PENDING throughout.
     *
     * It also pins the placement of the boundary: the first log line reads `sourceText.length`,
     * and it is *inside* the try for exactly this input.
     */
    const outcome = await generationService(generatedPayload).generateDraft({
      aiRequestId,
      versionId: uuid(),
      userId: counselor.id,
      mode: 'DESCRIPTION',
      sourceText: undefined as unknown as string,
    });

    expect(outcome.outcome).toBe('FAILED');

    const row = await rowFor(aiRequestId);

    expect(row!.status).toBe('FAILED');
    expect(row!.failureReason).toContain('INTERNAL_ERROR');
  });

  it('the consumer acks a malformed generation message instead of retrying it into the DLQ', async () => {
    const aiRequestId = uuid();

    await stubGateway('x').reserve({
      id: aiRequestId,
      userId: counselor.id,
      requestType: 'ASSESSMENT_GENERATION',
      inputContext: {},
    });

    const calls = await runQueue({
      type: 'GenerateAssessmentDraft',
      payload: { aiRequestId, versionId: uuid(), userId: counselor.id, mode: 'DESCRIPTION' },
    });

    expect(calls).toEqual({ ack: 1, retry: 0 });
    expect((await rowFor(aiRequestId))!.status).toBe('FAILED');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════
describe('the deadline: a job that never runs still ends', () => {
  /**
   * The guarantee that does not depend on the queue behaving. Everything above assumes the message
   * arrives; this asserts what happens when it never does — which, before the deadline existed,
   * was "nothing, indefinitely", and is the literal reported bug.
   */
  async function reserveStale(): Promise<string> {
    const aiRequestId = uuid();
    const stale = new Date(Date.now() - GENERATION_DEADLINE_MS - 60_000).toISOString();

    await stubGateway('x').reserve({
      id: aiRequestId,
      userId: counselor.id,
      requestType: 'ASSESSMENT_GENERATION',
      inputContext: {},
    });

    // Backdate it: the row is what a message sent, and never delivered, leaves behind.
    await db()
      .update(aiRequests)
      .set({ createdAt: stale, updatedAt: stale })
      .where(eq(aiRequests.id, aiRequestId));

    return aiRequestId;
  }

  it('polls FAILED once a reserved row has been PENDING past the deadline', async () => {
    const aiRequestId = await reserveStale();
    const status = await pollStatus(aiRequestId);

    expect(status.status).toBe('FAILED');
    expect(status.failure_reason).toContain('TIMED_OUT');
    expect(status.failure_reason).toContain('queues.consumers');
  });

  it('reaps the row while reporting it, so every other reader sees the same truth', async () => {
    const aiRequestId = await reserveStale();

    await pollStatus(aiRequestId);

    const row = await rowFor(aiRequestId);

    expect(row!.status).toBe('FAILED');
    expect(row!.failureReason).toContain('TIMED_OUT');
  });

  it('does not time out a row that is merely young', async () => {
    const aiRequestId = uuid();

    await stubGateway('x').reserve({
      id: aiRequestId,
      userId: counselor.id,
      requestType: 'ASSESSMENT_GENERATION',
      inputContext: {},
    });

    expect((await pollStatus(aiRequestId)).status).toBe('PENDING');
    expect((await rowFor(aiRequestId))!.status).toBe('PENDING');
  });

  it('reports PROCESSING while a consumer holds it — distinguishable from merely queued', async () => {
    const aiRequestId = uuid();
    const gateway = stubGateway('x');

    await gateway.reserve({
      id: aiRequestId,
      userId: counselor.id,
      requestType: 'ASSESSMENT_GENERATION',
      inputContext: {},
    });

    expect(await gateway.markProcessing(aiRequestId)).toBe(true);
    expect((await pollStatus(aiRequestId)).status).toBe('PROCESSING');
  });

  it('markProcessing cannot drag a finished row back into flight (a redelivered message)', async () => {
    const { versionId } = await draftFixture();
    const aiRequestId = uuid();
    const gateway = stubGateway(generatedPayload);

    await gateway.reserve({
      id: aiRequestId,
      userId: counselor.id,
      requestType: 'ASSESSMENT_GENERATION',
      inputContext: {},
    });
    await generationService(generatedPayload).generateDraft({
      aiRequestId,
      versionId,
      userId: counselor.id,
      mode: 'DESCRIPTION',
      sourceText: 'A survey about study habits.',
    });

    expect(await gateway.markProcessing(aiRequestId)).toBe(false);
    expect((await rowFor(aiRequestId))!.status).toBe('SUCCESS');
  });

  it('the nightly cron reaps stale rows nobody is polling (M11)', async () => {
    const aiRequestId = await reserveStale();

    const result = await runNightlyCleanup(env);

    expect(result.stalledAiRequests).toBeGreaterThanOrEqual(1);

    const row = await rowFor(aiRequestId);

    expect(row!.status).toBe('FAILED');
    expect(row!.failureReason).toContain('TIMED_OUT');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════
describe('the dead-letter path marks a generation FAILED (H1, completed)', () => {
  /**
   * `index.ts` has always documented its DLQ branch as the thing that stops "a
   * `GenerateAssessmentDraft` gone silent" from leaving "its poll PENDING forever" — and then
   * handed the message to a `markAiJobFailed` that only ever looked for a `documentId`. The
   * comment described a behaviour the code did not have.
   */
  it('markAiJobFailed terminates a dead-lettered GenerateAssessmentDraft', async () => {
    const aiRequestId = uuid();

    await stubGateway('x').reserve({
      id: aiRequestId,
      userId: counselor.id,
      requestType: 'ASSESSMENT_GENERATION',
      inputContext: {},
    });

    await markAiJobFailed(env, {
      type: 'GenerateAssessmentDraft',
      payload: { aiRequestId },
    });

    const row = await rowFor(aiRequestId);

    expect(row!.status).toBe('FAILED');
    expect(row!.failureReason).toContain('JOB_FAILED');
  });

  it('a dead-lettered batch is acked, and the row it names ends terminal', async () => {
    const aiRequestId = uuid();

    await stubGateway('x').reserve({
      id: aiRequestId,
      userId: counselor.id,
      requestType: 'ASSESSMENT_GENERATION',
      inputContext: {},
    });

    const calls = await runQueue(
      { type: 'GenerateAssessmentDraft', payload: { aiRequestId } },
      'careerlinkai-ai-dlq',
    );

    // Never retried: a message that already failed three times goes straight back to the DLQ.
    expect(calls).toEqual({ ack: 1, retry: 0 });
    expect((await rowFor(aiRequestId))!.status).toBe('FAILED');
  });

  it('does not resurrect a row that already succeeded', async () => {
    const { versionId } = await draftFixture();
    const aiRequestId = uuid();

    await stubGateway(generatedPayload).reserve({
      id: aiRequestId,
      userId: counselor.id,
      requestType: 'ASSESSMENT_GENERATION',
      inputContext: {},
    });
    await generationService(generatedPayload).generateDraft({
      aiRequestId,
      versionId,
      userId: counselor.id,
      mode: 'DESCRIPTION',
      sourceText: 'A survey about study habits.',
    });

    await markAiJobFailed(env, { type: 'GenerateAssessmentDraft', payload: { aiRequestId } });

    expect((await rowFor(aiRequestId))!.status).toBe('SUCCESS');
    expect((await pollStatus(aiRequestId)).status).toBe('DRAFTED');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════
describe('the poll stays a capability check', () => {
  it("someone else's id reports PENDING — indistinguishable from one that never existed", async () => {
    const other = await login(await createStaffUser({ role: 'counselor' }));
    const { versionId } = await draftFixture();

    const queued = await api('POST', `/assessment-versions/${versionId}/ai-generate/description`, {
      token: counselorToken,
      body: { description: 'A 10-question survey about study habits across TM and FO.' },
    });

    const mine = await pollStatus(queued.body.data.ai_request_id, other);
    const bogus = await pollStatus(uuid(), other);

    expect(mine.status).toBe('PENDING');
    expect(bogus.status).toBe('PENDING');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════
describe('both roles reach the same surface (§20: /admin and /counselor, one router)', () => {
  it('an admin drafts into their own CUSTOM template through the identical endpoints', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const adminToken = await login(admin);

    const template = await api('POST', '/assessment-templates', {
      token: adminToken,
      body: { category: 'CUSTOM', title: `Admin lifecycle ${uuid().slice(0, 8)}`, ...taxonomyBody },
    });

    expect(template.status).toBe(201);

    await api('POST', `/assessment-templates/${template.body.data.id}/dimensions`, {
      token: adminToken,
      body: { dimensions: [{ code: 'TM', name: 'Time Management' }] },
    });

    const version = await api('POST', `/assessment-templates/${template.body.data.id}/versions`, {
      token: adminToken,
      body: { scoring_algorithm: 'WEIGHTED_COMPOSITE' },
    });

    const queued = await api(
      'POST',
      `/assessment-versions/${version.body.data.id}/ai-generate/description`,
      {
        token: adminToken,
        body: { description: 'A 10-question survey about study habits across TM.' },
      },
    );

    expect(queued.status).toBe(202);

    const aiRequestId = queued.body.data.ai_request_id as string;

    expect((await rowFor(aiRequestId))!.status).toBe('PENDING');

    const outcome = await generationService({
      questions: [
        {
          question_text: 'I plan my week before it starts.',
          question_type: 'LIKERT',
          options: [
            { label: 'Always', value: 'a', score: 5 },
            { label: 'Never', value: 'n', score: 1 },
          ],
          dimension_code: 'TM',
        },
      ],
    }).generateDraft({
      aiRequestId,
      versionId: version.body.data.id,
      userId: admin.id,
      mode: 'DESCRIPTION',
      sourceText: 'A survey about study habits.',
    });

    expect(outcome).toEqual({ outcome: 'DRAFTED', questionCount: 1 });

    const status = await api('GET', `/ai/requests/${aiRequestId}/status`, { token: adminToken });

    expect(status.body.data.status).toBe('DRAFTED');
    expect(status.body.data.question_count).toBe(1);
  });
});

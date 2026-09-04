import { describe, expect, it } from 'vitest';

import { aiRequests, chatConversations, chatMessages, knowledgeChunks, knowledgeDocuments } from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import {
  DAILY_GENERATION_BUDGET,
  GENERATION_BUDGET_DEGRADE_AT,
  secondsUntilUtcMidnight,
} from '@/lib/auth-guard';
import { AiInsightsService } from '@/modules/ai/insights-service';
import { api, createCareer, createStaffUser, db, login } from '../helpers';

/**
 * **The flywheel** (AiNormalisation Phase 4).
 *
 * Coverage is not a launch state, it is a habit — and a habit needs the gaps to be visible and
 * closing them to be one click away. Everything asserted here reads data the system was *already*
 * writing: Phase 5a has logged the exact question behind every refusal since it shipped, and until
 * now nothing ever looked at it.
 */

async function seedRefusal(question: string, reason: string): Promise<void> {
  const timestamp = now();

  await db().insert(aiRequests).values({
    id: uuid(),
    userId: null,
    requestType: 'CHAT',
    inputContext: { retrieval_query: question, chunk_ids: [] },
    responseText: null,
    model: 'stub',
    tokensUsed: null,
    latencyMs: 0,
    status: 'FAILED',
    failureReason: reason,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

describe('the unanswered-questions report', () => {
  /**
   * The point of the whole phase: the most-asked gap is first on screen, so an admin answering
   * five questions closes the five that most students hit. After that, Gate 1 answers each of them
   * verbatim, for free, forever.
   */
  it('groups refusals by question and ranks them by how many students asked', async () => {
    const rare = `Is there a dorm? ${uuid()}`;
    const common = `How much is the entrance fee? ${uuid()}`;

    await seedRefusal(rare, 'SKIPPED: No knowledge chunks above the similarity threshold.');

    for (let i = 0; i < 3; i += 1) {
      await seedRefusal(common, 'SKIPPED: nothing retrieved — NO_GROUNDING.');
    }

    const report = await new AiInsightsService(db()).unansweredQuestions();
    const top = report.find((row) => row.question === common);

    expect(top).toBeDefined();
    expect(top!.asks).toBe(3);
    expect(report.findIndex((row) => row.question === common)).toBeLessThan(
      report.findIndex((row) => row.question === rare),
    );
  });

  /**
   * The distinction that makes the report usable. A model outage is an operational problem no
   * amount of admin writing will fix, and mixing those rows in would bury the actionable ones on
   * exactly the days the platform was having trouble.
   */
  it('excludes failures that are not coverage gaps', async () => {
    const outage = `A question during an outage ${uuid()}`;

    await seedRefusal(outage, 'MODEL_ERROR: the model did not respond.');

    const report = await new AiInsightsService(db()).unansweredQuestions();

    expect(report.map((row) => row.question)).not.toContain(outage);
  });
});

describe('the catalog coverage grid', () => {
  it('lists a career with nothing in the corpus about it, and clears once it has chunks', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const career = await createCareer(token, { description: 'A career with no entry yet.' });
    const service = new AiInsightsService(db());

    const before = await service.coverage();

    expect(before.gaps.some((gap) => gap.id === career.id)).toBe(true);

    // An entry with an embedded chunk about it is coverage; that is the whole definition.
    const documentId = uuid();
    const timestamp = now();

    await db().insert(knowledgeDocuments).values({
      id: documentId,
      uploadedBy: admin.id,
      title: 'Career entry',
      fileName: 'Career entry',
      sourceType: 'catalog',
      storagePath: null,
      entityType: 'career',
      entityId: career.id as string,
      contentHash: 'hash',
      processingStatus: 'COMPLETED',
      visibility: 'GLOBAL',
      archivedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const chunkId = uuid();

    await db().insert(knowledgeChunks).values({
      id: chunkId,
      documentId,
      chunkNumber: 1,
      content: 'About this career.',
      vectorId: chunkId,
      tokenCount: 10,
      sourceType: 'catalog',
      entityType: 'career',
      entityId: career.id as string,
      createdAt: timestamp,
    });

    const after = await service.coverage();

    expect(after.gaps.some((gap) => gap.id === career.id)).toBe(false);
    expect(after.careers.covered).toBeGreaterThan(before.careers.covered);
  });

  /**
   * The two causes of a gap need different actions, so the report separates them: no entry at all
   * is a sync that has not run, while an entry whose chunks never embedded is a failed job — one
   * button away from fixed, and invisible in every other list.
   */
  it('marks an entry whose chunks never embedded as stalled rather than missing', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const career = await createCareer(token, { description: 'A career whose job failed.' });

    const documentId = uuid();
    const timestamp = now();

    await db().insert(knowledgeDocuments).values({
      id: documentId,
      uploadedBy: admin.id,
      title: 'Half-processed entry',
      fileName: 'Half-processed entry',
      sourceType: 'catalog',
      storagePath: null,
      entityType: 'career',
      entityId: career.id as string,
      contentHash: 'hash',
      processingStatus: 'FAILED',
      visibility: 'GLOBAL',
      archivedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await db().insert(knowledgeChunks).values({
      id: uuid(),
      documentId,
      chunkNumber: 1,
      content: 'Text that never became a vector.',
      // The defining symptom: a chunk with no vector is a chunk retrieval cannot find.
      vectorId: null,
      tokenCount: 10,
      sourceType: 'catalog',
      entityType: 'career',
      entityId: career.id as string,
      createdAt: timestamp,
    });

    const report = await new AiInsightsService(db()).coverage();
    const gap = report.gaps.find((row) => row.id === career.id);

    expect(gap).toBeDefined();
    expect(gap!.stalled).toBe(true);
  });
});

describe('flagged answers', () => {
  it('carries the question and the chunk ids that produced the answer', async () => {
    const student = await createStaffUser({ role: 'admin' }); // any user row; the FK is to users
    const conversationId = uuid();
    const requestId = uuid();
    const timestamp = now();

    await db().insert(aiRequests).values({
      id: requestId,
      userId: null,
      requestType: 'CHAT',
      inputContext: { retrieval_query: 'q', chunk_ids: ['chunk-a', 'chunk-b'] },
      responseText: 'an answer',
      model: 'stub',
      tokensUsed: 10,
      latencyMs: 5,
      status: 'SUCCESS',
      failureReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await db().insert(chatConversations).values({
      id: conversationId,
      studentId: student.id,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await db().insert(chatMessages).values([
      {
        id: uuid(),
        conversationId,
        role: 'user',
        content: 'What is the entrance fee?',
        aiRequestId: null,
        sources: null,
        feedback: null,
        createdAt: timestamp,
      },
      {
        id: uuid(),
        conversationId,
        role: 'assistant',
        content: 'It is PHP 1,000.',
        aiRequestId: requestId,
        sources: ['Fees Circular'],
        feedback: 'DOWN',
        createdAt: timestamp,
      },
    ]);

    const [flagged] = await new AiInsightsService(db()).flaggedAnswers();

    expect(flagged).toBeDefined();
    expect(flagged!.question).toBe('What is the entrance fee?');
    // Provenance is what turns a complaint into a fix: these ids lead to the passage that caused it.
    expect(flagged!.chunkIds).toEqual(['chunk-a', 'chunk-b']);
  });
});

describe('the daily generation budget', () => {
  /**
   * The budget stops at 85% rather than at the platform's own ceiling, and that is the whole
   * design: hitting the real limit kills every AI feature at once, at whatever hour that day's
   * classes happened to exhaust it. Degrading early keeps a reserve for the gates that cost
   * nothing and fails predictably instead.
   */
  it('degrades below the platform ceiling, leaving a reserve', () => {
    const degradeAt = Math.floor(DAILY_GENERATION_BUDGET * GENERATION_BUDGET_DEGRADE_AT);

    expect(degradeAt).toBeLessThan(DAILY_GENERATION_BUDGET);
    expect(degradeAt).toBeGreaterThan(0);
  });

  it('expires with the Workers AI allocation, at 00:00 UTC', () => {
    const justBefore = Date.parse('2026-09-04T23:59:00.000Z');
    const justAfter = Date.parse('2026-09-04T00:00:30.000Z');

    expect(secondsUntilUtcMidnight(justBefore)).toBe(60);
    // A window opened seconds into a day runs almost the whole day, never past its end.
    expect(secondsUntilUtcMidnight(justAfter)).toBe(86_370);
  });
});

describe('GET /admin/ai-insights', () => {
  it('is admin-only and answers with all four sections', async () => {
    const counselor = await createStaffUser({ role: 'counselor' });

    expect(
      (await api('GET', '/admin/ai-insights', { token: await login(counselor) })).status,
    ).toBe(403);

    const admin = await createStaffUser({ role: 'admin' });
    const response = await api('GET', '/admin/ai-insights', { token: await login(admin) });

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveProperty('unanswered_questions');
    expect(response.body.data).toHaveProperty('coverage');
    expect(response.body.data).toHaveProperty('flagged_answers');
    expect(response.body.data.corpus).toHaveProperty('embedded');
  });
});

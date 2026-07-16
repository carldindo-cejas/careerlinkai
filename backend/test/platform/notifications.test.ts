/* eslint-disable @typescript-eslint/require-await -- async-interface stubs have nothing to await */
import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createDatabase } from '@/db/client';
import { aiRequests, assessmentQuestions, knowledgeDocuments, notifications } from '@/db/schema';
import {
  notifyAssessmentDraftGenerated,
  notifyKnowledgeDocumentProcessed,
  notifyRecommendationGenerated,
} from '@/events/send-notifications';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { AiGatewayService, type WorkersAiClient } from '@/modules/ai/ai-gateway-service';
import { KnowledgeIngestionService } from '@/modules/ai/knowledge-ingestion-service';
import type { VectorStore } from '@/modules/ai/vector-store';
import { NotificationService } from '@/modules/platform/notification-service';
import {
  api,
  classWithStudent,
  createClass,
  createStaffUser,
  db,
  enrolStudents,
  login,
} from '../helpers';

/**
 * The Phase 6 notification system (FULLPLAN §13.8, §44, §20).
 *
 * Three seams under test: the three HTTP endpoints (every route means *mine*), the §44
 * listeners (each ends in exactly one `NotificationService.send()`), and the one §44
 * notification that is a direct fan-out rather than a listener — assignment creation.
 */

async function notificationsFor(userId: string) {
  return db().select().from(notifications).where(eq(notifications.userId, userId));
}

describe('GET /notifications', () => {
  it('requires authentication', async () => {
    const response = await api('GET', '/notifications');

    expect(response.status).toBe(401);
  });

  it('returns only my notifications, newest first, with the unread count', async () => {
    const mine = await createStaffUser({ role: 'counselor' });
    const other = await createStaffUser({ role: 'counselor' });
    const service = new NotificationService(db());

    await service.send({
      userId: mine.id,
      title: 'First',
      message: 'First message.',
      category: 'ACCOUNT',
    });
    await service.send({
      userId: mine.id,
      title: 'Second',
      message: 'Second message.',
      category: 'ASSESSMENT',
    });
    await service.send({
      userId: other.id,
      title: 'Not yours',
      message: 'Someone else’s.',
      category: 'ACCOUNT',
    });

    const response = await api('GET', '/notifications', { token: await login(mine) });

    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(2);
    expect(response.body.data.unread_count).toBe(2);
    expect(response.body.data.pagination).toMatchObject({ current_page: 1, total: 2 });

    const titles = response.body.data.items.map((item: any) => item.title);
    expect(titles).not.toContain('Not yours');

    // The serializer is an allow-list: no recipient id ever leaves the API.
    expect(response.body.data.items[0]).not.toHaveProperty('user_id');
  });

  it('a student can read their notifications too — the router has no role gate', async () => {
    const counselor = await createStaffUser({ role: 'counselor' });
    const { student, studentToken } = await classWithStudent(await login(counselor));

    await new NotificationService(db()).send({
      userId: student.student_id,
      title: 'Hello',
      message: 'A student-addressed notification.',
      category: 'CLASS',
    });

    const response = await api('GET', '/notifications', { token: studentToken });

    expect(response.status).toBe(200);
    expect(response.body.data.items.some((item: any) => item.title === 'Hello')).toBe(true);
  });
});

describe('PATCH /notifications/{id}/read', () => {
  it('marks mine read, idempotently — the first read_at is the one that stays', async () => {
    const user = await createStaffUser({ role: 'counselor' });
    const token = await login(user);
    const row = await new NotificationService(db()).send({
      userId: user.id,
      title: 'Read me',
      message: 'A message.',
      category: 'ACCOUNT',
    });

    const first = await api('PATCH', `/notifications/${row.id}/read`, { token });

    expect(first.status).toBe(200);
    expect(first.body.data.read_at).not.toBeNull();

    const second = await api('PATCH', `/notifications/${row.id}/read`, { token });

    expect(second.status).toBe(200);
    expect(second.body.data.read_at).toBe(first.body.data.read_at);
  });

  it("someone else's notification 404s, identically to one that does not exist", async () => {
    const owner = await createStaffUser({ role: 'counselor' });
    const intruder = await createStaffUser({ role: 'counselor' });
    const row = await new NotificationService(db()).send({
      userId: owner.id,
      title: 'Private',
      message: 'Not yours to mark.',
      category: 'ACCOUNT',
    });

    const token = await login(intruder);
    const foreign = await api('PATCH', `/notifications/${row.id}/read`, { token });
    const missing = await api('PATCH', `/notifications/${uuid()}/read`, { token });

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
  });
});

describe('PATCH /notifications/read-all', () => {
  it('clears every unread row and reports how many', async () => {
    const user = await createStaffUser({ role: 'counselor' });
    const token = await login(user);
    const service = new NotificationService(db());

    await service.send({ userId: user.id, title: 'A', message: 'a', category: 'ACCOUNT' });
    await service.send({ userId: user.id, title: 'B', message: 'b', category: 'ACCOUNT' });

    const response = await api('PATCH', '/notifications/read-all', { token });

    expect(response.status).toBe(200);
    expect(response.body.data.updated).toBe(2);

    const after = await api('GET', '/notifications', { token });
    expect(after.body.data.unread_count).toBe(0);

    // A second sweep has nothing left to touch.
    const again = await api('PATCH', '/notifications/read-all', { token });
    expect(again.body.data.updated).toBe(0);
  });
});

describe('§44: "New assessment assigned" — the fan-out at assignment creation', () => {
  it('notifies every active enrollment and skips a removed one', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const counselor = await createStaffUser({ role: 'counselor' });
    const counselorToken = await login(counselor);

    const classRoom = await createClass(counselorToken);
    const roster = await enrolStudents(counselorToken, classRoom.id, [
      'Juan Dela Cruz',
      'Maria Santos',
      'Pedro Reyes',
    ]);

    // Remove the third student before assigning — §44 addresses the class as it stands.
    const removal = await api(
      'DELETE',
      `/counselor/classes/${classRoom.id}/students/${roster[2].student_id}`,
      { token: counselorToken },
    );
    expect([200, 204]).toContain(removal.status);

    // A one-question ungraded CUSTOM assessment, published through the real gate.
    const template = await api('POST', '/assessment-templates', {
      token: counselorToken,
      body: { category: 'CUSTOM', title: 'Semester Reflection' },
    });
    const version = await api('POST', `/assessment-templates/${template.body.data.id}/versions`, {
      token: counselorToken,
      body: {},
    });
    await api('POST', `/assessment-versions/${version.body.data.id}/questions`, {
      token: counselorToken,
      body: {
        questions: [
          {
            question_text: 'I feel prepared for next semester.',
            question_type: 'LIKERT',
            options: [
              { label: 'Disagree', value: '1', score: 1 },
              { label: 'Agree', value: '5', score: 5 },
            ],
          },
        ],
      },
    });
    const published = await api('POST', `/assessment-versions/${version.body.data.id}/publish`, {
      token: counselorToken,
      body: {},
    });
    expect(published.status).toBe(200);

    const deadline = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const assigned = await api('POST', `/counselor/classes/${classRoom.id}/assignments`, {
      token: counselorToken,
      body: { assessment_version_id: version.body.data.id, deadline },
    });
    expect(assigned.status).toBe(201);

    const [first, second, removed] = await Promise.all([
      notificationsFor(roster[0].student_id),
      notificationsFor(roster[1].student_id),
      notificationsFor(roster[2].student_id),
    ]);

    for (const rows of [first, second]) {
      const assignmentRows = rows.filter((row) => row.category === 'CLASS');

      expect(assignmentRows).toHaveLength(1);
      expect(assignmentRows[0]!.message).toBe(
        `New assessment assigned: Semester Reflection, due ${deadline.slice(0, 10)}.`,
      );
    }

    expect(removed.filter((row) => row.category === 'CLASS')).toHaveLength(0);

    // Silence-check the admin: §44 addresses the roster, not the staff.
    expect(await notificationsFor(admin.id)).toHaveLength(0);
  });

  it('omits the due clause when the assignment has no deadline', async () => {
    const counselor = await createStaffUser({ role: 'counselor' });
    const token = await login(counselor);
    const classRoom = await createClass(token);
    const roster = await enrolStudents(token, classRoom.id, ['Ana Lopez']);

    const template = await api('POST', '/assessment-templates', {
      token,
      body: { category: 'CUSTOM', title: 'Open Reflection' },
    });
    const version = await api('POST', `/assessment-templates/${template.body.data.id}/versions`, {
      token,
      body: {},
    });
    await api('POST', `/assessment-versions/${version.body.data.id}/questions`, {
      token,
      body: {
        questions: [
          {
            question_text: 'One thing I learned this week.',
            question_type: 'LIKERT',
            options: [
              { label: 'Disagree', value: '1', score: 1 },
              { label: 'Agree', value: '5', score: 5 },
            ],
          },
        ],
      },
    });
    await api('POST', `/assessment-versions/${version.body.data.id}/publish`, { token, body: {} });

    await api('POST', `/counselor/classes/${classRoom.id}/assignments`, {
      token,
      body: { assessment_version_id: version.body.data.id },
    });

    const rows = await notificationsFor(roster[0].student_id);
    const assignmentRows = rows.filter((row) => row.category === 'CLASS');

    expect(assignmentRows).toHaveLength(1);
    expect(assignmentRows[0]!.message).toBe('New assessment assigned: Open Reflection.');
  });
});

describe('§44: "Your {assessment title} results are ready." — fired from submit', () => {
  it('lands for the student who submits, through the real HTTP flow', async () => {
    const counselor = await createStaffUser({ role: 'counselor' });
    const counselorToken = await login(counselor);
    const { classRoom, student, studentToken } = await classWithStudent(counselorToken);

    const template = await api('POST', '/assessment-templates', {
      token: counselorToken,
      body: { category: 'CUSTOM', title: 'Study Habits Check' },
    });
    const version = await api('POST', `/assessment-templates/${template.body.data.id}/versions`, {
      token: counselorToken,
      body: {},
    });
    await api('POST', `/assessment-versions/${version.body.data.id}/questions`, {
      token: counselorToken,
      body: {
        questions: [
          {
            question_text: 'I keep a regular study schedule.',
            question_type: 'LIKERT',
            options: [
              { label: 'Disagree', value: '1', score: 1 },
              { label: 'Agree', value: '5', score: 5 },
            ],
          },
        ],
      },
    });
    await api('POST', `/assessment-versions/${version.body.data.id}/publish`, {
      token: counselorToken,
      body: {},
    });
    const assignment = await api('POST', `/counselor/classes/${classRoom.id}/assignments`, {
      token: counselorToken,
      body: { assessment_version_id: version.body.data.id },
    });

    const attempt = await api('POST', `/student/assignments/${assignment.body.data.id}/start`, {
      token: studentToken,
    });
    const question = attempt.body.data.questions[0];

    await api('POST', `/student/attempts/${attempt.body.data.id}/answers`, {
      token: studentToken,
      body: { question_id: question.id, selected_option_id: question.options[0].id },
    });

    const submitted = await api('POST', `/student/attempts/${attempt.body.data.id}/submit`, {
      token: studentToken,
    });
    expect(submitted.status).toBe(200);

    const rows = await notificationsFor(student.student_id);
    const resultRows = rows.filter((row) => row.category === 'ASSESSMENT');

    expect(resultRows).toHaveLength(1);
    expect(resultRows[0]!.message).toBe('Your Study Habits Check results are ready.');

    // CUSTOM feeds no recommendation (§27), so no RECOMMENDATION notification appears.
    expect(rows.filter((row) => row.category === 'RECOMMENDATION')).toHaveLength(0);
  });
});

describe('the remaining §44 listeners', () => {
  it('RecommendationGenerated → "Your career recommendations are ready to view."', async () => {
    const user = await createStaffUser({ role: 'counselor' });

    await notifyRecommendationGenerated(db())({
      type: 'RecommendationGenerated',
      studentId: user.id,
      careers: 10,
      programs: 10,
    });

    const rows = await notificationsFor(user.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.category).toBe('RECOMMENDATION');
    expect(rows[0]!.message).toBe('Your career recommendations are ready to view.');
  });

  it('AssessmentDraftGenerated with drafted questions → the review notification', async () => {
    const counselor = await createStaffUser({ role: 'counselor' });
    const token = await login(counselor);

    const template = await api('POST', '/assessment-templates', {
      token,
      body: { category: 'CUSTOM', title: 'Grit Scale' },
    });
    const version = await api('POST', `/assessment-templates/${template.body.data.id}/versions`, {
      token,
      body: {},
    });

    // The rows the generation job would have written: one ai_requests row, two questions
    // referencing it. Written directly because Workers AI has no local emulation — the §31
    // pipeline itself is pinned in test/ai; this test pins the listener's reading of it.
    const aiRequestId = uuid();
    const database = createDatabase(env.DB);
    const timestamp = now();

    await database.insert(aiRequests).values({
      id: aiRequestId,
      userId: counselor.id,
      requestType: 'ASSESSMENT_GENERATION',
      status: 'SUCCESS',
      createdAt: timestamp,
    });
    await database.insert(assessmentQuestions).values(
      [1, 2].map((order) => ({
        id: uuid(),
        assessmentVersionId: version.body.data.id,
        questionText: `Drafted question ${order}`,
        questionType: 'LIKERT' as const,
        orderNumber: order,
        required: true,
        source: 'AI_GENERATED' as const,
        sourceAiRequestId: aiRequestId,
        createdAt: timestamp,
      })),
    );

    await notifyAssessmentDraftGenerated(database)({
      type: 'AssessmentDraftGenerated',
      aiRequestId,
      versionId: version.body.data.id,
      creatorId: counselor.id,
    });

    const rows = await notificationsFor(counselor.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.message).toBe(
      "Your AI-generated draft for 'Grit Scale' is ready — 2 questions need review before you can publish.",
    );
  });

  it('AssessmentDraftGenerated with zero questions sends nothing — "ready" must not be a lie', async () => {
    const counselor = await createStaffUser({ role: 'counselor' });

    await notifyAssessmentDraftGenerated(db())({
      type: 'AssessmentDraftGenerated',
      aiRequestId: uuid(),
      versionId: uuid(),
      creatorId: counselor.id,
    });

    expect(await notificationsFor(counselor.id)).toHaveLength(0);
  });

  it('the ingestion pipeline fires KnowledgeDocumentProcessed at COMPLETED, and the listener notifies the uploader', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const database = db();
    const documentId = uuid();
    const timestamp = now();

    await database.insert(knowledgeDocuments).values({
      id: documentId,
      uploadedBy: admin.id,
      fileName: 'career-guide.pdf',
      fileType: 'pdf',
      storagePath: `knowledge/${documentId}/career-guide.pdf`,
      processingStatus: 'UPLOADED',
      visibility: 'GLOBAL',
      archivedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await env.STORAGE.put(
      `knowledge/${documentId}/extracted.txt`,
      'Careers in software engineering reward investigative and analytical interests. '.repeat(50),
    );

    const embedder: WorkersAiClient = {
      run: async (_model, inputs) => ({
        data: (inputs.text as string[]).map(() => [0.5, 0.5, 0.5]),
      }),
    };
    const accepted: unknown[] = [];
    const vectors: VectorStore = {
      upsert: async (records) => {
        accepted.push(records);
      },
      query: async () => ({ matches: [] }),
      deleteByIds: async (ids) => {
        accepted.push(ids);
      },
    };

    // No queue → the pipeline runs inline through embedBatch, which is where COMPLETED lands.
    const service = new KnowledgeIngestionService(
      database,
      env.STORAGE,
      new AiGatewayService(database, embedder, { text: 't', embedding: 'e' }),
      vectors,
      undefined,
      [notifyKnowledgeDocumentProcessed(database)],
    );

    await service.process(documentId);

    const rows = await notificationsFor(admin.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.category).toBe('ACCOUNT');
    expect(rows[0]!.message).toBe('career-guide.pdf is now available to the AI assistant.');
  });
});

import { env } from 'cloudflare:test';
import { and, eq, isNotNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  aiRequests,
  chatConversations,
  chatMessages,
  classStudents,
  knowledgeDocuments,
  knowledgeQuestionResolutions,
  notifications,
} from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { AiInsightsService } from '@/modules/ai/insights-service';
import {
  api,
  classWithStudent,
  createStaffUser,
  createStudentUser,
  db,
  findUser,
  login,
} from '../helpers';

/**
 * **The backlog learns what has already been dealt with** (migration 0031).
 *
 * The bug this file exists for: `/admin/ai-insights` built its list out of `ai_requests` failures
 * and `chat_messages.knowledge_request` rows, and both are records of past events that can never
 * stop being true. So answering a question removed nothing — the question stayed at the top of the
 * list with its ask count intact, indistinguishable from the ones nobody had touched, and the only
 * way to tell them apart was to remember. That is the one thing a backlog exists so nobody has to
 * do.
 *
 * What is asserted here is mostly *lapsing*: the resolution is deliberately conditional rather
 * than a tombstone, and each condition is a way the naive fix would have gone quietly wrong.
 */

async function seedRefusal(question: string, askedAt = now(), userId: string | null = null) {
  await db().insert(aiRequests).values({
    id: uuid(),
    userId,
    requestType: 'CHAT',
    inputContext: { retrieval_query: question, chunk_ids: [] },
    responseText: null,
    model: 'stub',
    tokensUsed: null,
    latencyMs: 0,
    status: 'FAILED',
    failureReason: 'SKIPPED: nothing retrieved — NO_GROUNDING.',
    createdAt: askedAt,
    updatedAt: askedAt,
  });
}

/** One student pressing *"Request to add to knowledge"* on a refusal (migration 0030). */
async function seedKnowledgeRequest(question: string, studentId: string) {
  const conversationId = uuid();
  const timestamp = now();

  await db().insert(chatConversations).values({
    id: conversationId,
    studentId,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  await db()
    .insert(chatMessages)
    .values([
      {
        id: uuid(),
        conversationId,
        role: 'user',
        content: question,
        aiRequestId: null,
        sources: null,
        feedback: null,
        knowledgeRequest: null,
        createdAt: timestamp,
      },
      {
        id: uuid(),
        conversationId,
        role: 'assistant',
        content: 'Nothing in the guidance materials covers that.',
        aiRequestId: null,
        sources: null,
        feedback: null,
        knowledgeRequest: 'REQUESTED',
        createdAt: timestamp,
      },
    ]);
}

/** Answer a backlog question the way the UI does: one entry, carrying the question it resolves. */
async function answer(token: string, question: string, resolves = question) {
  const response = await api('POST', '/admin/knowledge-entries', {
    token,
    body: {
      type: 'qa',
      question,
      answer: 'The fee is PHP 500, payable at the registrar before enrolment closes.',
      resolves_question: resolves,
    },
  });

  expect(response.status).toBe(201);

  return response.body.data.id as string;
}

function questionsIn(report: { items: { question: string }[] }): string[] {
  return report.items.map((row) => row.question);
}

/**
 * The **user** id behind a roster entry.
 *
 * `enrolStudents` returns enrollment rows, whose `id` is the `class_students` row rather than the
 * student's account — and the scoping under test joins on the account. Reading it back is the
 * difference between asserting the scope and asserting a foreign-key error.
 */
async function studentUserId(enrollmentId: string): Promise<string> {
  const [enrollment] = await db()
    .select({ studentId: classStudents.studentId })
    .from(classStudents)
    .where(eq(classStudents.id, enrollmentId));

  return enrollment!.studentId;
}

describe('answering a question takes it off the backlog', () => {
  /**
   * The reported bug, in one test. Before migration 0031 the second assertion failed: the entry
   * was written, the corpus could answer it, and the report still listed it forever.
   */
  it('removes a question from the unanswered list once an entry answers it', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const question = `How much is the entrance fee? ${uuid()}`;

    await seedRefusal(question);

    const service = new AiInsightsService(db());

    expect(questionsIn(await service.unansweredQuestions())).toContain(question);

    await answer(token, question);

    expect(questionsIn(await service.unansweredQuestions())).not.toContain(question);
  });

  /**
   * The reason the resolution is keyed on normalised text rather than on the entry's own question.
   *
   * The report shows the student's retrieval query; the first thing anybody does in the Q&A form is
   * tidy it up. If the key came from the saved entry, changing the capitalisation would key the
   * resolution to text no `ai_requests` row ever held — the item would never clear, and there would
   * now be a row in the resolutions table insisting it had been handled.
   */
  it('clears the backlog item even when the answer rephrases the question', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const asked = `is there a shuttle service ${uuid()}`;

    await seedRefusal(asked);

    // Saved with different capitalisation, a trailing question mark and surrounding space —
    // exactly what tidying up in the form produces.
    await answer(token, `  Is There A Shuttle Service ${asked.split(' ').pop()}?  `, asked);

    expect(questionsIn(await new AiInsightsService(db()).unansweredQuestions())).not.toContain(
      asked,
    );
  });

  /**
   * Found by testing against production: a Q&A written from scratch — or before migration 0031
   * existed — claimed nothing, so its question sat on the backlog forever while Gate 1 was already
   * answering it verbatim. A Q&A pair is by definition a statement that its question is answered.
   */
  it('clears a matching question when a Q&A is written from scratch', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const question = `When do dorm applications open? ${uuid()}`;

    await seedRefusal(question);

    const response = await api('POST', '/admin/knowledge-entries', {
      token,
      body: { type: 'qa', question: `  ${question.toUpperCase()}?  `, answer: 'Applications open in May.' },
    });

    expect(response.status).toBe(201);
    // Not announced — nothing was claimed from the report, so the message must not say so.
    expect(response.body.message).not.toContain('unanswered list');
    expect(questionsIn(await new AiInsightsService(db()).unansweredQuestions())).not.toContain(
      question,
    );
  });

  /** A pasted note has a title, not a question — it claims nothing on its own. */
  it('does not clear anything from a pasted note', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const question = `Is there a canteen on campus? ${uuid()}`;

    await seedRefusal(question);

    const response = await api('POST', '/admin/knowledge-entries', {
      token,
      body: { type: 'text', title: question, body: 'The canteen opens at 7 AM.' },
    });

    expect(response.status).toBe(201);
    expect(questionsIn(await new AiInsightsService(db()).unansweredQuestions())).toContain(question);
  });

  /**
   * Editing an existing Q&A resolves its question too — the entry somebody opens to reword an
   * "answered, asked again" row is precisely the one whose question should then clear.
   */
  it('clears a matching question when an existing Q&A is edited', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const question = `What time does the library close? ${uuid()}`;

    const created = await api('POST', '/admin/knowledge-entries', {
      token,
      body: { type: 'qa', question: `Library hours ${uuid()}`, answer: 'Until 5 PM.' },
    });

    await seedRefusal(question);

    // The author rewrites the entry to match how students actually ask it.
    const edited = await api('PATCH', `/admin/knowledge-entries/${created.body.data.id}`, {
      token,
      body: { type: 'qa', question, answer: 'The library closes at 5 PM.' },
    });

    expect(edited.status).toBe(200);
    expect(questionsIn(await new AiInsightsService(db()).unansweredQuestions())).not.toContain(
      question,
    );
  });
});

describe('a resolution lapses instead of being a tombstone', () => {
  /**
   * Archiving the answering entry removes its vectors from the index (§13.7), so the question is
   * genuinely unanswered again. A resolution that survived that would hide a real gap.
   */
  it('puts the question back when the answering entry is archived', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const question = `Is there a dorm? ${uuid()}`;

    await seedRefusal(question);

    const documentId = await answer(token, question);
    const service = new AiInsightsService(db());

    expect(questionsIn(await service.unansweredQuestions())).not.toContain(question);

    const archived = await api('DELETE', `/admin/knowledge-documents/${documentId}`, { token });

    expect(archived.status).toBe(200);
    // …and the response says so, rather than letting the backlog grow tomorrow unexplained.
    expect(archived.body.message).toContain('back on the unanswered list');
    expect(questionsIn(await service.unansweredQuestions())).toContain(question);
  });

  /**
   * The subtlest of the three, and the one worth having most.
   *
   * A FAILED entry is text that exists and never embedded — it looks healthy in every other list.
   * If its resolution still counted, the question would vanish from the one screen that would have
   * shown the gap: the admin believes it is answered, the student still gets refused, and nothing
   * anywhere says otherwise.
   */
  it('puts the question back when the answering entry failed to process', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const question = `What documents do I bring? ${uuid()}`;

    await seedRefusal(question);

    const documentId = await answer(token, question);
    const service = new AiInsightsService(db());

    expect(questionsIn(await service.unansweredQuestions())).not.toContain(question);

    await db()
      .update(knowledgeDocuments)
      .set({ processingStatus: 'FAILED' })
      .where(eq(knowledgeDocuments.id, documentId));

    expect(questionsIn(await service.unansweredQuestions())).toContain(question);
  });

  /**
   * An answer that exists and is not being retrieved is a **retrieval** problem, and writing a
   * second entry for it is wasted work. So the question comes back carrying only the asks that
   * happened *after* it was answered, flagged, and sorted above everything else — because nothing
   * else on the screen would ever say so.
   */
  it('returns a question asked again after it was answered, counting only the new asks', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const question = `Do you offer BS Data Science? ${uuid()}`;

    // Three asks before the answer…
    for (let i = 0; i < 3; i += 1) {
      await seedRefusal(question, new Date(Date.now() - 60_000).toISOString());
    }

    await answer(token, question);

    const service = new AiInsightsService(db());

    expect(questionsIn(await service.unansweredQuestions())).not.toContain(question);

    // …and one after it.
    await seedRefusal(question, new Date(Date.now() + 60_000).toISOString());

    const report = (await service.unansweredQuestions()).items;
    const row = report.find((entry) => entry.question === question);

    expect(row).toBeDefined();
    // One, not four: the three the answer covered are not outstanding.
    expect(row!.asks).toBe(1);
    expect(row!.answeredAt).not.toBeNull();
    // It leads the report — a written answer that is not being found outranks an unwritten one.
    expect(report[0]!.question).toBe(question);
  });
});

describe('dismissing and reopening', () => {
  /**
   * The disposition for gibberish and test questions — the rows nobody will ever write an entry
   * for, which otherwise sit in the backlog for the life of the deployment.
   *
   * Unlike an answer it has no document, so nothing can make it lapse. That is why it is
   * admin-only, and why the asked-again case below must *not* bring it back.
   */
  it('removes a dismissed question permanently, even when it is asked again', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const question = `asdfgh ${uuid()}`;

    await seedRefusal(question);

    const dismissed = await api('POST', '/admin/knowledge-questions/dismiss', {
      token,
      body: { question },
    });

    expect(dismissed.status).toBe(201);

    const service = new AiInsightsService(db());

    expect(questionsIn(await service.unansweredQuestions())).not.toContain(question);

    await seedRefusal(question, new Date(Date.now() + 60_000).toISOString());

    expect(questionsIn(await service.unansweredQuestions())).not.toContain(question);
  });

  /** A permanent decision needs an undo, or one misclick is permanent too. */
  it('puts a question back on the backlog when its resolution is deleted', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const question = `A question dismissed by mistake ${uuid()}`;

    await seedRefusal(question);
    await api('POST', '/admin/knowledge-questions/dismiss', { token, body: { question } });

    const service = new AiInsightsService(db());
    const resolved = (await service.resolvedQuestions()).items;
    const row = resolved.find((entry) => entry.question === question);

    expect(row).toBeDefined();

    const reopened = await api('DELETE', `/admin/knowledge-question-resolutions/${row!.id}`, {
      token,
    });

    expect(reopened.status).toBe(200);
    // Back with its original ask count — the counts were never stored on the resolution, they are
    // recomputed from `ai_requests` every read.
    expect(questionsIn(await service.unansweredQuestions())).toContain(question);
  });

  /**
   * Two people answering the same question in the same minute is an ordinary Tuesday on a shared
   * backlog, not an exotic race. The unique index turns the second write into an update; without
   * the upsert it would be a constraint violation surfacing as a 500 on a successful save.
   */
  it('treats a second answer to the same question as an update, not a duplicate', async () => {
    const first = await createStaffUser({ role: 'admin' });
    const second = await createStaffUser({ role: 'admin' });
    const question = `Who do I contact about scholarships? ${uuid()}`;

    await seedRefusal(question);

    await answer(await login(first), question);
    await answer(await login(second), question);

    const rows = await db()
      .select()
      .from(knowledgeQuestionResolutions)
      .where(eq(knowledgeQuestionResolutions.question, question));

    expect(rows).toHaveLength(1);
    // The later decision wins, and one resolver is named rather than two rows disagreeing.
    expect(rows[0]!.resolvedBy).toBe(second.id);
  });

  /**
   * Backlog text is not typed by a person, and the longest rows are the ones most in need of
   * attention.
   *
   * `ExplanationService` builds its retrieval query by joining catalog text — a program, its
   * college, description fragments — which runs well past the 1000 characters a *chat* question is
   * capped at. Those failures land on the same report. A cap sized for the typed field would 422
   * on precisely them, and the failure would look like the feature being broken rather than a
   * validation mismatch.
   */
  it('accepts a backlog question far longer than a typed one', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const question = `${'BS Information Technology at a college with a very long description. '.repeat(20)}${uuid()}`;

    expect(question.length).toBeGreaterThan(1000);

    await seedRefusal(question);

    const dismissed = await api('POST', '/admin/knowledge-questions/dismiss', {
      token,
      body: { question },
    });

    expect(dismissed.status).toBe(201);
    expect(questionsIn(await new AiInsightsService(db()).unansweredQuestions())).not.toContain(
      question,
    );
  });

  it('refuses to let a counselor dismiss a question for the whole school', async () => {
    const counselor = await createStaffUser({ role: 'counselor' });
    const token = await login(counselor);

    const response = await api('POST', '/counselor/knowledge-questions/dismiss', {
      token,
      body: { question: 'anything' },
    });

    // Not mounted on the counselor prefix at all — dismissing is admin-only by construction.
    expect(response.status).toBe(404);
  });
});

describe('a counselor as a global contributor', () => {
  /**
   * The contribution half: what a counselor writes lands in the one shared corpus, exactly like an
   * admin's entry. There is no per-counselor retrieval scope and this does not create one.
   */
  it('lets a counselor write an entry that enters the shared corpus', async () => {
    const counselor = await createStaffUser({ role: 'counselor' });
    const token = await login(counselor);

    const response = await api('POST', '/counselor/knowledge-entries', {
      token,
      body: {
        type: 'qa',
        question: 'What is the deadline for the scholarship form?',
        answer: 'The deadline is 30 April, submitted to the guidance office.',
      },
    });

    expect(response.status).toBe(201);
    expect(response.body.data.visibility).toBe('GLOBAL');
    expect(response.body.data.added_by).toBe(counselor.id);
  });

  /** The custody half: a counselor's library is their own work, an admin's is everything. */
  it('shows a counselor only their own entries, and an admin both', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const counselor = await createStaffUser({ role: 'counselor' });
    const adminToken = await login(admin);
    const counselorToken = await login(counselor);

    const adminTitle = `Admin note ${uuid().slice(0, 8)}`;
    const counselorTitle = `Counselor note ${uuid().slice(0, 8)}`;

    await api('POST', '/admin/knowledge-entries', {
      token: adminToken,
      body: { type: 'text', title: adminTitle, body: 'Written by the administrator.' },
    });
    await api('POST', '/counselor/knowledge-entries', {
      token: counselorToken,
      body: { type: 'text', title: counselorTitle, body: 'Written by the counselor.' },
    });

    const mine = await api('GET', '/counselor/knowledge-documents?per_page=100', {
      token: counselorToken,
    });
    const titles = mine.body.data.items.map((item: { title: string }) => item.title);

    expect(titles).toContain(counselorTitle);
    expect(titles).not.toContain(adminTitle);

    const all = await api('GET', '/admin/knowledge-documents?per_page=100', { token: adminToken });
    const allTitles = all.body.data.items.map((item: { title: string }) => item.title);

    expect(allTitles).toContain(counselorTitle);
    expect(allTitles).toContain(adminTitle);
  });

  /** Authorship travels, because "who wrote this" is what an admin needs before they can act. */
  it('names the author and their role on every listed entry', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const counselor = await createStaffUser({ role: 'counselor' });
    const counselorToken = await login(counselor);
    const title = `Attributed note ${uuid().slice(0, 8)}`;

    await api('POST', '/counselor/knowledge-entries', {
      token: counselorToken,
      body: { type: 'text', title, body: 'Written by the counselor.' },
    });

    const listed = await api('GET', '/admin/knowledge-documents?per_page=100', {
      token: await login(admin),
    });
    const row = listed.body.data.items.find((item: { title: string }) => item.title === title);

    expect(row).toBeDefined();
    expect(row.added_by).toBe(counselor.id);
    expect(row.added_by_role).toBe('counselor');
    // Against the `users` row rather than a literal: the name is what the join resolved, and a
    // hard-coded string would keep passing if the join silently started returning somebody else's.
    expect(row.added_by_name).toBe((await findUser(counselor.id))!.name);
  });

  /**
   * The boundary. Contributing globally must not come with the ability to quietly rewrite the
   * school's published answers — and the refusal is a 404 rather than a 403, so "not yours" and
   * "not real" stay indistinguishable and the status code cannot be used to enumerate colleagues'
   * work.
   */
  it("refuses a counselor editing, archiving or reading another author's entry", async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const counselor = await createStaffUser({ role: 'counselor' });
    const counselorToken = await login(counselor);

    const created = await api('POST', '/admin/knowledge-entries', {
      token: await login(admin),
      body: { type: 'text', title: 'School policy', body: "The administration's own note." },
    });
    const id = created.body.data.id as string;

    const edit = await api('PATCH', `/counselor/knowledge-entries/${id}`, {
      token: counselorToken,
      body: { type: 'text', title: 'School policy', body: 'Rewritten by somebody else.' },
    });
    const archive = await api('DELETE', `/counselor/knowledge-documents/${id}`, {
      token: counselorToken,
    });
    const read = await api('GET', `/counselor/knowledge-documents/${id}/content`, {
      token: counselorToken,
    });

    expect(edit.status).toBe(404);
    expect(archive.status).toBe(404);
    expect(read.status).toBe(404);

    // And the entry is untouched: no archive slipped through on the way to the refusal.
    const [row] = await db()
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, id));

    expect(row!.archivedAt).toBeNull();
    expect(row!.title).toBe('School policy');
  });
});

describe('the counselor backlog is scoped to their own students', () => {
  /**
   * A counselor sees the questions their own students asked, and nobody else's — the same
   * ownership rule `ClassPolicy` applies everywhere, pushed into SQL because this screen
   * aggregates rather than fetching one record to check.
   */
  it('shows a counselor questions from their own class and hides other students', async () => {
    const counselor = await createStaffUser({ role: 'counselor' });
    const counselorToken = await login(counselor);
    const { student } = await classWithStudent(counselorToken);

    const mine = `Does my class get priority enrolment? ${uuid()}`;
    const theirs = `A question from somebody else's student ${uuid()}`;
    const outsider = await createStudentUser();

    await seedRefusal(mine, now(), await studentUserId(student.id));
    await seedRefusal(theirs, now(), outsider.id);

    const response = await api('GET', '/counselor/ai-insights/unanswered', {
      token: counselorToken,
    });

    expect(response.status).toBe(200);

    const questions = response.body.data.items.map((row: { question: string }) => row.question);

    expect(questions).toContain(mine);
    expect(questions).not.toContain(theirs);
  });

  /**
   * A student's *request* is scoped the same way, through the conversation that owns it — the
   * other half of the merge, and easy to leave unscoped because it reaches the student through a
   * join rather than a column.
   */
  it('scopes student knowledge-requests to the counselor as well', async () => {
    const counselor = await createStaffUser({ role: 'counselor' });
    const counselorToken = await login(counselor);
    const { student } = await classWithStudent(counselorToken);
    const outsider = await createStudentUser();

    const mine = `Please add this one ${uuid()}`;
    const theirs = `Somebody else asked for this ${uuid()}`;

    await seedKnowledgeRequest(mine, await studentUserId(student.id));
    await seedKnowledgeRequest(theirs, outsider.id);

    const response = await api('GET', '/counselor/ai-insights/unanswered', {
      token: counselorToken,
    });
    const questions = response.body.data.items.map((row: { question: string }) => row.question);

    expect(questions).toContain(mine);
    expect(questions).not.toContain(theirs);
  });

  /**
   * The screen tells the client what the caller may do rather than letting it infer permissions
   * from a role string — a UI that derives its own permissions is a UI that renders a button the
   * API will refuse.
   */
  it('reports a counselor cannot dismiss or sync, and an admin can', async () => {
    const counselor = await api('GET', '/counselor/ai-insights', {
      token: await login(await createStaffUser({ role: 'counselor' })),
    });
    const admin = await api('GET', '/admin/ai-insights', {
      token: await login(await createStaffUser({ role: 'admin' })),
    });

    expect(counselor.body.data.can).toMatchObject({
      dismiss_questions: false,
      sync_catalog: false,
      see_all_knowledge: false,
    });
    expect(admin.body.data.can).toMatchObject({
      dismiss_questions: true,
      sync_catalog: true,
      see_all_knowledge: true,
    });
  });

  /**
   * `resolved_questions` is scoped by **resolver**, not by student — a counselor's answer is
   * global the moment it is written, so scoping their "what I answered" list by asking student
   * would show them a question they answered and then hide the answer.
   */
  it("shows a counselor the questions they answered, and not a colleague's", async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const counselor = await createStaffUser({ role: 'counselor' });
    const counselorToken = await login(counselor);

    const byCounselor = `Answered by the counselor ${uuid()}`;
    const byAdmin = `Answered by the admin ${uuid()}`;

    await seedRefusal(byCounselor);
    await seedRefusal(byAdmin);

    await api('POST', '/counselor/knowledge-entries', {
      token: counselorToken,
      body: {
        type: 'qa',
        question: byCounselor,
        answer: 'The counselor wrote this answer.',
        resolves_question: byCounselor,
      },
    });
    await answer(await login(admin), byAdmin);

    const response = await api('GET', '/counselor/ai-insights/resolved', {
      token: counselorToken,
    });
    const resolved = response.body.data.items.map(
      (row: { question: string }) => row.question,
    );

    expect(resolved).toContain(byCounselor);
    expect(resolved).not.toContain(byAdmin);
  });
});

describe('telling the student who asked (migration 0033)', () => {
  /**
   * The student pressed "Request to add to knowledge" and, before this, never heard back. They are
   * now told once — however many times they pressed, and however many times the answer is saved.
   */
  it('notifies a requesting student exactly once when their question is answered', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const student = await createStudentUser();
    const question = `Is there a school bus from Loboc? ${uuid()}`;

    // Pressed in two separate conversations.
    await seedKnowledgeRequest(question, student.id);
    await seedKnowledgeRequest(question, student.id);

    await answer(token, question);
    // Re-saved — an edit, or a second person answering. Must not tell the student again.
    await answer(token, question);

    const sent = await db()
      .select()
      .from(notifications)
      .where(eq(notifications.userId, student.id));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toBe('Your question was answered');
    expect(sent[0]!.message).toContain('Is there a school bus from Loboc?');

    // Both of the student's requests are stamped, which is what the panel reads.
    const stamped = await db()
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .innerJoin(chatConversations, eq(chatConversations.id, chatMessages.conversationId))
      .where(
        and(
          eq(chatConversations.studentId, student.id),
          eq(chatMessages.knowledgeRequest, 'REQUESTED'),
          isNotNull(chatMessages.knowledgeAnsweredAt),
        ),
      );

    expect(stamped).toHaveLength(2);
  });

  /** A dismissal is not an answer, and "your question was answered" must never be a lie. */
  it('does not notify anybody when a question is dismissed', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const student = await createStudentUser();
    const question = `qwertyuiop ${uuid()}`;

    await seedKnowledgeRequest(question, student.id);
    await api('POST', '/admin/knowledge-questions/dismiss', {
      token: await login(admin),
      body: { question },
    });

    const sent = await db()
      .select()
      .from(notifications)
      .where(eq(notifications.userId, student.id));

    expect(sent).toHaveLength(0);
  });
});

describe('answering several phrasings at once', () => {
  /**
   * Found on production: "Where is Holy Name University located?", "HNU located" and "location of
   * HNU" were three rows, so one answer left two behind. The author ticks the siblings it covers.
   */
  it('clears every question the author ticked as also answered', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);
    const tag = uuid();
    const main = `Where is Holy Name University located? ${tag}`;
    const sibling = `HNU located ${tag}`;
    const untouched = `location of HNU ${tag}`;

    for (const question of [main, sibling, untouched]) {
      await seedRefusal(question);
    }

    const response = await api('POST', '/admin/knowledge-entries', {
      token,
      body: {
        type: 'qa',
        question: 'Where is Holy Name University located?',
        answer: 'Along J.A. Clarin Street, Tagbilaran City, Bohol.',
        resolves_question: main,
        also_resolves: [sibling],
      },
    });

    expect(response.status).toBe(201);
    expect(response.body.message).toContain('2 questions have been taken off');

    const open = questionsIn(await new AiInsightsService(db()).unansweredQuestions());

    expect(open).not.toContain(main);
    expect(open).not.toContain(sibling);
    // Not ticked, so not claimed — suggestions are never resolved on the author's behalf.
    expect(open).toContain(untouched);
  });
});

/*
 * Paging the backlog used to be tested here, against the `?limit=` + `unanswered_has_more` shape
 * this report had when it was a single growing scroll. That shape is gone: the report is four
 * paginated tabs now, and `test/ai/insights.test.ts` covers page boundaries, the badge/pager
 * agreement and the per_page cap against the endpoints that replaced it. Nothing was dropped —
 * it moved to where the endpoints it exercises now live.
 */

describe('migration 0032 — answers written before the backlog could remember them', () => {
  /**
   * Runs the **real** migration file (from the same `TEST_MIGRATIONS` binding `test/setup.ts`
   * applies) against a Q&A row shaped the way the pre-0031 code left it: the entry, and no
   * resolution. `setup.ts` applies migrations to an empty database, so without this the backfill
   * would only ever be tested against nothing.
   *
   * Last in the file on purpose: the backfill touches every Q&A in this file's shared storage, and
   * nothing after it can then be surprised by a resolution it did not write.
   */
  it('credits an existing Q&A with its question, once, backdated to the entry', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const question = `Where is the registrar's office? ${uuid()}`;
    const documentId = uuid();
    const writtenAt = now();

    await seedRefusal(question, new Date(Date.now() - 60_000).toISOString());
    await db().insert(knowledgeDocuments).values({
      id: documentId,
      uploadedBy: admin.id,
      // Stored with the author's capitalisation and punctuation — the key must still match.
      title: `${question.toUpperCase()}?`,
      fileName: question,
      sourceType: 'qa',
      storagePath: null,
      entityType: null,
      entityId: null,
      contentHash: null,
      processingStatus: 'COMPLETED',
      visibility: 'GLOBAL',
      archivedAt: null,
      createdAt: writtenAt,
      updatedAt: writtenAt,
    });

    const service = new AiInsightsService(db());

    // The production symptom: answered, and still listed.
    expect(questionsIn(await service.unansweredQuestions())).toContain(question);

    const backfill = env.TEST_MIGRATIONS.find((migration) => migration.name.startsWith('0032'));

    expect(backfill).toBeDefined();

    // Twice: a migration that is not idempotent is one bad retry away from a constraint failure.
    for (let run = 0; run < 2; run += 1) {
      for (const statement of backfill!.queries) {
        await env.DB.prepare(statement).run();
      }
    }

    expect(questionsIn(await service.unansweredQuestions())).not.toContain(question);

    const rows = await db()
      .select()
      .from(knowledgeQuestionResolutions)
      .where(eq(knowledgeQuestionResolutions.documentId, documentId));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.resolvedBy).toBe(admin.id);
    // Backdated to the entry, so an ask that arrives after it still surfaces as "asked again".
    expect(rows[0]!.createdAt).toBe(writtenAt);
  });
});

import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import { users } from '@/db/schema';
import { AssessmentBuilderService } from '@/modules/assessment/assessment-builder-service';
import { seedAssessmentInstruments } from '@/modules/assessment/instruments';
import { canAnswerAttempt, canGenerateWithAi } from '@/policies/assessment';

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
 * The §39 authorization matrix, pinned at **both layers** — the route group and the policy — so
 * that a future "admins can do anything" refactor cannot quietly remove either.
 *
 * |                        | student (own) | student (other) | counselor (owns) | counselor (other) | admin |
 * |---|---|---|---|---|---|
 * | view attempt / result  | ✅ | ❌ | ✅ | ❌ | ✅ |
 * | **answer / submit**    | ✅ | ❌ | ❌ | ❌ | **❌** |
 * | reset attempt          | ❌ | ❌ | ✅ | ❌ | ✅ |
 * | AI-generate RIASEC/SCCT| ❌ | ❌ | ❌ | ❌ | **❌ always** |
 *
 * **The two bolded cells are the point of this file.** The rest is ordinary role-plus-ownership.
 */

let admin: StaffUserFixture;
let adminRow: any;
let adminToken: string;
let counselor: StaffUserFixture;
let counselorToken: string;
let riasecVersionId: string;

beforeAll(async () => {
  admin = await createStaffUser({ role: 'admin' });
  adminToken = await login(admin);
  counselor = await createStaffUser({ role: 'counselor' });
  counselorToken = await login(counselor);

  [adminRow] = await db().select().from(users).where(eq(users.id, admin.id)).limit(1);

  const seeded = await seedAssessmentInstruments(db(), adminRow);
  riasecVersionId = seeded.riasecVersionId!;
});

describe('answering: the one rule with no admin branch', () => {
  /**
   * **An assessment result that somebody else could have filled in is not an assessment result.**
   *
   * A counselor may *read* their student's attempt — that is their job — and may never answer on
   * their behalf; nor may an admin. Every recommendation downstream is computed from these
   * answers, so this is the cell that most needs a test, and the one a well-meaning refactor is
   * most likely to remove.
   */
  it('refuses a counselor answering on a student’s behalf', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const assignment = await assignVersion(counselorToken, classRoom.id, riasecVersionId);

    const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });

    const attempt = started.body.data;

    const response = await api('POST', `/student/attempts/${attempt.id}/answers`, {
      token: counselorToken,
      body: {
        question_id: attempt.questions[0].id,
        selected_option_id: attempt.questions[0].options[4].id,
      },
    });

    // The route group refuses first: /student is `student`-only, so a counselor never even
    // reaches the policy. Both layers hold — that is the point of pinning it at both.
    expect(response.status).toBe(403);
  });

  it('refuses an admin answering on a student’s behalf', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const assignment = await assignVersion(counselorToken, classRoom.id, riasecVersionId);

    const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });

    const attempt = started.body.data;

    const response = await api('POST', `/student/attempts/${attempt.id}/answers`, {
      token: adminToken,
      body: {
        question_id: attempt.questions[0].id,
        selected_option_id: attempt.questions[0].options[4].id,
      },
    });

    expect(response.status).toBe(403);
  });

  /** And at the policy layer, directly — where the absent admin branch actually lives. */
  it('has no admin branch in the policy itself', () => {
    const attempt = { studentId: 'student-1' } as any;

    expect(canAnswerAttempt({ id: 'student-1', role: 'student' } as any, attempt)).toBe(true);
    expect(canAnswerAttempt({ id: 'student-2', role: 'student' } as any, attempt)).toBe(false);
    expect(canAnswerAttempt({ id: 'c-1', role: 'counselor' } as any, attempt)).toBe(false);
    // The cell that matters.
    expect(canAnswerAttempt({ id: 'a-1', role: 'admin' } as any, attempt)).toBe(false);
  });

  it('refuses one student answering another student’s attempt', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const other = await classWithStudent(counselorToken, 'Maria Santos');
    const assignment = await assignVersion(counselorToken, classRoom.id, riasecVersionId);

    const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });

    const response = await api('POST', `/student/attempts/${started.body.data.id}/answers`, {
      token: other.studentToken,
      body: {
        question_id: started.body.data.questions[0].id,
        selected_option_id: started.body.data.questions[0].options[0].id,
      },
    });

    // 404 — "not yours" and "not real" are indistinguishable from outside.
    expect(response.status).toBe(404);
  });
});

describe('the AI exclusion (§5) — checked before ownership', () => {
  /**
   * **RIASEC and SCCT can never be AI-generated or AI-edited**, "in v1 or any deferred future
   * scope — a permanent architectural rule, not a temporary limitation".
   *
   * The category check runs **first, before ownership**, and that ordering *is* the rule rather
   * than a stylistic preference: it is what makes the refusal apply to an admin who owns the
   * template outright. An ownership-first version would read almost identically and would quietly
   * grant the exception to the one role that must not have it.
   *
   * The AI endpoints are Phase 5b. The rule and its test land now, while the reason is fresh —
   * §6 requires exactly this: "rejected by the backend, not just hidden by the UI".
   */
  it('refuses even an admin who created the RIASEC template', async () => {
    const builder = new AssessmentBuilderService(db());
    const templates = await builder.listTemplatesFor(adminRow);

    const riasec = templates.find((t) => t.category === 'RIASEC')!;
    const scct = templates.find((t) => t.category === 'SCCT')!;

    // The admin *is* the creator — ownership passes, and it does not matter.
    expect(riasec.creatorId).toBe(admin.id);
    expect(canGenerateWithAi(adminRow, riasec)).toBe(false);
    expect(canGenerateWithAi(adminRow, scct)).toBe(false);
  });

  it('permits AI generation on a CUSTOM template the admin owns', async () => {
    const builder = new AssessmentBuilderService(db());

    const custom = await builder.createTemplate(adminRow, {
      category: 'CUSTOM',
      title: `Custom ${crypto.randomUUID().slice(0, 8)}`,
    });

    expect(canGenerateWithAi(adminRow, custom)).toBe(true);
  });

  it('refuses a counselor on someone else’s CUSTOM template', async () => {
    const builder = new AssessmentBuilderService(db());
    const [counselorRow] = await db().select().from(users).where(eq(users.id, counselor.id));

    const custom = await builder.createTemplate(adminRow, {
      category: 'CUSTOM',
      title: `Someone else's ${crypto.randomUUID().slice(0, 8)}`,
    });

    expect(canGenerateWithAi(counselorRow!, custom)).toBe(false);
  });
});

describe('reading results', () => {
  it('lets the owning counselor see their class’s results', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const assignment = await assignVersion(counselorToken, classRoom.id, riasecVersionId);

    const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });

    await answerAll(studentToken, started.body.data, () => 4);
    await api('POST', `/student/attempts/${started.body.data.id}/submit`, { token: studentToken });

    const results = await api('GET', `/counselor/classes/${classRoom.id}/results`, {
      token: counselorToken,
    });

    expect(results.status).toBe(200);
    expect(results.body.data).toHaveLength(1);
    expect(results.body.data[0].result.result_code).toBeTruthy();
  });

  it('404s another counselor asking for that class’s results', async () => {
    const stranger = await createStaffUser({ role: 'counselor' });
    const strangerToken = await login(stranger);

    const { classRoom } = await classWithStudent(counselorToken);

    const response = await api('GET', `/counselor/classes/${classRoom.id}/results`, {
      token: strangerToken,
    });

    expect(response.status).toBe(404);
  });

  /** The route group is `student`-only, so staff cannot reach a route that means "mine". */
  it('refuses staff on the student routes entirely', async () => {
    for (const token of [counselorToken, adminToken]) {
      expect((await api('GET', '/student/assignments', { token })).status).toBe(403);
      expect((await api('GET', '/student/results', { token })).status).toBe(403);
      expect((await api('GET', '/student/profile', { token })).status).toBe(403);
    }
  });

  /** And the reset is staff-only — a student cannot undo a result they disliked. */
  it('refuses a student resetting their own attempt', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const assignment = await assignVersion(counselorToken, classRoom.id, riasecVersionId);

    const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });

    const response = await api('POST', `/counselor/attempts/${started.body.data.id}/reset`, {
      token: studentToken,
    });

    expect(response.status).toBe(403);
  });
});

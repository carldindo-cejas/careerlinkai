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
 * The player, end to end over HTTP (FULLPLAN §21, §24, §37).
 *
 * These run against instruments installed through the **real** `AssessmentBuilderService` — the
 * same 60-item RIASEC the seeder publishes, through the same confirmation gate. A fixture that
 * hand-wrote a PUBLISHED version would let a broken gate stay green.
 */

let admin: StaffUserFixture;
let counselor: StaffUserFixture;
let counselorToken: string;
let riasecVersionId: string;
let scctVersionId: string;

beforeAll(async () => {
  admin = await createStaffUser({ role: 'admin' });
  counselor = await createStaffUser({ role: 'counselor' });
  counselorToken = await login(counselor);

  const seeded = await seedInstruments(admin);

  riasecVersionId = seeded.riasecVersionId!;
  scctVersionId = seeded.scctVersionId!;
});

describe('the seeded instruments', () => {
  it('publishes RIASEC with 60 items and SCCT with 30, through the real gate', async () => {
    const response = await api('GET', '/counselor/assessment-templates', {
      token: counselorToken,
    });

    expect(response.status).toBe(200);

    const riasec = response.body.data.find((t: any) => t.category === 'RIASEC');
    const scct = response.body.data.find((t: any) => t.category === 'SCCT');

    expect(riasec.assignable_version.question_count).toBe(60);
    expect(scct.assignable_version.question_count).toBe(30);
    expect(riasec.dimensions.map((d: any) => d.code)).toEqual(['R', 'I', 'A', 'S', 'E', 'C']);
    expect(scct.dimensions.map((d: any) => d.code)).toEqual(['SE', 'OE', 'GO']);
  });

  /** §5: permanently false, for both, forever. The UI reads it; the policy enforces it. */
  it('marks RIASEC and SCCT as never AI-generatable', async () => {
    const response = await api('GET', '/counselor/assessment-templates', {
      token: counselorToken,
    });

    for (const template of response.body.data) {
      expect(template.ai_generatable).toBe(false);
    }
  });
});

describe('the player payload', () => {
  /**
   * **The single most important assertion in this module.**
   *
   * A student who can see that item 14 loads onto Investigative, and that "Strongly Agree" is
   * worth 5, stops answering an interest inventory and starts answering the Holland Code they
   * would like to have. The instrument would then measure what the student wants the software to
   * conclude — and every recommendation downstream is computed from that number.
   *
   * `AssessmentPlayerPage.test.tsx` pins the same thing from the other side of the wire.
   */
  it('never sends a dimension or an option score', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const assignment = await assignVersion(counselorToken, classRoom.id, riasecVersionId);

    const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });

    expect(started.status).toBe(200);

    const serialized = JSON.stringify(started.body.data);

    // Nothing anywhere in the payload names a dimension or carries a score.
    expect(serialized).not.toMatch(/"score"/);
    expect(serialized).not.toMatch(/dimension/i);

    for (const question of started.body.data.questions) {
      expect(question).not.toHaveProperty('dimensions');

      for (const option of question.options) {
        expect(option).not.toHaveProperty('score');
        expect(Object.keys(option).sort()).toEqual(['id', 'label', 'order_number', 'value']);
      }
    }
  });

  /**
   * The one deliberate, limited disclosure: `section_label` groups sixty items into legible
   * chunks. It says which *section* you are in, never what a single item scores.
   */
  it('does send section_label as a progress heading', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const assignment = await assignVersion(counselorToken, classRoom.id, riasecVersionId);

    const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });

    expect(started.body.data.questions[0].section_label).toBe('Realistic');
  });
});

describe('starting an attempt', () => {
  /** A double-tapped Start, or a refresh, must land back in the attempt you already have. */
  it('is idempotent', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const assignment = await assignVersion(counselorToken, classRoom.id, riasecVersionId);

    const first = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });
    const second = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });

    expect(second.status).toBe(200);
    expect(second.body.data.id).toBe(first.body.data.id);
  });

  /**
   * Authorized against **live enrollment, not the token** — a token is a session, an enrollment
   * is a fact, and the fact is what decides this.
   */
  it('is refused for a student who is not enrolled in the class', async () => {
    const { classRoom } = await classWithStudent(counselorToken);
    const other = await classWithStudent(counselorToken, 'Maria Santos');
    const assignment = await assignVersion(counselorToken, classRoom.id, riasecVersionId);

    // A student from a *different* class, holding a perfectly valid token of their own.
    const response = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: other.studentToken,
    });

    // 404, not 403 — "not yours" and "not real" are indistinguishable from outside.
    expect(response.status).toBe(404);
  });
});

describe('answering', () => {
  it('upserts — changing your mind updates the answer rather than stacking a second one', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const assignment = await assignVersion(counselorToken, classRoom.id, riasecVersionId);

    const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });

    const attempt = started.body.data;
    const question = attempt.questions[0];

    await api('POST', `/student/attempts/${attempt.id}/answers`, {
      token: studentToken,
      body: { question_id: question.id, selected_option_id: question.options[0].id },
    });
    await api('POST', `/student/attempts/${attempt.id}/answers`, {
      token: studentToken,
      body: { question_id: question.id, selected_option_id: question.options[4].id },
    });

    const reloaded = await api('GET', `/student/attempts/${attempt.id}`, { token: studentToken });

    const answers = reloaded.body.data.answers.filter(
      (a: any) => a.question_id === question.id,
    );

    expect(answers).toHaveLength(1);
    expect(answers[0].selected_option_id).toBe(question.options[4].id);
  });

  /**
   * A client that could POST its own score would be scoring its own assessment. The schema is
   * `.strict()`, so the attempt is *refused* rather than silently ignored.
   */
  it('refuses a client-supplied score outright', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const assignment = await assignVersion(counselorToken, classRoom.id, riasecVersionId);

    const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });

    const attempt = started.body.data;
    const question = attempt.questions[0];

    const response = await api('POST', `/student/attempts/${attempt.id}/answers`, {
      token: studentToken,
      body: {
        question_id: question.id,
        selected_option_id: question.options[0].id,
        score: 5,
      },
    });

    expect(response.status).toBe(422);
  });

  it('refuses an option that does not belong to the question', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const assignment = await assignVersion(counselorToken, classRoom.id, riasecVersionId);

    const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });

    const attempt = started.body.data;

    const response = await api('POST', `/student/attempts/${attempt.id}/answers`, {
      token: studentToken,
      body: {
        question_id: attempt.questions[0].id,
        // An option from a different question entirely.
        selected_option_id: attempt.questions[1].options[0].id,
      },
    });

    expect(response.status).toBe(422);
  });
});

describe('submitting', () => {
  /**
   * **This block is what makes §24's prorating rule safe.** Prorating is right for an *optional*
   * question and catastrophic for a required one: without the block a student could answer one
   * Investigative item with a 5, skip the other 59, and walk out with a perfect and entirely
   * meaningless `I`.
   */
  it('is blocked while any required question is unanswered, with a count', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const assignment = await assignVersion(counselorToken, classRoom.id, riasecVersionId);

    const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });

    const attempt = started.body.data;
    const question = attempt.questions[0];

    await api('POST', `/student/attempts/${attempt.id}/answers`, {
      token: studentToken,
      body: { question_id: question.id, selected_option_id: question.options[4].id },
    });

    const response = await api('POST', `/student/attempts/${attempt.id}/submit`, {
      token: studentToken,
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.answers[0]).toMatch(/59 required question/);
  });

  /**
   * The §57 exit demo, in a test: a student completes RIASEC and gets a Holland Code plus a
   * per-dimension breakdown. The answers below are shaped so the code is predictable — every
   * Investigative item "Strongly Agree" (5), every Artistic item "Agree" (4), everything else
   * "Strongly Disagree" (1) — which must produce I first, A second.
   */
  it('scores inline and returns the result in the submit response', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const assignment = await assignVersion(counselorToken, classRoom.id, riasecVersionId);

    const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });

    const attempt = started.body.data;

    await answerAll(studentToken, attempt, (question) => {
      if (question.section_label === 'Investigative') return 4; // score 5
      if (question.section_label === 'Artistic') return 3; // score 4
      return 0; // score 1
    });

    const response = await api('POST', `/student/attempts/${attempt.id}/submit`, {
      token: studentToken,
    });

    expect(response.status).toBe(200);

    const result = response.body.data;

    // I = 50/50 = 100, A = 40/50 = 80, the rest = 10/50 = 20.
    // Top three, tie-broken canonically (R > I > A > S > E > C): I, A, then R.
    expect(result.result.result_code).toBe('IAR');

    const investigative = result.dimensions.find((d: any) => d.code === 'I');

    expect(investigative.normalized_score).toBe('100.00');
    expect(investigative.interpretation).toBe('High Interest');
    expect(investigative.name).toBe('Investigative');
  });

  it('refuses a second submission', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const assignment = await assignVersion(counselorToken, classRoom.id, riasecVersionId);

    const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });

    await answerAll(studentToken, started.body.data, () => 4);
    await api('POST', `/student/attempts/${started.body.data.id}/submit`, { token: studentToken });

    const second = await api('POST', `/student/attempts/${started.body.data.id}/submit`, {
      token: studentToken,
    });

    expect(second.status).toBe(422);
  });

  /** §23: SCCT produces a composite, not a code — and the summary carries no number to parse. */
  it('produces an SCCT summary with no result code and no digits in the prose', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const assignment = await assignVersion(counselorToken, classRoom.id, scctVersionId);

    const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });

    await answerAll(studentToken, started.body.data, () => 4); // Every item "Strongly Agree".

    const response = await api('POST', `/student/attempts/${started.body.data.id}/submit`, {
      token: studentToken,
    });

    const result = response.body.data.result;

    expect(result.result_code).toBeNull();
    expect(result.overall_summary).toBe('High Career Confidence.');
    expect(result.overall_summary).not.toMatch(/\d/);
  });
});

describe('results', () => {
  it('lists only SCORED attempts — an in-progress one never appears', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const assignment = await assignVersion(counselorToken, classRoom.id, riasecVersionId);

    await api('POST', `/student/assignments/${assignment.id}/start`, { token: studentToken });

    const results = await api('GET', '/student/results', { token: studentToken });

    expect(results.status).toBe(200);
    expect(results.body.data).toHaveLength(0);
  });
});

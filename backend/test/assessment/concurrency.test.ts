import { beforeAll, describe, expect, it } from 'vitest';

import {
  api,
  assignVersion,
  classWithStudent,
  createStaffUser,
  login,
  seedInstruments,
} from '../helpers';

/**
 * Concurrent-use races on the player (audit H4).
 *
 * Two tabs, a double-tapped button, a retried request — normal, expected concurrency that used to
 * surface as raw 500s where a check-then-insert lost its race against a unique index. These assert
 * the *outcome* rather than forcing a precise interleaving (which Miniflare does not guarantee):
 * whatever the ordering, no request 500s and the final state is consistent.
 */

let counselorToken: string;
let riasecVersionId: string;

beforeAll(async () => {
  const admin = await createStaffUser({ role: 'admin' });
  const counselor = await createStaffUser({ role: 'counselor' });
  counselorToken = await login(counselor);

  const seeded = await seedInstruments(admin);
  riasecVersionId = seeded.riasecVersionId!;
});

describe('double-tapped Start (H4 — the partial unique index)', () => {
  it('lands both taps in the same attempt, never a 500', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const assignment = await assignVersion(counselorToken, classRoom.id, riasecVersionId);

    const [first, second] = await Promise.all([
      api('POST', `/student/assignments/${assignment.id}/start`, { token: studentToken }),
      api('POST', `/student/assignments/${assignment.id}/start`, { token: studentToken }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Idempotent: both resolve to the one live attempt, not two.
    expect(first.body.data.id).toBe(second.body.data.id);
  });
});

describe('concurrent saveAnswer for one question (H4 — the upsert)', () => {
  it('accepts both and stores exactly one answer, never a 500', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const assignment = await assignVersion(counselorToken, classRoom.id, riasecVersionId);

    const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });
    const attempt = await api('GET', `/student/attempts/${started.body.data.id}`, {
      token: studentToken,
    });

    const question = attempt.body.data.questions[0];
    const [optionA, optionB] = question.options;

    // The same question, answered two different ways at once — the classic changed-my-mind race.
    const [first, second] = await Promise.all([
      api('POST', `/student/attempts/${started.body.data.id}/answers`, {
        token: studentToken,
        body: { question_id: question.id, selected_option_id: optionA.id },
      }),
      api('POST', `/student/attempts/${started.body.data.id}/answers`, {
        token: studentToken,
        body: { question_id: question.id, selected_option_id: optionB.id },
      }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // Exactly one answer for the question, and it is one of the two we sent (the last writer wins).
    const reload = await api('GET', `/student/attempts/${started.body.data.id}`, {
      token: studentToken,
    });
    const answers = (reload.body.data.answers as any[]).filter(
      (a) => a.question_id === question.id,
    );

    expect(answers).toHaveLength(1);
    expect([optionA.id, optionB.id]).toContain(answers[0].selected_option_id);
  });
});

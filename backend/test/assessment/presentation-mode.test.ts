import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import { applyQuestionOrder, shuffle } from '@/modules/assessment/assessment-attempt-service';

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
 * **Sequential and random delivery** (prompt §6), and the property that makes random safe: the
 * order is dealt once per *attempt* and never re-dealt.
 *
 * The three things that could go wrong with a naive implementation, each pinned below:
 *
 *   1. **Re-shuffling on every read.** Previous would land the student on a different question than
 *      the one they came from, and a refresh would re-deal the whole instrument. The order lives on
 *      `assessment_attempts.question_order`, so every read of the attempt traverses one list.
 *   2. **Two students drawing the same sequence.** `Math.random()` is seeded per isolate, and two
 *      students starting on the same warm Worker can draw identically. `shuffle` uses
 *      `crypto.getRandomValues`.
 *   3. **Order leaking into the score.** It cannot: the engine reads the answer's snapshotted score
 *      joined to the question's dimension mappings, and neither knows the sequence. Asserted rather
 *      than assumed — the same answers produce the same Holland Code under both modes.
 */

let admin: StaffUserFixture;
let adminToken: string;
let counselor: StaffUserFixture;
let counselorToken: string;
let riasecTemplateId: string;
let riasecVersionId: string;

beforeAll(async () => {
  admin = await createStaffUser({ role: 'admin' });
  adminToken = await login(admin);

  counselor = await createStaffUser({ role: 'counselor' });
  counselorToken = await login(counselor);

  const seeded = await seedInstruments(admin);

  riasecVersionId = seeded.riasecVersionId!;

  const list = await api('GET', '/assessments?per_page=100', { token: adminToken });

  riasecTemplateId = list.body.data.items.find((row: any) => row.category === 'RIASEC').id;
});

async function setMode(mode: 'SEQUENTIAL' | 'RANDOM'): Promise<void> {
  const response = await api('PATCH', `/assessment-templates/${riasecTemplateId}/presentation-mode`, {
    token: adminToken,
    body: { presentation_mode: mode },
  });

  if (response.status !== 200) {
    throw new Error(`Could not set mode: ${JSON.stringify(response.body)}`);
  }
}

/** Start a fresh attempt for a brand-new student, and return the player payload. */
async function startAttempt(): Promise<{ attempt: any; studentToken: string }> {
  const { classRoom, studentToken } = await classWithStudent(counselorToken);
  const assignment = await assignVersion(counselorToken, classRoom.id, riasecVersionId);
  const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
    token: studentToken,
  });

  expect(started.status).toBe(200);

  return { attempt: started.body.data, studentToken };
}

const ids = (attempt: any): string[] => attempt.questions.map((q: any) => q.id);

describe('the setting itself', () => {
  it('defaults to SEQUENTIAL and is switchable from the list payload', async () => {
    const before = await api('GET', '/assessments?per_page=100', { token: adminToken });
    const row = before.body.data.items.find((r: any) => r.id === riasecTemplateId);

    expect(row.presentation_mode).toBe('SEQUENTIAL');

    const response = await api('PATCH', `/assessment-templates/${riasecTemplateId}/presentation-mode`, {
      token: adminToken,
      body: { presentation_mode: 'RANDOM' },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.presentation_mode).toBe('RANDOM');

    await setMode('SEQUENTIAL');
  });

  /**
   * The point of putting the column on the template rather than the version. RIASEC's only version
   * is PUBLISHED and frozen, so a version-level setting would be unswitchable without publishing a
   * v2 — which is the "open multiple configuration screens" the prompt asks us to remove.
   */
  it('is permitted on a published instrument, where content edits are not', async () => {
    await setMode('RANDOM');

    const blocked = await api('POST', `/assessment-versions/${riasecVersionId}/questions`, {
      token: adminToken,
      body: {
        questions: [
          {
            question_text: 'Should not be allowed.',
            question_type: 'LIKERT',
            options: [
              { label: 'Yes', value: 'y', score: 1 },
              { label: 'No', value: 'n', score: 0 },
            ],
            dimension_codes: [],
          },
        ],
      },
    });

    expect(blocked.status).toBe(422);

    await setMode('SEQUENTIAL');
  });

  it('rejects an unknown mode', async () => {
    const response = await api('PATCH', `/assessment-templates/${riasecTemplateId}/presentation-mode`, {
      token: adminToken,
      body: { presentation_mode: 'SHUFFLED' },
    });

    expect(response.status).toBe(422);
  });
});

describe('SEQUENTIAL', () => {
  it('serves the authored order and stores no per-attempt order', async () => {
    await setMode('SEQUENTIAL');

    const { attempt } = await startAttempt();

    // The payload's own `order_number`s come back 1..60 in sequence.
    expect(attempt.questions.map((q: any) => q.order_number)).toEqual(
      attempt.questions.map((_: any, index: number) => index + 1),
    );

    /**
     * And nothing is stored. NULL means "as authored", which is deliberately the same value every
     * attempt taken before migration 0037 carries — so one branch reads both, and a sequential
     * attempt does not accumulate a 60-id array that would go stale against a draft being reordered.
     */
    const row = await env.DB.prepare(
      'SELECT question_order AS stored FROM assessment_attempts WHERE id = ?',
    )
      .bind(attempt.id)
      .first<{ stored: string | null }>();

    expect(row?.stored ?? null).toBeNull();
  });
});

describe('RANDOM', () => {
  it('deals a shuffled order that survives a reload of the same attempt', async () => {
    await setMode('RANDOM');

    const { attempt, studentToken } = await startAttempt();
    const dealt = ids(attempt);

    // It is genuinely shuffled — the payload is not the authored 1..60 sequence.
    expect(attempt.questions.map((q: any) => q.order_number)).not.toEqual(
      attempt.questions.map((_: any, index: number) => index + 1),
    );

    // Re-reading the attempt (a refresh) must return the identical sequence.
    const reloaded = await api('GET', `/student/attempts/${attempt.id}`, { token: studentToken });

    expect(ids(reloaded.body.data)).toEqual(dealt);

    // And so must a re-`start` — Start is idempotent and resumes the attempt you already have.
    const restarted = await api('POST', `/student/assignments/${attempt.assignment_id}/start`, {
      token: studentToken,
    });

    expect(ids(restarted.body.data)).toEqual(dealt);

    await setMode('SEQUENTIAL');
  });

  it('gives two students different sequences', async () => {
    await setMode('RANDOM');

    const first = await startAttempt();
    const second = await startAttempt();

    // 60 items: the chance of two independent shuffles matching is 1/60!, which is zero in every
    // practical sense. A failure here means the order is not per-attempt.
    expect(ids(first.attempt)).not.toEqual(ids(second.attempt));

    await setMode('SEQUENTIAL');
  });

  it('shuffles the items and never the answer choices', async () => {
    await setMode('RANDOM');

    const { attempt } = await startAttempt();

    for (const question of attempt.questions) {
      expect(question.options.map((option: any) => option.label)).toEqual([
        'Strongly Agree',
        'Agree',
        'Neither Agree nor Disagree',
        'Disagree',
        'Strongly Disagree',
      ]);
    }

    await setMode('SEQUENTIAL');
  });

  it('scores identically to the sequential delivery of the same answers', async () => {
    // The same response pattern, keyed on the item's section label rather than its position, run
    // once under each mode. If order were reaching the engine, these two would disagree.
    const pick = (question: any) => {
      if (question.section_label === 'Investigative') return 4;
      if (question.section_label === 'Artistic') return 3;

      return 0;
    };

    await setMode('SEQUENTIAL');

    const sequential = await startAttempt();

    await answerAll(sequential.studentToken, sequential.attempt, pick);

    const sequentialResult = await api(
      'POST',
      `/student/attempts/${sequential.attempt.id}/submit`,
      { token: sequential.studentToken },
    );

    await setMode('RANDOM');

    const random = await startAttempt();

    await answerAll(random.studentToken, random.attempt, pick);

    const randomResult = await api('POST', `/student/attempts/${random.attempt.id}/submit`, {
      token: random.studentToken,
    });

    expect(randomResult.status).toBe(200);
    expect(randomResult.body.data.result.result_code).toBe(
      sequentialResult.body.data.result.result_code,
    );
    expect(
      randomResult.body.data.dimensions.map((d: any) => `${d.code}:${d.normalized_score}`).sort(),
    ).toEqual(
      sequentialResult.body.data.dimensions
        .map((d: any) => `${d.code}:${d.normalized_score}`)
        .sort(),
    );

    await setMode('SEQUENTIAL');
  });
});

/**
 * The two pure functions behind all of the above, tested directly because their failure modes are
 * invisible from the endpoint: a shuffle that is subtly non-uniform still passes every test above,
 * and an ordering function that drops a question only fails at submit, hours later.
 */
describe('applyQuestionOrder', () => {
  const questions = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('returns the authored order when no order was dealt', () => {
    expect(applyQuestionOrder(questions, null).map((q) => q.id)).toEqual(['a', 'b', 'c']);
    expect(applyQuestionOrder(questions, []).map((q) => q.id)).toEqual(['a', 'b', 'c']);
  });

  it('applies the dealt order', () => {
    expect(applyQuestionOrder(questions, ['c', 'a', 'b']).map((q) => q.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  /**
   * The correctness condition, not defensive padding: a question missing from the stored array must
   * still be delivered, or a student is refused at submit for not answering an item they were never
   * shown.
   */
  it('still delivers every question when the stored order is incomplete or stale', () => {
    expect(applyQuestionOrder(questions, ['c']).map((q) => q.id)).toEqual(['c', 'a', 'b']);
    expect(applyQuestionOrder(questions, ['zz', 'b']).map((q) => q.id)).toEqual(['b', 'a', 'c']);
    expect(applyQuestionOrder(questions, ['a', 'a', 'a']).map((q) => q.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('shuffle', () => {
  it('is a permutation — nothing gained, nothing lost', () => {
    const input = Array.from({ length: 60 }, (_, index) => index);
    const output = shuffle(input);

    expect(output).toHaveLength(60);
    expect([...output].sort((a, b) => a - b)).toEqual(input);
    expect(input).toEqual(Array.from({ length: 60 }, (_, index) => index)); // not mutated
  });

  it('actually moves things', () => {
    const input = Array.from({ length: 60 }, (_, index) => index);

    // One shuffle landing on the identity permutation is possible (p = 1/60!); twenty in a row is
    // not, so this fails only if the shuffle is a no-op.
    const moved = Array.from({ length: 20 }, () => shuffle(input)).some(
      (output) => output.join(',') !== input.join(','),
    );

    expect(moved).toBe(true);
  });
});

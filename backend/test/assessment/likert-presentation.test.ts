import { env } from 'cloudflare:test';
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
 * **The Likert scale is presented positive-first, and the scores did not move** (prompt §8A,
 * migration 0037).
 *
 * The requested order is Strongly Agree (5) at the top down to Strongly Disagree (1) at the bottom,
 * on every surface that draws the options. The risk in a change like this is not that the order
 * comes out wrong — that is visible immediately — but that the *scores* silently follow the
 * positions, so an instrument keeps working and quietly measures the opposite of what it measured
 * last term. Every assertion below is aimed at that second thing.
 *
 * `order_number` is where an option is drawn; `score` is what it is worth; `value` is the stored
 * answer key. Only the first one changed.
 */

let admin: StaffUserFixture;
let adminToken: string;
let counselorToken: string;
let riasecVersionId: string;
let scctVersionId: string;

/** §8A's exact wording, top to bottom. */
const EXPECTED_LABELS = [
  'Strongly Agree',
  'Agree',
  'Neither Agree nor Disagree',
  'Disagree',
  'Strongly Disagree',
];

beforeAll(async () => {
  admin = await createStaffUser({ role: 'admin' });
  adminToken = await login(admin);

  const counselor = await createStaffUser({ role: 'counselor' });
  counselorToken = await login(counselor);

  const seeded = await seedInstruments(admin);

  riasecVersionId = seeded.riasecVersionId!;
  scctVersionId = seeded.scctVersionId!;
});

async function playerQuestions(versionId: string): Promise<any[]> {
  const { classRoom, studentToken } = await classWithStudent(counselorToken);
  const assignment = await assignVersion(counselorToken, classRoom.id, versionId);
  const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
    token: studentToken,
  });

  expect(started.status).toBe(200);

  return started.body.data.questions;
}

describe('what the student is shown', () => {
  it('draws RIASEC’s choices positive-first, on every item', async () => {
    const questions = await playerQuestions(riasecVersionId);

    expect(questions).toHaveLength(60);

    for (const question of questions) {
      expect(question.options.map((option: any) => option.label)).toEqual(EXPECTED_LABELS);
    }
  });

  it('draws SCCT’s choices in the same order', async () => {
    const questions = await playerQuestions(scctVersionId);

    expect(questions).toHaveLength(30);

    for (const question of questions) {
      expect(question.options.map((option: any) => option.label)).toEqual(EXPECTED_LABELS);
    }
  });

  /**
   * The student payload carries no score at all (§37) — that is what the `value` assertion is
   * standing in for here, and why the player cannot itself sort by score.
   */
  it('still withholds the score from the student, while keeping the answer key aligned', async () => {
    const [question] = await playerQuestions(riasecVersionId);

    expect(question.options.map((option: any) => option.value)).toEqual(['5', '4', '3', '2', '1']);

    for (const option of question.options) {
      expect(option).not.toHaveProperty('score');
    }
  });
});

describe('what the author is shown', () => {
  it('draws the same order in the builder, with the scores still attached correctly', async () => {
    const review = await api('GET', `/assessment-versions/${riasecVersionId}`, {
      token: adminToken,
    });

    expect(review.status).toBe(200);

    const [question] = review.body.data.questions;

    expect(question.options.map((option: any) => option.label)).toEqual(EXPECTED_LABELS);
    // **The assertion this file exists for.** Position moved; the scores did not follow it.
    expect(question.options.map((option: any) => option.score)).toEqual([5, 4, 3, 2, 1]);
    expect(question.options.map((option: any) => option.order_number)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('scoring is unaffected', () => {
  /**
   * The end-to-end version of the same claim. "Strongly Agree on every Investigative item" has to
   * produce a top-of-scale Investigative score — whether Strongly Agree is drawn first or last.
   */
  it('scores a top-of-scale response as top of scale', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const assignment = await assignVersion(counselorToken, classRoom.id, riasecVersionId);
    const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
      token: studentToken,
    });

    // `answerAll`'s index is a response *level*, lowest score first — see the helper.
    await answerAll(studentToken, started.body.data, (question) =>
      question.section_label === 'Investigative' ? 4 : 0,
    );

    const submitted = await api('POST', `/student/attempts/${started.body.data.id}/submit`, {
      token: studentToken,
    });

    expect(submitted.status).toBe(200);

    const dimensions: any[] = submitted.body.data.dimensions;
    const investigative = dimensions.find((dimension) => dimension.code === 'I');

    expect(investigative.normalized_score).toBe('100.00');
    expect(investigative.interpretation).toBe('Very High Interest');
    expect(submitted.body.data.result.result_code?.[0]).toBe('I');
  });
});

describe('the stored rows', () => {
  it('leaves score and value untouched and moves only order_number', async () => {
    const rows = await env.DB.prepare(
      `SELECT o.label AS label, o.value AS value, o.score AS score, o.order_number AS position
         FROM question_options o
         JOIN assessment_questions q ON q.id = o.question_id
        WHERE q.assessment_version_id = ?
        ORDER BY q.order_number, o.order_number
        LIMIT 5`,
    )
      .bind(riasecVersionId)
      .all<{ label: string; value: string; score: number; position: number }>();

    expect(rows.results.map((row) => row.label)).toEqual(EXPECTED_LABELS);
    expect(rows.results.map((row) => row.score)).toEqual([5, 4, 3, 2, 1]);
    expect(rows.results.map((row) => row.value)).toEqual(['5', '4', '3', '2', '1']);
    expect(rows.results.map((row) => row.position)).toEqual([1, 2, 3, 4, 5]);
  });

  /** §8A names the midpoint; "Neutral" is gone from the curated instruments. */
  it('has no "Neutral" left on either curated instrument', async () => {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS total
         FROM question_options o
         JOIN assessment_questions q  ON q.id = o.question_id
         JOIN assessment_versions v   ON v.id = q.assessment_version_id
         JOIN assessment_templates t  ON t.id = v.assessment_template_id
        WHERE t.category IN ('RIASEC', 'SCCT') AND o.label = 'Neutral'`,
    ).first<{ total: number }>();

    expect(row?.total).toBe(0);
  });
});

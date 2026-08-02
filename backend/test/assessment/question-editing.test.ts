import { beforeAll, describe, expect, it } from 'vitest';

import { uuid } from '@/lib/crypto';

import {
  allAuditRows,
  api,
  assessmentTaxonomy,
  createStaffUser,
  login,
  type StaffUserFixture,
} from '../helpers';

/**
 * The builder's per-question editing surface (prompt-driven, v1.6) — what the Google-Forms-style
 * workspace needs the API to be able to do: edit in place, duplicate, delete, reorder.
 *
 * **Every one of these is refused on a PUBLISHED version**, and that is the property most worth
 * testing here. Invariant 1 (§12) is the reason attempts stay meaningful — a published version and
 * everything beneath it is frozen forever — and the new endpoints multiply the number of ways to
 * write to a question by four. A UI that hides the buttons is not the enforcement.
 */

let adminToken: string;
let counselorToken: string;
let counselor: StaffUserFixture;
let taxonomyBody: { assessment_type_id: string; scoring_ids: string[] };

beforeAll(async () => {
  adminToken = await login(await createStaffUser({ role: 'admin' }));
  counselor = await createStaffUser({ role: 'counselor' });
  counselorToken = await login(counselor);

  const taxonomy = await assessmentTaxonomy();
  taxonomyBody = {
    assessment_type_id: taxonomy.assessmentTypeId,
    scoring_ids: taxonomy.scoringIds,
  };
});

const LIKERT = [
  { label: 'Disagree', value: '1', score: 1 },
  { label: 'Neutral', value: '2', score: 2 },
  { label: 'Agree', value: '3', score: 3 },
];

/** A DRAFT version with `count` questions, all mapped to dimension X. */
async function draftWithQuestions(count: number, token = adminToken) {
  const template = await api('POST', '/assessment-templates', {
    token,
    body: { category: 'CUSTOM', title: `Editable ${uuid().slice(0, 8)}`, ...taxonomyBody },
  });

  expect(template.status, JSON.stringify(template.body)).toBe(201);

  const templateId = template.body.data.id as string;

  expect(
    (
      await api('POST', `/assessment-templates/${templateId}/dimensions`, {
        token,
        body: {
          dimensions: [
            { code: 'X', name: 'Dimension X' },
            { code: 'Y', name: 'Dimension Y' },
          ],
        },
      })
    ).status,
  ).toBe(201);

  const version = await api('POST', `/assessment-templates/${templateId}/versions`, {
    token,
    body: { scoring_algorithm: 'WEIGHTED_COMPOSITE' },
  });

  expect(version.status).toBe(201);

  const versionId = version.body.data.id as string;

  expect(
    (
      await api('POST', `/assessment-versions/${versionId}/questions`, {
        token,
        body: {
          questions: Array.from({ length: count }, (_, index) => ({
            question_text: `Question ${index + 1}`,
            question_type: 'LIKERT',
            options: LIKERT,
            dimension_codes: ['X'],
          })),
        },
      })
    ).status,
  ).toBe(201);

  return { templateId, versionId };
}

/** The version's questions, in `order_number` order — the author's view. */
async function questionsOf(versionId: string, token = adminToken) {
  const response = await api('GET', `/assessment-versions/${versionId}`, { token });

  expect(response.status, JSON.stringify(response.body)).toBe(200);

  return response.body.data.questions as any[];
}

async function publish(versionId: string, token = adminToken) {
  const response = await api('POST', `/assessment-versions/${versionId}/publish`, { token });

  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

// ═════════════════════════════════════════════════════════════════════════════════════
describe('editing a question in place', () => {
  it('changes only the fields the request names', async () => {
    const { versionId } = await draftWithQuestions(1);
    const [question] = await questionsOf(versionId);

    const response = await api('PATCH', `/assessment-questions/${question.id}`, {
      token: adminToken,
      body: { question_text: 'Reworded.' },
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.question_text).toBe('Reworded.');
    // Untouched fields survive an auto-save that carried only one of them.
    expect(response.body.data.required).toBe(question.required);
    expect(response.body.data.options).toHaveLength(3);
    expect(response.body.data.dimensions.map((d: any) => d.code)).toEqual(['X']);
  });

  it('toggles required on its own', async () => {
    const { versionId } = await draftWithQuestions(1);
    const [question] = await questionsOf(versionId);

    const response = await api('PATCH', `/assessment-questions/${question.id}`, {
      token: adminToken,
      body: { required: false },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.required).toBe(false);
    expect(response.body.data.question_text).toBe(question.question_text);
  });

  it('replaces the option set wholesale rather than merging it', async () => {
    const { versionId } = await draftWithQuestions(1);
    const [question] = await questionsOf(versionId);

    const response = await api('PATCH', `/assessment-questions/${question.id}`, {
      token: adminToken,
      body: {
        question_type: 'BOOLEAN',
        options: [
          { label: 'No', value: 'no', score: 0 },
          { label: 'Yes', value: 'yes', score: 1 },
        ],
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.question_type).toBe('BOOLEAN');
    // Two, not five: a merge would have left the three Likert options behind.
    expect(response.body.data.options).toHaveLength(2);
    expect(response.body.data.options.map((o: any) => o.label)).toEqual(['No', 'Yes']);
    expect(response.body.data.options.map((o: any) => o.order_number)).toEqual([1, 2]);
  });

  /**
   * §25's rule applied to editing: a mapping the author just typed has been seen by a human — them —
   * so it lands confirmed, exactly as a manually-added question's does. The alternative would be a
   * publish gate blocked on a mapping its own author was staring at when they wrote it.
   */
  it('confirms a mapping the author sets by hand', async () => {
    const { versionId } = await draftWithQuestions(1);
    const [question] = await questionsOf(versionId);

    const response = await api('PATCH', `/assessment-questions/${question.id}`, {
      token: adminToken,
      body: { dimension_codes: ['Y'] },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.dimensions).toHaveLength(1);
    expect(response.body.data.dimensions[0].code).toBe('Y');
    expect(response.body.data.dimensions[0].confirmed).toBe(true);

    // …and the version is publishable, because nothing is left unreviewed.
    const readiness = await api('GET', `/assessment-versions/${versionId}/publish-readiness`, {
      token: adminToken,
    });

    expect(readiness.body.data.remaining).toBe(0);
  });

  it('refuses a dimension code the template does not have', async () => {
    const { versionId } = await draftWithQuestions(1);
    const [question] = await questionsOf(versionId);

    const response = await api('PATCH', `/assessment-questions/${question.id}`, {
      token: adminToken,
      body: { dimension_codes: ['NOPE'] },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.dimension_codes[0]).toMatch(/NOPE/);
  });

  it('refuses an empty request rather than reporting a save that changed nothing', async () => {
    const { versionId } = await draftWithQuestions(1);
    const [question] = await questionsOf(versionId);

    expect(
      (await api('PATCH', `/assessment-questions/${question.id}`, { token: adminToken, body: {} }))
        .status,
    ).toBe(422);
  });

  it('refuses a question set with fewer than two options', async () => {
    const { versionId } = await draftWithQuestions(1);
    const [question] = await questionsOf(versionId);

    const response = await api('PATCH', `/assessment-questions/${question.id}`, {
      token: adminToken,
      body: { options: [{ label: 'Only', value: 'only', score: 1 }] },
    });

    expect(response.status).toBe(422);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════
describe('duplicating a question', () => {
  it('copies the text, options and mappings and appends it last', async () => {
    const { versionId } = await draftWithQuestions(2);
    const [first] = await questionsOf(versionId);

    const response = await api('POST', `/assessment-questions/${first.id}/duplicate`, {
      token: adminToken,
    });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.question_text).toBe(first.question_text);
    expect(response.body.data.options).toHaveLength(3);
    expect(response.body.data.dimensions.map((d: any) => d.code)).toEqual(['X']);

    const questions = await questionsOf(versionId);

    expect(questions).toHaveLength(3);
    // Appended, not inserted beside the original — an author who wanted it elsewhere drags it.
    expect(questions[2].id).toBe(response.body.data.id);
    expect(questions.map((q: any) => q.order_number)).toEqual([1, 2, 3]);
  });

  /**
   * Duplicating is an authoring act by the person doing it. Inheriting `AI_GENERATED` would credit
   * their work to the model, and inheriting an unconfirmed mapping would park a copy in the publish
   * gate as though nobody had looked at it — when the person who made the copy plainly had.
   */
  it('marks the copy MANUAL and its mappings confirmed', async () => {
    const { versionId } = await draftWithQuestions(1);
    const [question] = await questionsOf(versionId);

    const response = await api('POST', `/assessment-questions/${question.id}/duplicate`, {
      token: adminToken,
    });

    expect(response.body.data.source).toBe('MANUAL');
    expect(response.body.data.dimensions.every((d: any) => d.confirmed)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════
describe('deleting a question', () => {
  it('removes it and closes the gap in the numbering', async () => {
    const { versionId } = await draftWithQuestions(4);
    const before = await questionsOf(versionId);

    const response = await api('DELETE', `/assessment-questions/${before[1].id}`, {
      token: adminToken,
    });

    expect(response.status).toBe(200);

    const after = await questionsOf(versionId);

    expect(after).toHaveLength(3);
    expect(after.map((q: any) => q.id)).not.toContain(before[1].id);
    // 1,2,3 — not 1,3,4. A hole here becomes two items claiming position 3 on the next insert.
    expect(after.map((q: any) => q.order_number)).toEqual([1, 2, 3]);
    expect(after.map((q: any) => q.question_text)).toEqual([
      'Question 1',
      'Question 3',
      'Question 4',
    ]);
  });

  /**
   * ASSESSMENT-FIX §7. Every sibling mutator audits; this one did not, and it takes no more than a
   * draft and a wrong click to remove an item somebody else wrote. The row carries the text, because
   * "what did question 2 say before you deleted it" is otherwise unanswerable.
   */
  it('writes an audit row naming who removed it and what it said', async () => {
    const { versionId } = await draftWithQuestions(2);
    const [, second] = await questionsOf(versionId);

    await api('DELETE', `/assessment-questions/${second.id}`, { token: adminToken });

    const rows = await allAuditRows();
    const row = rows.find(
      (entry) => entry.action === 'ASSESSMENT_QUESTION_DELETED' && entry.targetId === second.id,
    );

    expect(row).toBeDefined();
    expect(row!.targetType).toBe('assessment_question');
    expect(row!.oldValues).toMatchObject({ order_number: 2, question_text: 'Question 2' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════
describe('reordering', () => {
  it('rewrites the numbering to the submitted sequence', async () => {
    const { versionId } = await draftWithQuestions(3);
    const before = await questionsOf(versionId);
    const reversed = [...before].reverse().map((q: any) => q.id);

    const response = await api('PUT', `/assessment-versions/${versionId}/question-order`, {
      token: adminToken,
      body: { question_ids: reversed },
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const after = await questionsOf(versionId);

    expect(after.map((q: any) => q.id)).toEqual(reversed);
    expect(after.map((q: any) => q.order_number)).toEqual([1, 2, 3]);
  });

  it('is idempotent — sending the same order twice is the same as once', async () => {
    const { versionId } = await draftWithQuestions(3);
    const order = (await questionsOf(versionId)).map((q: any) => q.id).reverse();

    await api('PUT', `/assessment-versions/${versionId}/question-order`, {
      token: adminToken,
      body: { question_ids: order },
    });
    await api('PUT', `/assessment-versions/${versionId}/question-order`, {
      token: adminToken,
      body: { question_ids: order },
    });

    expect((await questionsOf(versionId)).map((q: any) => q.id)).toEqual(order);
  });

  /**
   * A partial list has no honest meaning: wherever the unlisted items are put, it is a change the
   * author did not ask for. So it is refused rather than best-effort applied.
   */
  it('refuses a partial order', async () => {
    const { versionId } = await draftWithQuestions(3);
    const questions = await questionsOf(versionId);

    const response = await api('PUT', `/assessment-versions/${versionId}/question-order`, {
      token: adminToken,
      body: { question_ids: [questions[0].id, questions[1].id] },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.question_ids[0]).toMatch(/3 expected, 2 received/);
  });

  it('refuses a list with a duplicate id', async () => {
    const { versionId } = await draftWithQuestions(2);
    const questions = await questionsOf(versionId);

    const response = await api('PUT', `/assessment-versions/${versionId}/question-order`, {
      token: adminToken,
      body: { question_ids: [questions[0].id, questions[0].id] },
    });

    expect(response.status).toBe(422);
  });

  it('refuses a list naming a question from another version', async () => {
    const mine = await draftWithQuestions(1);
    const theirs = await draftWithQuestions(1);
    const foreign = (await questionsOf(theirs.versionId))[0];

    const response = await api('PUT', `/assessment-versions/${mine.versionId}/question-order`, {
      token: adminToken,
      body: { question_ids: [foreign.id] },
    });

    expect(response.status).toBe(422);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════
describe('invariant 1 — a published version is frozen', () => {
  it('refuses every one of the four edits', async () => {
    const { versionId } = await draftWithQuestions(2);
    const questions = await questionsOf(versionId);

    await publish(versionId);

    const edit = await api('PATCH', `/assessment-questions/${questions[0].id}`, {
      token: adminToken,
      body: { question_text: 'Rewriting history.' },
    });

    const duplicate = await api('POST', `/assessment-questions/${questions[0].id}/duplicate`, {
      token: adminToken,
    });

    const remove = await api('DELETE', `/assessment-questions/${questions[0].id}`, {
      token: adminToken,
    });

    const reorder = await api('PUT', `/assessment-versions/${versionId}/question-order`, {
      token: adminToken,
      body: { question_ids: [questions[1].id, questions[0].id] },
    });

    for (const response of [edit, duplicate, remove, reorder]) {
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body.message).toMatch(/published version is immutable/i);
    }

    // And nothing moved.
    const after = await questionsOf(versionId);

    expect(after).toHaveLength(2);
    expect(after[0].question_text).toBe('Question 1');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════
describe('ownership', () => {
  /** 404, not 403 — a counselor probing ids must not learn which ones exist. */
  it('hides another author’s question behind a 404 on every route', async () => {
    const { versionId } = await draftWithQuestions(1, adminToken);
    const [question] = await questionsOf(versionId);

    const responses = await Promise.all([
      api('PATCH', `/assessment-questions/${question.id}`, {
        token: counselorToken,
        body: { question_text: 'Not mine.' },
      }),
      api('POST', `/assessment-questions/${question.id}/duplicate`, { token: counselorToken }),
      api('DELETE', `/assessment-questions/${question.id}`, { token: counselorToken }),
      api('PUT', `/assessment-versions/${versionId}/question-order`, {
        token: counselorToken,
        body: { question_ids: [question.id] },
      }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(404);
    }
  });

  it('lets a counselor edit their own', async () => {
    const { versionId } = await draftWithQuestions(1, counselorToken);
    const [question] = await questionsOf(versionId, counselorToken);

    const response = await api('PATCH', `/assessment-questions/${question.id}`, {
      token: counselorToken,
      body: { question_text: 'Mine to edit.' },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.question_text).toBe('Mine to edit.');
  });
});

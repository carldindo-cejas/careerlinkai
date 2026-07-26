import { beforeAll, describe, expect, it } from 'vitest';

import { uuid } from '@/lib/crypto';

import {
  api,
  assessmentTaxonomy,
  classWithStudent,
  createClass,
  createStaffUser,
  login,
  type StaffUserFixture,
} from '../helpers';

/**
 * The administrator's assessment list, and the three actions on it (prompt-driven, v1.5).
 *
 * Two things are worth stating about what these tests are for.
 *
 * **The filters are tested against paginated results, not against the whole set**, because that is
 * exactly where a post-filter implementation looks correct and is not: filtering in TypeScript after
 * the page query returns short pages and a total that counts rows the caller cannot see. Asserting
 * on `pagination.total` is what catches it.
 *
 * **A GLOBAL assignment is asserted to be ordinary rows**, one per active class, rather than a
 * special kind of assignment. That is the load-bearing property of the design: every rule downstream
 * — who may start an attempt, who may read one, who gets notified — keeps resolving through a real
 * class, and a test that only checked the badge said "Global" would not notice if it stopped.
 */

let adminToken: string;
let counselor: StaffUserFixture;
let counselorToken: string;
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

/** A CUSTOM assessment owned by whoever holds `token`. */
async function createAssessment(token: string, title = `Assessment ${uuid().slice(0, 8)}`) {
  const response = await api('POST', '/assessment-templates', {
    token,
    body: { category: 'CUSTOM', title, ...taxonomyBody },
  });

  expect(response.status, JSON.stringify(response.body)).toBe(201);

  return response.body.data;
}

/** An assessment carried all the way to a published v1 with one confirmed, scored question. */
async function publishedAssessment(token: string, title?: string) {
  const template = await createAssessment(token, title);

  expect(
    (
      await api('POST', `/assessment-templates/${template.id}/dimensions`, {
        token,
        body: { dimensions: [{ code: 'X', name: 'Dimension X' }] },
      })
    ).status,
  ).toBe(201);

  const version = await api('POST', `/assessment-templates/${template.id}/versions`, {
    token,
    body: { scoring_algorithm: 'WEIGHTED_COMPOSITE' },
  });

  expect(version.status).toBe(201);

  const questions = await api('POST', `/assessment-versions/${version.body.data.id}/questions`, {
    token,
    body: {
      questions: [
        {
          question_text: 'I plan my week in advance.',
          question_type: 'LIKERT',
          options: [
            { label: 'Disagree', value: '1', score: 1 },
            { label: 'Agree', value: '2', score: 2 },
          ],
          dimension_codes: ['X'],
        },
      ],
    },
  });

  expect(questions.status).toBe(201);

  const published = await api('POST', `/assessment-versions/${version.body.data.id}/publish`, {
    token,
  });

  expect(published.status).toBe(200);

  return { template, versionId: version.body.data.id as string };
}

/** One row out of the admin list, found by id — the list is shared storage, so never index into it. */
async function rowFor(id: string, query = ''): Promise<any> {
  const response = await api('GET', `/assessments?per_page=100${query}`, { token: adminToken });

  expect(response.status).toBe(200);

  return response.body.data.items.find((item: any) => item.id === id);
}

// ═════════════════════════════════════════════════════════════════════════════════════
describe('the list payload', () => {
  it('carries the type, the scoring methods, every version and the assignment state', async () => {
    const { template } = await publishedAssessment(adminToken);
    const row = await rowFor(template.id);

    expect(row.type.name).toBe('Interest');
    expect(row.scorings.map((scoring: any) => scoring.code).sort()).toEqual([
      'LIKERT_SCALES',
      'RAW_SCORES',
    ]);
    expect(row.versions).toHaveLength(1);
    expect(row.versions[0].version_number).toBe(1);
    expect(row.is_published).toBe(true);
    expect(row.published_version.question_count).toBe(1);
    // Nothing has been assigned yet, and that is a third state — not "CLASS with zero classes".
    expect(row.assignment).toEqual({ scope: null, class_count: 0 });
  });

  it('reports an unpublished assessment as having no published version', async () => {
    const template = await createAssessment(adminToken);
    const row = await rowFor(template.id);

    expect(row.is_published).toBe(false);
    expect(row.published_version).toBeNull();
    expect(row.versions).toEqual([]);
  });

  it('shows an assessment that predates the taxonomy rather than hiding it', async () => {
    // The two curated instruments are the real instance of this; the backfilled type is what the
    // list must render. A LEFT JOIN is the only reason they appear at all.
    const response = await api('GET', '/assessments?per_page=100', { token: adminToken });

    expect(response.status).toBe(200);
    expect(response.body.data.items.every((item: any) => 'type' in item)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════
describe('search, filters, sorting and pagination', () => {
  it('searches on title, and the total reflects the filter rather than the whole set', async () => {
    const marker = uuid().slice(0, 8);
    await createAssessment(adminToken, `Findable ${marker}`);

    const response = await api('GET', `/assessments?search=${marker}`, { token: adminToken });

    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(1);
    // The count is the filtered count. A post-filter implementation reports the unfiltered one.
    expect(response.body.data.pagination.total).toBe(1);
  });

  it('filters by status — published, unpublished and archived are three sets', async () => {
    const { template: published } = await publishedAssessment(adminToken);
    const draft = await createAssessment(adminToken);

    expect(await rowFor(published.id, '&status=PUBLISHED')).toBeDefined();
    expect(await rowFor(draft.id, '&status=PUBLISHED')).toBeUndefined();

    expect(await rowFor(draft.id, '&status=UNPUBLISHED')).toBeDefined();
    expect(await rowFor(published.id, '&status=UNPUBLISHED')).toBeUndefined();

    // Archiving moves a row out of both of the above and into the third.
    expect((await api('POST', `/assessment-templates/${draft.id}/archive`, { token: adminToken })).status).toBe(200);

    expect(await rowFor(draft.id, '&status=UNPUBLISHED')).toBeUndefined();
    expect(await rowFor(draft.id, '&status=ARCHIVED')).toBeDefined();
  });

  it('filters by assessment type', async () => {
    const types = await api('GET', '/assessment-types', { token: adminToken });
    const academic = types.body.data.find((type: any) => type.code === 'ACADEMIC');
    const interest = types.body.data.find((type: any) => type.code === 'INTEREST');

    const template = await createAssessment(adminToken);

    expect(await rowFor(template.id, `&assessment_type_id=${interest.id}`)).toBeDefined();
    expect(await rowFor(template.id, `&assessment_type_id=${academic.id}`)).toBeUndefined();
  });

  it('paginates, and per_page is clamped rather than trusted', async () => {
    const first = await api('GET', '/assessments?per_page=1&page=1', { token: adminToken });

    expect(first.status).toBe(200);
    expect(first.body.data.items).toHaveLength(1);
    expect(first.body.data.pagination.per_page).toBe(1);
    expect(first.body.data.pagination.last_page).toBe(first.body.data.pagination.total);

    expect((await api('GET', '/assessments?per_page=5000', { token: adminToken })).status).toBe(422);
    expect((await api('GET', '/assessments?sort=title;DROP', { token: adminToken })).status).toBe(422);
  });

  it('sorts by title in both directions', async () => {
    const ascending = await api('GET', '/assessments?sort=title&direction=asc&per_page=100', {
      token: adminToken,
    });
    const descending = await api('GET', '/assessments?sort=title&direction=desc&per_page=100', {
      token: adminToken,
    });

    const titles = ascending.body.data.items.map((item: any) => item.title);

    expect(titles).toEqual([...titles].sort((a: string, b: string) => a.localeCompare(b)));
    expect(descending.body.data.items[0].title).toBe(titles[titles.length - 1]);
  });

  /**
   * A counselor reaching the same endpoint sees the global instruments plus their own — the same
   * visibility rule the template list has always had, applied inside the query.
   */
  it('scopes a counselor to their own private assessments plus the global ones', async () => {
    const mine = await createAssessment(counselorToken);
    const someoneElse = await createAssessment(
      await login(await createStaffUser({ role: 'counselor' })),
    );

    const response = await api('GET', '/assessments?per_page=100', { token: counselorToken });
    const ids = response.body.data.items.map((item: any) => item.id);

    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(someoneElse.id);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════
describe('assigning globally and to specific classes', () => {
  it('assigns to every active class in one act, and the rows are ordinary class assignments', async () => {
    const { classRoom } = await classWithStudent(counselorToken);
    const second = await createClass(counselorToken, { name: `Grade 12 ${uuid().slice(0, 4)}` });
    const { template } = await publishedAssessment(adminToken);

    const response = await api('POST', `/assessment-templates/${template.id}/assignments`, {
      token: adminToken,
      body: { scope: 'GLOBAL' },
    });

    expect(response.status).toBe(201);
    expect(response.body.data.assigned_classes).toBeGreaterThanOrEqual(2);
    expect(response.body.data.assessment.assignment.scope).toBe('GLOBAL');

    // The point of the design: each is a real class assignment the counselor's own screen can see.
    for (const id of [classRoom.id, second.id]) {
      const assignments = await api('GET', `/counselor/classes/${id}/assignments`, {
        token: counselorToken,
      });

      const match = assignments.body.data.find(
        (assignment: any) => assignment.assessment.title === template.title,
      );

      expect(match, `class ${id} received the global assignment`).toBeDefined();
      expect(match.scope).toBe('GLOBAL');
      expect(match.class_id).toBe(id);
    }
  });

  it('is idempotent — a second global assignment adds nothing rather than duplicating', async () => {
    const { template } = await publishedAssessment(adminToken);

    const first = await api('POST', `/assessment-templates/${template.id}/assignments`, {
      token: adminToken,
      body: { scope: 'GLOBAL' },
    });

    const again = await api('POST', `/assessment-templates/${template.id}/assignments`, {
      token: adminToken,
      body: { scope: 'GLOBAL' },
    });

    expect(again.status).toBe(201);
    expect(again.body.data.assigned_classes).toBe(0);
    expect(again.body.data.skipped_classes).toBe(first.body.data.assigned_classes);
  });

  it('assigns to chosen classes only, and the list says "specific classes"', async () => {
    const only = await createClass(counselorToken, { name: `Only ${uuid().slice(0, 4)}` });
    const notThisOne = await createClass(counselorToken, { name: `Other ${uuid().slice(0, 4)}` });
    const { template } = await publishedAssessment(adminToken);

    const response = await api('POST', `/assessment-templates/${template.id}/assignments`, {
      token: adminToken,
      body: { scope: 'CLASS', class_ids: [only.id] },
    });

    expect(response.status).toBe(201);
    expect(response.body.data.assigned_classes).toBe(1);

    const row = await rowFor(template.id);
    expect(row.assignment.scope).toBe('CLASS');
    expect(row.assignment.class_count).toBe(1);

    const untouched = await api('GET', `/counselor/classes/${notThisOne.id}/assignments`, {
      token: counselorToken,
    });

    // Named, not counted: this class may legitimately hold *other* assessments — anything assigned
    // globally reaches it on creation (see the ClassCreated test below). What must be absent is
    // this one, the one it was not picked for.
    expect(
      untouched.body.data.map((assignment: any) => assignment.assessment.title),
    ).not.toContain(template.title);
  });

  it('filters the list by assignment scope, and Global wins over Class', async () => {
    const classRoom = await createClass(counselorToken, { name: `Mixed ${uuid().slice(0, 4)}` });
    const { template } = await publishedAssessment(adminToken);

    // Assigned to one class first, then globally — the column must report the broader fact.
    await api('POST', `/assessment-templates/${template.id}/assignments`, {
      token: adminToken,
      body: { scope: 'CLASS', class_ids: [classRoom.id] },
    });

    expect(await rowFor(template.id, '&assignment=CLASS')).toBeDefined();

    await api('POST', `/assessment-templates/${template.id}/assignments`, {
      token: adminToken,
      body: { scope: 'GLOBAL' },
    });

    expect(await rowFor(template.id, '&assignment=GLOBAL')).toBeDefined();
    expect(await rowFor(template.id, '&assignment=CLASS')).toBeUndefined();
    expect(await rowFor(template.id, '&assignment=UNASSIGNED')).toBeUndefined();
  });

  /**
   * **The gap a per-class fan-out would otherwise leave.** A global assignment writes rows for the
   * classes that exist at that moment, so a class created afterwards would have nothing — and
   * "Global" in the list would be quietly false. `ClassCreated` closes it at the one moment it opens.
   */
  it('gives a class created afterwards the assessments already assigned globally', async () => {
    const { template } = await publishedAssessment(adminToken);

    await api('POST', `/assessment-templates/${template.id}/assignments`, {
      token: adminToken,
      body: { scope: 'GLOBAL' },
    });

    // Created *after* the global assignment — the case the fan-out cannot cover by itself.
    const latecomer = await createClass(counselorToken, {
      name: `Latecomer ${uuid().slice(0, 4)}`,
    });

    const assignments = await api('GET', `/counselor/classes/${latecomer.id}/assignments`, {
      token: counselorToken,
    });

    const match = assignments.body.data.find(
      (assignment: any) => assignment.assessment.title === template.title,
    );

    expect(match, 'the new class received the standing global assignment').toBeDefined();
    expect(match.scope).toBe('GLOBAL');
    expect(match.status).toBe('ACTIVE');
  });

  it('does not hand a new class an archived or unassigned assessment', async () => {
    const { template: archived } = await publishedAssessment(adminToken);
    const { template: neverAssigned } = await publishedAssessment(adminToken);

    await api('POST', `/assessment-templates/${archived.id}/assignments`, {
      token: adminToken,
      body: { scope: 'GLOBAL' },
    });
    await api('POST', `/assessment-templates/${archived.id}/archive`, { token: adminToken });

    const fresh = await createClass(counselorToken, { name: `Fresh ${uuid().slice(0, 4)}` });

    const assignments = await api('GET', `/counselor/classes/${fresh.id}/assignments`, {
      token: counselorToken,
    });

    const titles = assignments.body.data.map((assignment: any) => assignment.assessment.title);

    expect(titles).not.toContain(archived.title);
    expect(titles).not.toContain(neverAssigned.title);
  });

  it('refuses to assign an assessment with nothing published — a 422, not a 403', async () => {
    const template = await createAssessment(adminToken);

    const response = await api('POST', `/assessment-templates/${template.id}/assignments`, {
      token: adminToken,
      body: { scope: 'GLOBAL' },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.assessment_version_id).toBeDefined();
  });

  it('refuses a GLOBAL body that also names classes', async () => {
    const { template } = await publishedAssessment(adminToken);

    const response = await api('POST', `/assessment-templates/${template.id}/assignments`, {
      token: adminToken,
      body: { scope: 'GLOBAL', class_ids: [uuid()] },
    });

    expect(response.status).toBe(422);
  });

  it('refuses to assign an archived assessment until it is restored', async () => {
    const { template } = await publishedAssessment(adminToken);
    await createClass(counselorToken, { name: `Archived ${uuid().slice(0, 4)}` });

    expect(
      (await api('POST', `/assessment-templates/${template.id}/archive`, { token: adminToken }))
        .status,
    ).toBe(200);

    const refused = await api('POST', `/assessment-templates/${template.id}/assignments`, {
      token: adminToken,
      body: { scope: 'GLOBAL' },
    });

    expect(refused.status).toBe(422);

    expect(
      (await api('POST', `/assessment-templates/${template.id}/restore`, { token: adminToken }))
        .status,
    ).toBe(200);

    expect(
      (
        await api('POST', `/assessment-templates/${template.id}/assignments`, {
          token: adminToken,
          body: { scope: 'GLOBAL' },
        })
      ).status,
    ).toBe(201);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════
describe('archive and restore', () => {
  it('archives the template and its draft versions, and is idempotent', async () => {
    const template = await createAssessment(adminToken);

    await api('POST', `/assessment-templates/${template.id}/versions`, {
      token: adminToken,
      body: { scoring_algorithm: 'WEIGHTED_COMPOSITE' },
    });

    const archived = await api('POST', `/assessment-templates/${template.id}/archive`, {
      token: adminToken,
    });

    expect(archived.status).toBe(200);
    expect(archived.body.data.is_archived).toBe(true);
    expect(archived.body.data.versions[0].status).toBe('ARCHIVED');

    // Archiving twice is a no-op, so a double-tapped confirmation is not an error.
    expect(
      (await api('POST', `/assessment-templates/${template.id}/archive`, { token: adminToken }))
        .status,
    ).toBe(200);
  });

  /**
   * **Archiving must not end work already in flight.** Closing an assignment expires every attempt
   * still in progress underneath it (§21); an archive that silently did that would end the
   * assessment a class is sitting for. The assignment stays ACTIVE, and ending it stays an explicit
   * act on the assignment itself.
   */
  it('leaves an assignment already in flight open', async () => {
    const { classRoom } = await classWithStudent(counselorToken);
    const { template } = await publishedAssessment(adminToken);

    await api('POST', `/assessment-templates/${template.id}/assignments`, {
      token: adminToken,
      body: { scope: 'CLASS', class_ids: [classRoom.id] },
    });

    await api('POST', `/assessment-templates/${template.id}/archive`, { token: adminToken });

    const assignments = await api('GET', `/counselor/classes/${classRoom.id}/assignments`, {
      token: counselorToken,
    });

    const match = assignments.body.data.find(
      (assignment: any) => assignment.assessment.title === template.title,
    );

    expect(match.status).toBe('ACTIVE');
  });

  it('restores to ACTIVE when something is published and to DRAFT when nothing is', async () => {
    const { template: withVersion } = await publishedAssessment(adminToken);
    const bare = await createAssessment(adminToken);

    for (const id of [withVersion.id, bare.id]) {
      await api('POST', `/assessment-templates/${id}/archive`, { token: adminToken });
    }

    const restoredPublished = await api(
      'POST',
      `/assessment-templates/${withVersion.id}/restore`,
      { token: adminToken },
    );
    const restoredBare = await api('POST', `/assessment-templates/${bare.id}/restore`, {
      token: adminToken,
    });

    expect(restoredPublished.body.data.status).toBe('ACTIVE');
    expect(restoredBare.body.data.status).toBe('DRAFT');
  });

  it('404s another counselor’s private assessment rather than confirming it exists', async () => {
    const mine = await createAssessment(counselorToken);
    const stranger = await login(await createStaffUser({ role: 'counselor' }));

    expect(
      (await api('POST', `/assessment-templates/${mine.id}/archive`, { token: stranger })).status,
    ).toBe(404);

    expect(
      (
        await api('PATCH', `/assessment-templates/${mine.id}`, {
          token: stranger,
          body: { title: 'Stolen', ...taxonomyBody },
        })
      ).status,
    ).toBe(404);
  });
});

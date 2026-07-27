import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import { assessmentTemplates, classes } from '@/db/schema';
import { uuid } from '@/lib/crypto';

import {
  api,
  assessmentTaxonomy,
  classWithStudent,
  createClass,
  createStaffUser,
  db,
  enrolStudents,
  joinClass,
  login,
  type StaffUserFixture,
} from '../helpers';

/**
 * The assessment lifecycle as a student and an administrator actually experience it (v1.6).
 *
 * Four things are under test here, and they are in one file because they are one question asked
 * from two sides: **what makes an assessment reachable, and what makes it stop being reachable?**
 *
 *   * **Availability.** A student's list must contain exactly the published, non-archived,
 *     non-deleted instruments assigned to a class they are in. Every one of those four conditions
 *     used to be assumed rather than checked, and each failure mode is invisible from the student's
 *     side — an archived assessment simply keeps appearing, and nothing anywhere reports an error.
 *   * **Global reach.** "Assigned globally" has to mean *every eligible student*, including the ones
 *     in classes that did not exist, or were not active, when the assignment was made. This is
 *     asserted through the student's own list rather than through the assignment rows, because the
 *     list is the claim the product makes.
 *   * **Deletion.** A soft delete with two guards, and the guards are the point: the refusal must
 *     hold when a student has answered, and it must survive a client that ignores `can_delete`.
 *   * **Dates.** `published_at` is the one date the system did not previously have, and it must
 *     be the publication instant rather than the draft's creation.
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

/** A CUSTOM assessment carried to a published v1 with one confirmed, scored question. */
async function publishedAssessment(token: string, title = `Instrument ${uuid().slice(0, 8)}`) {
  const template = await api('POST', '/assessment-templates', {
    token,
    body: { category: 'CUSTOM', title, ...taxonomyBody },
  });

  expect(template.status, JSON.stringify(template.body)).toBe(201);

  const templateId = template.body.data.id as string;

  expect(
    (
      await api('POST', `/assessment-templates/${templateId}/dimensions`, {
        token,
        body: { dimensions: [{ code: 'X', name: 'Dimension X' }] },
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
      })
    ).status,
  ).toBe(201);

  const published = await api('POST', `/assessment-versions/${versionId}/publish`, { token });

  expect(published.status, JSON.stringify(published.body)).toBe(200);

  return { templateId, versionId, title, publishedVersion: published.body.data };
}

/** An unpublished assessment: a template with a DRAFT version and one question, never published. */
async function draftAssessment(token: string) {
  const template = await api('POST', '/assessment-templates', {
    token,
    body: { category: 'CUSTOM', title: `Draft ${uuid().slice(0, 8)}`, ...taxonomyBody },
  });

  expect(template.status).toBe(201);

  const version = await api('POST', `/assessment-templates/${template.body.data.id}/versions`, {
    token,
    body: { scoring_algorithm: 'WEIGHTED_COMPOSITE' },
  });

  expect(version.status).toBe(201);

  return { templateId: template.body.data.id as string, versionId: version.body.data.id as string };
}

/** The titles on a student's Available Assessments list. */
async function availableTitles(studentToken: string): Promise<string[]> {
  const response = await api('GET', '/student/assignments', { token: studentToken });

  expect(response.status, JSON.stringify(response.body)).toBe(200);

  return response.body.data.map((row: any) => row.assessment.title);
}

async function assignToClass(templateId: string, classId: string, token = adminToken) {
  const response = await api('POST', `/assessment-templates/${templateId}/assignments`, {
    token,
    body: { scope: 'CLASS', class_ids: [classId] },
  });

  expect(response.status, JSON.stringify(response.body)).toBe(201);

  return response.body.data;
}

// ═════════════════════════════════════════════════════════════════════════════════════
describe('what a student may sit', () => {
  it('offers a published assessment assigned to their class', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const { templateId, title } = await publishedAssessment(adminToken);

    await assignToClass(templateId, classRoom.id);

    expect(await availableTitles(studentToken)).toContain(title);
  });

  /**
   * The regression this file exists for. Archiving deliberately leaves open assignments alone (§21
   * — expiring in-flight attempts is the separate, explicit act of closing an assignment), and the
   * student's list read that as "still on offer". The two behaviours are not in tension: what is
   * *offered* stops, what is *in flight* does not.
   */
  it('stops offering an assessment once it is archived, without closing the assignment', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const { templateId, title } = await publishedAssessment(adminToken);

    await assignToClass(templateId, classRoom.id);
    expect(await availableTitles(studentToken)).toContain(title);

    expect(
      (await api('POST', `/assessment-templates/${templateId}/archive`, { token: adminToken }))
        .status,
    ).toBe(200);

    expect(await availableTitles(studentToken)).not.toContain(title);

    // The assignment row itself is untouched — the counselor's own view still shows it, because
    // archiving an instrument must not silently end the assessment a class is sitting for.
    const counselorView = await api(
      'GET',
      `/counselor/classes/${classRoom.id}/assignments`,
      { token: counselorToken },
    );

    expect(counselorView.status).toBe(200);
    expect(counselorView.body.data.some((row: any) => row.assessment.title === title)).toBe(true);
    expect(
      counselorView.body.data.find((row: any) => row.assessment.title === title).status,
    ).toBe('ACTIVE');
  });

  it('offers it again once the assessment is restored', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const { templateId, title } = await publishedAssessment(adminToken);

    await assignToClass(templateId, classRoom.id);

    await api('POST', `/assessment-templates/${templateId}/archive`, { token: adminToken });
    expect(await availableTitles(studentToken)).not.toContain(title);

    expect(
      (await api('POST', `/assessment-templates/${templateId}/restore`, { token: adminToken }))
        .status,
    ).toBe(200);

    expect(await availableTitles(studentToken)).toContain(title);
  });

  /**
   * A DRAFT version cannot be assigned through the API at all, so this reaches past it: the row is
   * written directly, which is what a version archived *after* assignment leaves behind. The list
   * has to filter on the version's own status rather than trusting that only published ones got in.
   */
  it('never offers an assignment whose version is not PUBLISHED', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const { templateId, versionId, title } = await publishedAssessment(adminToken);

    await assignToClass(templateId, classRoom.id);
    expect(await availableTitles(studentToken)).toContain(title);

    // Archive the version underneath the live assignment.
    const { assessmentVersions } = await import('@/db/schema');
    await db()
      .update(assessmentVersions)
      .set({ status: 'ARCHIVED' })
      .where(eq(assessmentVersions.id, versionId));

    expect(await availableTitles(studentToken)).not.toContain(title);
  });

  it('never offers a soft-deleted assessment', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const { templateId, title } = await publishedAssessment(adminToken);

    await assignToClass(templateId, classRoom.id);

    // Soft-delete directly: the endpoint refuses while an ACTIVE assignment exists (by design —
    // see the delete tests below), and what is under test here is the list's own filter.
    await db()
      .update(assessmentTemplates)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(assessmentTemplates.id, templateId));

    expect(await availableTitles(studentToken)).not.toContain(title);
  });

  it('shows a student nothing from a class they are not in', async () => {
    const mine = await classWithStudent(counselorToken);
    const theirs = await classWithStudent(counselorToken);
    const { templateId, title } = await publishedAssessment(adminToken);

    await assignToClass(templateId, theirs.classRoom.id);

    expect(await availableTitles(mine.studentToken)).not.toContain(title);
    expect(await availableTitles(theirs.studentToken)).toContain(title);
  });

  /**
   * The list stopped offering it; this is the other half. A filtered list is a UI fact, and a stale
   * tab still holds the assignment id — so the *act* has to refuse too.
   */
  it('refuses to start an attempt on an archived assessment', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const { templateId } = await publishedAssessment(adminToken);

    await assignToClass(templateId, classRoom.id);

    const assignments = await api('GET', '/student/assignments', { token: studentToken });
    const assignmentId = assignments.body.data[0].id;

    await api('POST', `/assessment-templates/${templateId}/archive`, { token: adminToken });

    const start = await api('POST', `/student/assignments/${assignmentId}/start`, {
      token: studentToken,
    });

    expect(start.status).toBe(422);
    expect(start.body.message).toMatch(/no longer available/i);
  });

  /**
   * …and the exception to it. Retiring an instrument governs what is offered next; a student who is
   * already halfway through must be able to finish, because `start` is contractually idempotent and
   * resuming is what it does.
   */
  it('lets a student resume an attempt they had already started', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const { templateId } = await publishedAssessment(adminToken);

    await assignToClass(templateId, classRoom.id);

    const assignments = await api('GET', '/student/assignments', { token: studentToken });
    const assignmentId = assignments.body.data[0].id;

    const started = await api('POST', `/student/assignments/${assignmentId}/start`, {
      token: studentToken,
    });

    expect(started.status).toBe(200);

    await api('POST', `/assessment-templates/${templateId}/archive`, { token: adminToken });

    const resumed = await api('POST', `/student/assignments/${assignmentId}/start`, {
      token: studentToken,
    });

    expect(resumed.status).toBe(200);
    expect(resumed.body.data.id).toBe(started.body.data.id);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════
describe('a global assignment reaches every eligible student', () => {
  async function assignGlobally(templateId: string) {
    const response = await api('POST', `/assessment-templates/${templateId}/assignments`, {
      token: adminToken,
      body: { scope: 'GLOBAL' },
    });

    expect(response.status, JSON.stringify(response.body)).toBe(201);

    return response.body.data;
  }

  it('reaches a student in a class that already existed', async () => {
    const { studentToken } = await classWithStudent(counselorToken);
    const { templateId, title } = await publishedAssessment(adminToken);

    await assignGlobally(templateId);

    expect(await availableTitles(studentToken)).toContain(title);
  });

  it('reaches a student in a class created after the assignment', async () => {
    const { templateId, title } = await publishedAssessment(adminToken);

    await assignGlobally(templateId);

    // Created afterwards — the `ClassActivated` listener is what puts the row on it.
    const { studentToken } = await classWithStudent(counselorToken);

    expect(await availableTitles(studentToken)).toContain(title);
  });

  /**
   * The v1.6 hole. `listActive()` targets `status = 'active'` classes, so a `draft` class was
   * skipped at assign time — and creation-time top-up never fired again, because the class was not
   * being created. Its students would have been permanently missing an assessment that the admin
   * list truthfully reported as reaching "every class".
   */
  it('reaches a student in a class that was activated after the assignment', async () => {
    const classRoom = await createClass(counselorToken, { name: 'Late starter' });

    // Put it out of reach of `listActive()` before the global assignment happens.
    await db().update(classes).set({ status: 'draft' }).where(eq(classes.id, classRoom.id));

    const { templateId, title } = await publishedAssessment(adminToken);
    await assignGlobally(templateId);

    // Switching it on is what must top it up.
    const activated = await api('PATCH', `/counselor/classes/${classRoom.id}`, {
      token: counselorToken,
      body: { status: 'active' },
    });

    expect(activated.status, JSON.stringify(activated.body)).toBe(200);

    const roster = await enrolStudents(counselorToken, classRoom.id, ['Ana Reyes']);
    const studentToken = await joinClass(classRoom.join_code, roster[0].username);

    expect(await availableTitles(studentToken)).toContain(title);
  });

  it('does not double-assign a class that already holds it', async () => {
    const classRoom = await createClass(counselorToken, { name: 'Idempotence' });
    const { templateId } = await publishedAssessment(adminToken);

    await assignGlobally(templateId);

    // Re-running tops up rather than duplicating: every class already has it, so nothing is added.
    const second = await assignGlobally(templateId);

    expect(second.assigned_classes).toBe(0);

    const assignments = await api('GET', `/counselor/classes/${classRoom.id}/assignments`, {
      token: counselorToken,
    });

    expect(
      assignments.body.data.filter((row: any) => row.assessment.title !== undefined).length,
    ).toBeGreaterThan(0);
  });

  it('does not reach a class through an unpublished assessment', async () => {
    const { templateId } = await draftAssessment(adminToken);

    const response = await api('POST', `/assessment-templates/${templateId}/assignments`, {
      token: adminToken,
      body: { scope: 'GLOBAL' },
    });

    // Nothing publishable, so this is a 422 rather than an assignment nobody could sit.
    expect(response.status).toBe(422);
    expect(response.body.errors.assessment_version_id[0]).toMatch(/no published version/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════
describe('deleting an assessment', () => {
  it('soft-deletes an untouched assessment and removes it from the list', async () => {
    const { templateId, title } = await publishedAssessment(adminToken);

    const deleted = await api('DELETE', `/assessment-templates/${templateId}`, {
      token: adminToken,
    });

    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body.data.deleted_at).not.toBeNull();

    const list = await api('GET', `/assessments?per_page=100&search=${encodeURIComponent(title)}`, {
      token: adminToken,
    });

    expect(list.body.data.items).toHaveLength(0);

    // …and it is gone from the builder too, not merely hidden from one screen.
    expect(
      (await api('GET', `/assessment-templates/${templateId}`, { token: adminToken })).status,
    ).toBe(404);
  });

  it('refuses while the assessment is assigned to a class, and says so', async () => {
    const { classRoom } = await classWithStudent(counselorToken);
    const { templateId } = await publishedAssessment(adminToken);

    await assignToClass(templateId, classRoom.id);

    const refused = await api('DELETE', `/assessment-templates/${templateId}`, {
      token: adminToken,
    });

    expect(refused.status).toBe(422);
    expect(refused.body.errors.assessment[0]).toMatch(/assigned to 1 class/i);
  });

  /**
   * The guard that can never be worked around. §12 makes the attempt → answer → result chain
   * permanent evidence with no soft delete anywhere in it, so an instrument those rows describe
   * cannot be removed — even after the assignment that produced them is closed.
   */
  it('refuses once a student has responded, even after the assignment is closed', async () => {
    const { classRoom, studentToken } = await classWithStudent(counselorToken);
    const { templateId } = await publishedAssessment(adminToken);

    await assignToClass(templateId, classRoom.id);

    const assignments = await api('GET', '/student/assignments', { token: studentToken });
    const assignmentId = assignments.body.data[0].id;

    expect(
      (await api('POST', `/student/assignments/${assignmentId}/start`, { token: studentToken }))
        .status,
    ).toBe(200);

    expect(
      (
        await api('PATCH', `/counselor/assignments/${assignmentId}`, {
          token: counselorToken,
          body: { status: 'CLOSED' },
        })
      ).status,
    ).toBe(200);

    const refused = await api('DELETE', `/assessment-templates/${templateId}`, {
      token: adminToken,
    });

    expect(refused.status).toBe(422);
    expect(refused.body.errors.assessment[0]).toMatch(/response/i);
    expect(refused.body.errors.assessment[0]).toMatch(/archive it instead/i);
  });

  it('reports delete eligibility on the list row and through its own endpoint', async () => {
    const { classRoom } = await classWithStudent(counselorToken);
    const { templateId, title } = await publishedAssessment(adminToken);

    const before = await api(
      'GET',
      `/assessments?per_page=100&search=${encodeURIComponent(title)}`,
      { token: adminToken },
    );

    expect(before.body.data.items[0].can_delete).toBe(true);
    expect(before.body.data.items[0].delete_blocked_reason).toBeNull();

    await assignToClass(templateId, classRoom.id);

    const after = await api(
      'GET',
      `/assessments?per_page=100&search=${encodeURIComponent(title)}`,
      { token: adminToken },
    );

    expect(after.body.data.items[0].can_delete).toBe(false);
    expect(after.body.data.items[0].delete_blockers).toEqual(['HAS_ACTIVE_ASSIGNMENTS']);
    expect(after.body.data.items[0].active_assignment_count).toBe(1);

    // The dialog re-checks at the moment of confirmation, and gets the same answer.
    const eligibility = await api(
      'GET',
      `/assessment-templates/${templateId}/deletability`,
      { token: adminToken },
    );

    expect(eligibility.status).toBe(200);
    expect(eligibility.body.data.can_delete).toBe(false);
    expect(eligibility.body.data.reason).toMatch(/assigned to 1 class/i);
  });

  it('is refused to a counselor who does not own the assessment', async () => {
    const { templateId } = await publishedAssessment(adminToken);

    // 404, not 403 — a counselor probing template ids must not learn which ones exist.
    const refused = await api('DELETE', `/assessment-templates/${templateId}`, {
      token: counselorToken,
    });

    expect(refused.status).toBe(404);
  });

  it('records the deletion in the audit trail', async () => {
    const { templateId, title } = await publishedAssessment(adminToken);

    await api('DELETE', `/assessment-templates/${templateId}`, { token: adminToken });

    const logs = await api(
      'GET',
      `/admin/audit-logs?action=ASSESSMENT_TEMPLATE_DELETED&target_id=${templateId}`,
      { token: adminToken },
    );

    expect(logs.status).toBe(200);
    expect(logs.body.data.items).toHaveLength(1);
    expect(logs.body.data.items[0].old_values.title).toBe(title);
    expect(logs.body.data.items[0].action_type).toBe('DELETE');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════
describe('the three dates', () => {
  it('stamps published_at at publication, not at the draft’s creation', async () => {
    const { templateId, publishedVersion } = await publishedAssessment(adminToken);

    expect(publishedVersion.published_at).not.toBeNull();

    const detail = await api('GET', `/assessment-templates/${templateId}`, { token: adminToken });

    expect(detail.status).toBe(200);
    expect(detail.body.data.versions[0].published_at).toBe(publishedVersion.published_at);
    // The version was drafted before it was published, so publication is at or after creation.
    expect(
      publishedVersion.published_at >= detail.body.data.versions[0].created_at,
    ).toBe(true);
  });

  it('leaves published_at null for an assessment that never published', async () => {
    const { templateId } = await draftAssessment(adminToken);

    const list = await api('GET', '/assessments?per_page=100', { token: adminToken });
    const row = list.body.data.items.find((item: any) => item.id === templateId);

    expect(row.published_at).toBeNull();
    expect(row.first_published_at).toBeNull();
    expect(row.created_at).not.toBeNull();
  });

  it('reports created, updated and published dates on the list row', async () => {
    const { title } = await publishedAssessment(adminToken);

    const row = (
      await api('GET', `/assessments?per_page=100&search=${encodeURIComponent(title)}`, {
        token: adminToken,
      })
    ).body.data.items[0];

    expect(row.created_at).not.toBeNull();
    expect(row.updated_at).not.toBeNull();
    expect(row.published_at).not.toBeNull();
    // With one published version, "first published" and "last published" are the same event.
    expect(row.first_published_at).toBe(row.published_at);
  });

  it('filters by publication date, and the total reflects the filter', async () => {
    const { title } = await publishedAssessment(adminToken);
    const today = new Date().toISOString().slice(0, 10);

    const inRange = await api(
      'GET',
      `/assessments?per_page=100&published_from=${today}&published_to=${today}&search=${encodeURIComponent(title)}`,
      { token: adminToken },
    );

    expect(inRange.status, JSON.stringify(inRange.body)).toBe(200);
    expect(inRange.body.data.items).toHaveLength(1);
    expect(inRange.body.data.pagination.total).toBe(1);

    // A window that closed before today excludes it — and the count is the filtered count, which is
    // what a post-filter implementation gets wrong.
    const outOfRange = await api(
      'GET',
      `/assessments?per_page=100&published_from=2020-01-01&published_to=2020-01-02&search=${encodeURIComponent(title)}`,
      { token: adminToken },
    );

    expect(outOfRange.body.data.items).toHaveLength(0);
    expect(outOfRange.body.data.pagination.total).toBe(0);
  });

  it('excludes a never-published assessment from any publication-date window', async () => {
    const { templateId } = await draftAssessment(adminToken);

    const response = await api(
      'GET',
      '/assessments?per_page=100&published_from=2000-01-01&published_to=2099-12-31',
      { token: adminToken },
    );

    expect(
      response.body.data.items.some((item: any) => item.id === templateId),
    ).toBe(false);
  });

  it('accepts a bare date and makes the range inclusive at both ends', async () => {
    const { title } = await publishedAssessment(adminToken);
    const today = new Date().toISOString().slice(0, 10);

    // A `to` bound read naively as midnight would exclude everything published today — which is
    // never what someone typing "to <today>" meant.
    const response = await api(
      'GET',
      `/assessments?per_page=100&created_from=${today}&created_to=${today}&search=${encodeURIComponent(title)}`,
      { token: adminToken },
    );

    expect(response.body.data.items).toHaveLength(1);
  });

  it('sorts by publication date with never-published rows last in both directions', async () => {
    await publishedAssessment(adminToken);
    await draftAssessment(adminToken);

    for (const direction of ['asc', 'desc']) {
      const response = await api(
        'GET',
        `/assessments?per_page=100&sort=published_at&direction=${direction}`,
        { token: adminToken },
      );

      expect(response.status).toBe(200);

      const dates = response.body.data.items.map((item: any) => item.published_at);
      const firstNull = dates.indexOf(null);

      if (firstNull !== -1) {
        // Once the nulls start they never stop: missing data sorts last, not first.
        expect(dates.slice(firstNull).every((date: string | null) => date === null)).toBe(true);
      }
    }
  });
});

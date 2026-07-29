import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { auditLogs, notifications } from '@/db/schema';
import {
  api,
  createClass,
  createStaffUser,
  db,
  enrolStudents,
  login,
  softDeleteUser,
} from '../helpers';

/**
 * Class reassignment and the counselor-deletion guard (audit F5, plan P3-6).
 *
 * ## What was broken
 *
 * `classes.counselor_id` was set at creation and writable by **nothing**: not a schema, not an
 * endpoint, not a screen. A counselor who left took their classes' ownership with them — the rows
 * stayed, still pointing at the deleted account, and no replacement could ever be given them. An
 * admin could still *see* the classes (`canViewClass` passes admins), so nothing was lost and
 * nothing was recoverable either. Deleting the counselor was the act that made it permanent, and
 * it was allowed silently.
 *
 * The two halves have to ship together: a guard on deletion with no way to reassign is a dead end,
 * and a reassignment endpoint nobody is ever pointed at is F1's defect class again.
 */

/** The audit trail for one class, oldest first. */
async function auditFor(classId: string) {
  const rows = await db().select().from(auditLogs).where(eq(auditLogs.targetId, classId));

  return rows;
}

async function notificationsFor(userId: string) {
  return db().select().from(notifications).where(eq(notifications.userId, userId));
}

describe('PATCH /admin/classes/:id — reassignment (audit F5)', () => {
  it('hands the class to another counselor, who then sees it as their own', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const adminToken = await login(admin);
    const leaving = await createStaffUser({ role: 'counselor' });
    const leavingToken = await login(leaving);
    const replacement = await createStaffUser({ role: 'counselor' });
    const replacementToken = await login(replacement);

    const classRoom = await createClass(leavingToken, { name: 'Grade 12 STEM A' });

    const response = await api('PATCH', `/admin/classes/${classRoom.id}`, {
      token: adminToken,
      body: { counselor_id: replacement.id },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.counselor_id).toBe(replacement.id);

    // The claim that matters is not the response body — it is that the *other* endpoints now
    // answer differently. Ownership is what `find`, the roster, the results and the join code all
    // read, so a reassignment that updated the column without moving those would be cosmetic.
    const mine = await api('GET', '/counselor/classes', { token: replacementToken });
    const theirs = await api('GET', '/counselor/classes', { token: leavingToken });

    expect(mine.body.data.items.map((item: { id: string }) => item.id)).toContain(classRoom.id);
    expect(theirs.body.data.items.map((item: { id: string }) => item.id)).not.toContain(
      classRoom.id,
    );

    // 404 rather than 403 for the previous owner (§19): "not yours" and "not real" are the same
    // answer, and reassignment must not turn that rule into an existence oracle.
    expect((await api('GET', `/counselor/classes/${classRoom.id}`, { token: leavingToken })).status).toBe(
      404,
    );
    expect(
      (await api('GET', `/counselor/classes/${classRoom.id}`, { token: replacementToken })).status,
    ).toBe(200);
  });

  it('carries the roster with the class — the new counselor inherits the students', async () => {
    const adminToken = await login(await createStaffUser({ role: 'admin' }));
    const leavingToken = await login(await createStaffUser({ role: 'counselor' }));
    const replacement = await createStaffUser({ role: 'counselor' });
    const replacementToken = await login(replacement);

    const classRoom = await createClass(leavingToken);
    await enrolStudents(leavingToken, classRoom.id, ['Juan Dela Cruz', 'Maria Santos']);

    await api('PATCH', `/admin/classes/${classRoom.id}`, {
      token: adminToken,
      body: { counselor_id: replacement.id },
    });

    const roster = await api('GET', `/counselor/classes/${classRoom.id}/students`, {
      token: replacementToken,
    });

    expect(roster.status).toBe(200);
    expect(roster.body.data).toHaveLength(2);

    // …and the counselor-detail view an admin reads, which resolves students *through* classes.
    const students = await api('GET', `/admin/counselors/${replacement.id}/students`, {
      token: adminToken,
    });

    expect(students.body.data.students).toHaveLength(2);
  });

  it('tells the new counselor, so a class does not simply appear in their list', async () => {
    const adminToken = await login(await createStaffUser({ role: 'admin' }));
    const leavingToken = await login(await createStaffUser({ role: 'counselor' }));
    const replacement = await createStaffUser({ role: 'counselor' });

    const classRoom = await createClass(leavingToken, { name: 'Grade 11 HUMSS B' });

    await api('PATCH', `/admin/classes/${classRoom.id}`, {
      token: adminToken,
      body: { counselor_id: replacement.id },
    });

    const received = await notificationsFor(replacement.id);

    expect(received).toHaveLength(1);
    expect(received[0]!.category).toBe('CLASS');
    expect(received[0]!.message).toContain('Grade 11 HUMSS B');
  });

  /** Both ends, because "which counselor lost this class" is unanswerable from the new value. */
  it('records the transfer with both counselor ids', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const adminToken = await login(admin);
    const leaving = await createStaffUser({ role: 'counselor' });
    const replacement = await createStaffUser({ role: 'counselor' });

    const classRoom = await createClass(await login(leaving));

    await api('PATCH', `/admin/classes/${classRoom.id}`, {
      token: adminToken,
      body: { counselor_id: replacement.id },
    });

    const reassigned = (await auditFor(classRoom.id)).find(
      (row) => row.action === 'CLASS_REASSIGNED',
    );

    expect(reassigned).toBeDefined();
    expect(reassigned!.userId).toBe(admin.id);
    expect(reassigned!.oldValues).toMatchObject({ counselor_id: leaving.id });
    expect(reassigned!.newValues).toMatchObject({ counselor_id: replacement.id });
  });

  /**
   * **A counselor cannot reassign anything, including their own class.**
   *
   * This is the reason the endpoint is on `/admin` behind `ensureRole('admin')` rather than being a
   * field on the `PATCH /counselor/classes/:id` a counselor already reaches: that route is mounted
   * behind `ensureRole('counselor', 'admin')`, so a `counselor_id` accepted there would let any
   * counselor in the school hand a colleague's class to themselves — and inherit a roster's results
   * with it.
   *
   * **Which half of this is load-bearing was checked, not assumed.** Widening
   * `adminClassRoutes`' own `ensureRole` to admit counselors leaves this test green: every router
   * mounted on `/admin` declares the same gate, and Hono runs all of their `use('*')` chains, so
   * the first one refuses. That is defence in depth rather than a redundancy to delete — but it
   * means the 403 below is a claim about the **prefix**. The assertion that pins this item's own
   * decision is the second one: it goes red the moment `counselor_id` becomes writable on the
   * counselor-reachable route, which is the mistake worth a regression test.
   */
  it('refuses a counselor, even for a class they own', async () => {
    const counselor = await createStaffUser({ role: 'counselor' });
    const token = await login(counselor);
    const other = await createStaffUser({ role: 'counselor' });

    const classRoom = await createClass(token);

    const response = await api('PATCH', `/admin/classes/${classRoom.id}`, {
      token,
      body: { counselor_id: other.id },
    });

    expect(response.status).toBe(403);

    // And the field is still not writable on the route they *can* reach.
    const sneaked = await api('PATCH', `/counselor/classes/${classRoom.id}`, {
      token,
      body: { counselor_id: other.id, name: 'Renamed' },
    });

    expect(sneaked.status).toBe(200);
    expect(sneaked.body.data.counselor_id).toBe(counselor.id);
  });

  it.each([
    ['a suspended counselor', { role: 'counselor' as const, status: 'suspended' as const }],
    ['an admin', { role: 'admin' as const }],
  ])('refuses %s as the target — the class would belong to nobody who can manage it', async (_label, options) => {
    const adminToken = await login(await createStaffUser({ role: 'admin' }));
    const counselorToken = await login(await createStaffUser({ role: 'counselor' }));
    const target = await createStaffUser(options);

    const classRoom = await createClass(counselorToken);

    const response = await api('PATCH', `/admin/classes/${classRoom.id}`, {
      token: adminToken,
      body: { counselor_id: target.id },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.counselor_id).toBeDefined();
  });

  it('refuses a soft-deleted counselor as the target', async () => {
    const adminToken = await login(await createStaffUser({ role: 'admin' }));
    const counselorToken = await login(await createStaffUser({ role: 'counselor' }));
    const gone = await createStaffUser({ role: 'counselor' });

    await softDeleteUser(gone.id);

    const classRoom = await createClass(counselorToken);

    const response = await api('PATCH', `/admin/classes/${classRoom.id}`, {
      token: adminToken,
      body: { counselor_id: gone.id },
    });

    expect(response.status).toBe(422);
  });

  /** Same owner changes nothing, so it must claim nothing — no audit row, no notification. */
  it('is a silent no-op when the class already belongs to that counselor', async () => {
    const adminToken = await login(await createStaffUser({ role: 'admin' }));
    const counselor = await createStaffUser({ role: 'counselor' });
    const classRoom = await createClass(await login(counselor));

    const response = await api('PATCH', `/admin/classes/${classRoom.id}`, {
      token: adminToken,
      body: { counselor_id: counselor.id },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.counselor_id).toBe(counselor.id);

    expect((await auditFor(classRoom.id)).filter((row) => row.action === 'CLASS_REASSIGNED')).toHaveLength(
      0,
    );
    expect(await notificationsFor(counselor.id)).toHaveLength(0);
  });
});

describe('GET /counselor/classes?counselor_id= (P3-6)', () => {
  it('narrows an admin to one counselor’s classes', async () => {
    const adminToken = await login(await createStaffUser({ role: 'admin' }));
    const first = await createStaffUser({ role: 'counselor' });
    const second = await createStaffUser({ role: 'counselor' });

    const mine = await createClass(await login(first), { name: 'First class' });
    const theirs = await createClass(await login(second), { name: 'Second class' });

    const response = await api('GET', `/counselor/classes?counselor_id=${first.id}&per_page=100`, {
      token: adminToken,
    });

    const ids = response.body.data.items.map((item: { id: string }) => item.id);

    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
  });

  /** A counselor's scope is themselves; the parameter cannot widen or redirect it. */
  it('ignores the filter for a counselor — it can never read a colleague’s classes', async () => {
    const first = await createStaffUser({ role: 'counselor' });
    const firstToken = await login(first);
    const second = await createStaffUser({ role: 'counselor' });

    const mine = await createClass(firstToken, { name: 'Mine' });
    const theirs = await createClass(await login(second), { name: 'Theirs' });

    const response = await api('GET', `/counselor/classes?counselor_id=${second.id}&per_page=100`, {
      token: firstToken,
    });

    const ids = response.body.data.items.map((item: { id: string }) => item.id);

    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
  });
});

describe('DELETE /admin/counselors/:id — the live-class guard (audit F5)', () => {
  it('refuses while the counselor still holds classes, and says how many', async () => {
    const adminToken = await login(await createStaffUser({ role: 'admin' }));
    const counselor = await createStaffUser({ role: 'counselor' });
    const counselorToken = await login(counselor);

    await createClass(counselorToken, { name: 'One' });
    await createClass(counselorToken, { name: 'Two' });

    const response = await api('DELETE', `/admin/counselors/${counselor.id}`, {
      token: adminToken,
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.classes[0]).toContain('2 classes');
    // The remedy is named, because a refusal with no way out is where this defect started.
    expect(response.body.errors.classes[0]).toContain('Reassign');

    // Nothing was half-done: the account is untouched and still signs in.
    expect((await api('GET', '/counselor/classes', { token: counselorToken })).status).toBe(200);
  });

  it('allows removal once every class has been reassigned', async () => {
    const adminToken = await login(await createStaffUser({ role: 'admin' }));
    const leaving = await createStaffUser({ role: 'counselor' });
    const leavingToken = await login(leaving);
    const replacement = await createStaffUser({ role: 'counselor' });

    const classRoom = await createClass(leavingToken);

    expect((await api('DELETE', `/admin/counselors/${leaving.id}`, { token: adminToken })).status).toBe(
      422,
    );

    await api('PATCH', `/admin/classes/${classRoom.id}`, {
      token: adminToken,
      body: { counselor_id: replacement.id },
    });

    expect((await api('DELETE', `/admin/counselors/${leaving.id}`, { token: adminToken })).status).toBe(
      204,
    );

    // The class survived the account it used to belong to — §12's rule, now with an owner.
    const surviving = await api('GET', `/counselor/classes?counselor_id=${replacement.id}`, {
      token: adminToken,
    });

    expect(surviving.body.data.items.map((item: { id: string }) => item.id)).toContain(classRoom.id);
  });

  it('allows removal once the classes are deleted, not only reassigned', async () => {
    const adminToken = await login(await createStaffUser({ role: 'admin' }));
    const counselor = await createStaffUser({ role: 'counselor' });
    const counselorToken = await login(counselor);

    const classRoom = await createClass(counselorToken);

    await api('DELETE', `/counselor/classes/${classRoom.id}`, { token: counselorToken });

    expect((await api('DELETE', `/admin/counselors/${counselor.id}`, { token: adminToken })).status).toBe(
      204,
    );
  });

  /** A counselor who never created one is removable exactly as before — the guard adds no friction. */
  it('removes a counselor with no classes', async () => {
    const adminToken = await login(await createStaffUser({ role: 'admin' }));
    const counselor = await createStaffUser({ role: 'counselor' });

    expect((await api('DELETE', `/admin/counselors/${counselor.id}`, { token: adminToken })).status).toBe(
      204,
    );
  });
});

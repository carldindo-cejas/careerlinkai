import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { aiPolicies, auditLogs } from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { api, createStaffUser, db, login } from '../helpers';

/**
 * The AI policy endpoints (FULLPLAN §13.7, §20): the single GLOBAL row is seeded, listed,
 * and edited — never created or deleted over HTTP (v1.2). The text in this row is injected
 * into every AI prompt (§32), which is why editing it is audited with old and new values.
 */

async function seedPolicy(adminId: string) {
  const id = uuid();
  const timestamp = now();

  await db().insert(aiPolicies).values({
    id,
    scope: 'GLOBAL',
    instructions: 'Always be encouraging.',
    restrictions: 'Never mention tuition fees.',
    isActive: true,
    updatedBy: adminId,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  return id;
}

describe('GET /admin/ai-policies', () => {
  it('lists policies for an admin', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const policyId = await seedPolicy(admin.id);
    const token = await login(admin);

    const response = await api('GET', '/admin/ai-policies', { token });

    expect(response.status).toBe(200);

    const mine = response.body.data.find((policy: any) => policy.id === policyId);

    expect(mine).toMatchObject({
      scope: 'GLOBAL',
      instructions: 'Always be encouraging.',
      restrictions: 'Never mention tuition fees.',
      is_active: true,
    });
  });

  it('is flatly forbidden to a counselor — AI governance is admin-only (§4)', async () => {
    const counselor = await createStaffUser({ role: 'counselor' });
    const token = await login(counselor);

    expect((await api('GET', '/admin/ai-policies', { token })).status).toBe(403);
    expect((await api('PATCH', '/admin/ai-policies/any-id', { token, body: {} })).status).toBe(403);
  });
});

describe('PATCH /admin/ai-policies/{id}', () => {
  it('updates the text and audits old and new values', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const policyId = await seedPolicy(admin.id);
    const token = await login(admin);

    const response = await api('PATCH', `/admin/ai-policies/${policyId}`, {
      token,
      body: { instructions: 'Mention the counselor in every explanation.', is_active: false },
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      instructions: 'Mention the counselor in every explanation.',
      restrictions: 'Never mention tuition fees.', // untouched field survives
      is_active: false,
    });

    const [row] = await db().select().from(aiPolicies).where(eq(aiPolicies.id, policyId));

    expect(row!.isActive).toBe(false);

    const audit = (await db().select().from(auditLogs).where(eq(auditLogs.action, 'AI_POLICY_UPDATED'))).find(
      (entry) => entry.targetId === policyId,
    );

    expect(audit).toBeDefined();
    expect(audit!.oldValues).toMatchObject({ instructions: 'Always be encouraging.' });
    expect(audit!.newValues).toMatchObject({ is_active: false });
  });

  it('rejects an attempt to write `scope` — reserved for §63, refused rather than ignored', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const policyId = await seedPolicy(admin.id);
    const token = await login(admin);

    const response = await api('PATCH', `/admin/ai-policies/${policyId}`, {
      token,
      body: { scope: 'COUNSELOR' },
    });

    expect(response.status).toBe(422);
  });

  it('404s an unknown policy id', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);

    const response = await api('PATCH', `/admin/ai-policies/${uuid()}`, {
      token,
      body: { instructions: 'anything' },
    });

    expect(response.status).toBe(404);
  });
});

import { describe, expect, it } from 'vitest';

import { api, createCollege, createProgram, createStaffUser, login } from '../helpers';

/**
 * `GET /programs/public` (FULLPLAN §20 "Public / Health", Phase 6) — the unauthenticated
 * catalog browse. The active-chain rule is the same one §27 ranks by: what the engine would
 * recommend is what the public may see, and nothing else.
 */

describe('GET /programs/public', () => {
  it('needs no token and serves active programs grouped by college — nothing more', async () => {
    const adminToken = await login(await createStaffUser({ role: 'admin' }));
    const college = await createCollege(adminToken, { name: `Public U ${Date.now()}` });
    const program = await createProgram(adminToken, college.id, { name: 'BS Public Program' });

    // A draft program must not appear: recommendability is a property of the chain (§27).
    await createProgram(adminToken, college.id, { name: 'BS Hidden Draft', status: 'draft' });

    const response = await api('GET', '/programs/public');

    expect(response.status).toBe(200);

    const served = response.body.data.colleges.find((entry: any) => entry.id === college.id);

    expect(served).toBeDefined();
    expect(served.name).toBe(college.name);

    const names = served.programs.map((item: any) => item.name);

    expect(names).toContain('BS Public Program');
    expect(names).not.toContain('BS Hidden Draft');

    // The public shape is thin on purpose: no status, no timestamps, no descriptions.
    const row = served.programs.find((item: any) => item.id === program.id);

    expect(Object.keys(row).sort()).toEqual(['code', 'id', 'name', 'recommended_strand']);
  });
});

import { describe, expect, it } from 'vitest';

import { api, createStaffUser, login } from '../helpers';

/**
 * The authorization matrix for the Address `/admin` group (migration 0011).
 *
 * Load-bearing for the same reason as the catalog's: address data belongs to nobody, so there is
 * no ownership dimension and no per-record policy — `ensureRole('admin')` on the route group is the
 * entire rule. So every endpoint is enumerated rather than spot-checked: a new route added without
 * a guard is exactly the failure this file exists to catch, and it can only catch it by naming them
 * all.
 */

const ENDPOINTS: [string, string][] = [
  ['GET', '/admin/regions'],
  ['POST', '/admin/regions/bulk'],
  ['DELETE', '/admin/regions/some-id'],
  ['GET', '/admin/regions/some-id/provinces'],
  ['POST', '/admin/regions/some-id/provinces/bulk'],
  ['DELETE', '/admin/provinces/some-id'],
  ['GET', '/admin/provinces/some-id/towns'],
  ['POST', '/admin/provinces/some-id/towns/bulk'],
  ['DELETE', '/admin/towns/some-id'],
  ['GET', '/admin/towns/some-id/barangays'],
  ['POST', '/admin/towns/some-id/barangays/bulk'],
  ['DELETE', '/admin/barangays/some-id'],
];

describe('a counselor is refused the Address group entirely', () => {
  it.each(ENDPOINTS)('%s %s → 403', async (method, path) => {
    const token = await login(await createStaffUser({ role: 'counselor' }));

    const response = await api(method, path, {
      token,
      ...(method === 'GET' || method === 'DELETE' ? {} : { body: {} }),
    });

    expect(response.status).toBe(403);
  });
});

describe('an unauthenticated request is refused', () => {
  it.each(ENDPOINTS)('%s %s → 401', async (method, path) => {
    const response = await api(method, path, {
      ...(method === 'GET' || method === 'DELETE' ? {} : { body: {} }),
    });

    expect(response.status).toBe(401);
  });
});

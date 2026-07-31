import { describe, expect, it } from 'vitest';

import { api, createCareer, createCollege, createStaffUser, db, login } from '../helpers';
import { env } from 'cloudflare:test';

/**
 * Migration 0020 — case-insensitive uniqueness for career titles and college names (plan P4-12).
 *
 * The defect this closes shipped three times (P1-0, and twice in P2-2) and was remediated by hand
 * every time. §27 ranks every *active* career into a top ten, so two rows spelling the same career
 * put the same card on a student's recommendations screen twice.
 *
 * These tests are deliberately split by **who is holding the invariant**, because the application
 * pre-check and the database index are two different guards and only one of them is an invariant:
 *
 *   · `assert…Free` is a pre-check. It wins the common case and returns a friendly field-level 422.
 *     Two concurrent writers both pass it.
 *   · The unique index is the floor. It cannot be raced, and it is the only thing that makes the
 *     duplicate state *unreachable* rather than merely unlikely.
 *
 * So the index is asserted directly against SQLite (below) rather than only through the API, where
 * the pre-check would answer first and the index would never be exercised at all.
 */

async function adminToken(): Promise<string> {
  return login(await createStaffUser({ role: 'admin' }));
}

/**
 * Insert a career row straight through D1, bypassing the service.
 *
 * This is how the duplicates that P2-2 found on staging actually arrived — seed 0004 and seed 0002
 * both carrying "Teacher" under different ids, with no unique index to collide on. The API cannot
 * produce this state (the pre-check refuses it), so a test that only drives the API cannot set up
 * the very scenario the migration exists for.
 */
async function insertCareerDirectly(title: string, status: 'active' | 'archived') {
  const timestamp = new Date().toISOString();

  return env.DB.prepare(
    `INSERT INTO careers (id, title, typical_riasec_code, status, created_at, updated_at, deleted_at)
     VALUES (?, ?, 'IEC', ?, ?, ?, NULL)`,
  )
    .bind(crypto.randomUUID(), title, status, timestamp, timestamp)
    .run();
}

describe('migration 0020 — the index holds the invariant', () => {
  it('refuses a case-variant duplicate among active careers, at the database', async () => {
    const title = `Marine Biologist ${crypto.randomUUID().slice(0, 8)}`;

    await insertCareerDirectly(title, 'active');

    // Same career, different case. Nothing in the application is involved in this rejection —
    // this is SQLite refusing to store the row at all.
    await expect(insertCareerDirectly(title.toUpperCase(), 'active')).rejects.toThrow(
      /UNIQUE constraint failed/i,
    );
  });

  it('refuses a whitespace-variant duplicate, which the schema-level trim never sees', async () => {
    const title = `Hydrologist ${crypto.randomUUID().slice(0, 8)}`;

    await insertCareerDirectly(title, 'active');

    // `z.string().trim()` means the API can never submit this, so the TRIM in the index is a guard
    // against the paths that skip the schema entirely — seeds, migrations and direct SQL, which is
    // exactly where all three historical duplicates came from.
    await expect(insertCareerDirectly(`  ${title}  `, 'active')).rejects.toThrow(
      /UNIQUE constraint failed/i,
    );
  });

  it('permits an archived duplicate — the predicate is partial on purpose', async () => {
    const title = `Cartographer ${crypto.randomUUID().slice(0, 8)}`;

    await insertCareerDirectly(title, 'active');

    // This is the state staging is in right now: P2-2 archived its duplicate "Data Scientist" and
    // "TEACHER" rows rather than deleting them, and all four rows still have `deleted_at IS NULL`.
    // An index scoped to `deleted_at IS NULL` alone — the predicate that matches the pre-check, and
    // therefore the obvious one to write — cannot be created on that database at all.
    await expect(insertCareerDirectly(title, 'archived')).resolves.toBeDefined();

    const rows = await db()
      .select()
      .from((await import('@/db/schema')).careers)
      .then((all) => all.filter((row) => row.title === title));

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.status).sort()).toEqual(['active', 'archived']);
  });

  it('refuses a case-variant duplicate among active colleges, at the database', async () => {
    const name = `University of ${crypto.randomUUID().slice(0, 8)}`;
    const timestamp = new Date().toISOString();

    const insert = (value: string) =>
      env.DB.prepare(
        `INSERT INTO colleges (id, name, status, created_at, updated_at, deleted_at)
         VALUES (?, ?, 'active', ?, ?, NULL)`,
      )
        .bind(crypto.randomUUID(), value, timestamp, timestamp)
        .run();

    await insert(name);
    await expect(insert(name.toLowerCase())).rejects.toThrow(/UNIQUE constraint failed/i);
  });
});

describe('the pre-check still answers first, and answers nicely', () => {
  it('rejects a case-variant career title with a field error, not a constraint error', async () => {
    const token = await adminToken();
    const title = `Astronomer ${crypto.randomUUID().slice(0, 8)}`;

    await createCareer(token, { title });

    const response = await api('POST', '/admin/careers', {
      token,
      body: { title: title.toUpperCase(), typical_riasec_code: 'IEC' },
    });

    // 422 from `assertCareerTitleFree`, naming the field — never the 500 a raw SQLite error becomes.
    expect(response.status).toBe(422);
    expect(response.body.errors?.title?.[0]).toMatch(/already in the catalog/i);
  });

  it('rejects a case-variant college name with a field error', async () => {
    const token = await adminToken();
    const name = `Polytechnic of ${crypto.randomUUID().slice(0, 8)}`;

    await createCollege(token, { name });

    const response = await api('POST', '/admin/colleges', {
      token,
      body: { name: name.toLowerCase(), description: 'A duplicate.' },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors?.name?.[0]).toMatch(/already in the catalog/i);
  });
});

describe('reactivating an archived duplicate — the one reachable path to the index', () => {
  /**
   * **The test that justifies the `.catch()` on the update path.**
   *
   * `updateCareer` runs `assertCareerTitleFree` only `if (input.title !== undefined)`. A PATCH that
   * sends *only* `status` therefore skips the pre-check entirely and goes straight to the index —
   * so this is not a hypothetical race, it is a plain request an admin can make from the UI by
   * pressing "Restore" on the archived half of a seed-created pair.
   *
   * Before migration 0020 it silently restored the duplicate. Without the H4 translation beside it
   * it would now return a raw 500. It should return the same 422 the pre-check gives.
   */
  it('refuses with a 422, not a 500', async () => {
    const token = await adminToken();
    const title = `Seismologist ${crypto.randomUUID().slice(0, 8)}`;

    // The staging state, reproduced: one active row and one archived row of the same career.
    await insertCareerDirectly(title, 'active');
    await insertCareerDirectly(title, 'archived');

    const archived = await env.DB.prepare(
      `SELECT id FROM careers WHERE title = ? AND status = 'archived'`,
    )
      .bind(title)
      .first<{ id: string }>();

    expect(archived?.id).toBeDefined();

    const response = await api('PATCH', `/admin/careers/${archived!.id}`, {
      token,
      body: { status: 'active' },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors?.title?.[0]).toMatch(/already in the catalog/i);

    // And the row is genuinely still archived — a 422 that had already written would be worse than
    // the 500 it replaced.
    const after = await env.DB.prepare(`SELECT status FROM careers WHERE id = ?`)
      .bind(archived!.id)
      .first<{ status: string }>();

    expect(after?.status).toBe('archived');
  });

  it('allows the reactivation once the active row is out of the way', async () => {
    const token = await adminToken();
    const title = `Volcanologist ${crypto.randomUUID().slice(0, 8)}`;

    await insertCareerDirectly(title, 'active');
    await insertCareerDirectly(title, 'archived');

    const rows = await env.DB.prepare(
      `SELECT id, status FROM careers WHERE title = ? ORDER BY status`,
    )
      .bind(title)
      .all<{ id: string; status: string }>();

    const active = rows.results.find((row) => row.status === 'active')!;
    const archived = rows.results.find((row) => row.status === 'archived')!;

    // Archive the live one first — the P2-2 remediation, which the partial predicate keeps working.
    const step1 = await api('PATCH', `/admin/careers/${active.id}`, {
      token,
      body: { status: 'archived' },
    });

    expect(step1.status).toBe(200);

    const step2 = await api('PATCH', `/admin/careers/${archived.id}`, {
      token,
      body: { status: 'active' },
    });

    expect(step2.status).toBe(200);
    expect(step2.body.data.status).toBe('active');
  });
});

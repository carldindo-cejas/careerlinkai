import { describe, expect, it } from 'vitest';

import { careers, colleges, programCatalog } from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { chunkForInsert } from '@/lib/d1-batching';
import { now } from '@/lib/datetime';

import { api, createCareer, createCollege, createStaffUser, db, login } from '../helpers';

/**
 * Catalog list search, filter, sort and paging (audit F3 + F4, plan item P3-2).
 *
 * The audit called F3 *live rather than latent*: the mapping picker asked for `per_page: 100`
 * and treated the answer as "every career", which was true at 16 careers and false at 101 —
 * with no error, no empty state and no way to tell from the screen. The first test in
 * `describe('the F3 ceiling')` is that defect, written down.
 */

async function adminToken(): Promise<string> {
  return login(await createStaffUser({ role: 'admin' }));
}

/**
 * Insert careers straight through Drizzle rather than over HTTP.
 *
 * 150 POSTs is 150 authenticated round-trips through the uniqueness check; this is a fixture for a
 * *list* endpoint, and the create path has its own tests. The one thing inserted by hand that
 * matters is `createdAt`: passing a single timestamp for the whole batch is what reproduces seed
 * 0004's tie, which is the subject of `describe('paging is stable')`.
 *
 * **Chunked, and the fixture found out why the hard way.** A 150-row insert binds 11 columns × 150
 * = 1,650 parameters and dies on D1's 100-parameter ceiling — the P2-2 wall, met here by the very
 * test written to prove the catalog can exceed 100 rows. `chunkForInsert` reads the width off the
 * schema, so this survives a new column on `careers`.
 */
async function insertCareers(
  rows: { id?: string; title: string; status?: 'active' | 'archived'; createdAt?: string }[],
): Promise<void> {
  const timestamp = now();

  const values = rows.map((row) => ({
    id: row.id ?? uuid(),
    title: row.title,
    status: row.status ?? ('active' as const),
    typicalRiasecCode: 'IEC',
    createdAt: row.createdAt ?? timestamp,
    updatedAt: row.createdAt ?? timestamp,
    deletedAt: null,
  }));

  for (const chunk of chunkForInsert(values, careers)) {
    await db().insert(careers).values(chunk);
  }
}

describe('GET /admin/careers — search', () => {
  it('matches a substring of the title, case-insensitively', async () => {
    const token = await adminToken();

    await insertCareers([
      { title: 'Marine Biologist' },
      { title: 'Molecular Biologist' },
      { title: 'Civil Engineer' },
    ]);

    const response = await api('GET', '/admin/careers?search=BIOLOG', { token });
    const titles = response.body.data.items.map((item: any) => item.title);

    expect(response.status).toBe(200);
    expect(titles).toEqual(['Marine Biologist', 'Molecular Biologist']);
    expect(response.body.data.pagination.total).toBe(2);
  });

  it('reports the filtered total, not the table total', async () => {
    const token = await adminToken();

    await insertCareers([
      { title: 'Nurse' },
      { title: 'Nurse Practitioner' },
      { title: 'Chemist' },
    ]);

    const { body } = await api('GET', '/admin/careers?search=nurse&per_page=1', { token });

    // The pager has to know there is a second page of *matches*. A total that counted the whole
    // table would offer pages that come back empty; one that counted the returned page would hide
    // the second match behind a Next button that never appears.
    expect(body.data.pagination.total).toBe(2);
    expect(body.data.pagination.last_page).toBe(2);
    expect(body.data.items).toHaveLength(1);
  });

  it('treats % and _ in the term as characters to find, not as wildcards', async () => {
    const token = await adminToken();

    await insertCareers([
      { title: '100% Remote Analyst' },
      { title: '100 Metre Sprinter' },
      { title: 'Data_Engineer' },
      { title: 'DataXEngineer' },
    ]);

    // Unescaped, `100%` is the pattern "starts with 100" and matches both.
    const percent = await api('GET', '/admin/careers?search=100%25', { token });

    expect(percent.body.data.items.map((item: any) => item.title)).toEqual([
      '100% Remote Analyst',
    ]);

    // Unescaped, `_` is "any one character" and matches both.
    const underscore = await api('GET', '/admin/careers?search=Data_Engineer', { token });

    expect(underscore.body.data.items.map((item: any) => item.title)).toEqual([
      'Data_Engineer',
    ]);
  });

  it('an empty ?search= is no filter at all, not a filter on the empty string', async () => {
    const token = await adminToken();

    await insertCareers([{ title: 'Architect' }, { title: 'Pilot' }]);

    // Asserted against the unfiltered list rather than a number, because the claim *is* "these two
    // requests are the same request". `?search=` is what a cleared search box sends.
    const cleared = await api('GET', '/admin/careers?search=&per_page=100', { token });
    const absent = await api('GET', '/admin/careers?per_page=100', { token });

    expect(cleared.body.data.pagination.total).toBe(absent.body.data.pagination.total);
    expect(cleared.body.data.items.map((item: any) => item.id)).toEqual(
      absent.body.data.items.map((item: any) => item.id),
    );
    expect(cleared.body.data.pagination.total).toBeGreaterThanOrEqual(2);
  });

  it('excludes soft-deleted careers from matches', async () => {
    const token = await adminToken();
    const career = await createCareer(token, { title: 'Cartographer' });

    await api('DELETE', `/admin/careers/${career.id}`, { token });

    const { body } = await api('GET', '/admin/careers?search=Cartographer', { token });

    expect(body.data.items).toEqual([]);
  });
});

describe('GET /admin/careers — status filter', () => {
  it('narrows to one status and leaves the rest out', async () => {
    const token = await adminToken();

    await insertCareers([
      { title: 'Zoologist Active' },
      { title: 'Zoologist Retired', status: 'archived' },
    ]);

    const active = await api('GET', '/admin/careers?status=active&search=Zoologist', { token });
    const archived = await api('GET', '/admin/careers?status=archived&search=Zoologist', {
      token,
    });
    const both = await api('GET', '/admin/careers?search=Zoologist', { token });

    expect(active.body.data.items.map((item: any) => item.title)).toEqual(['Zoologist Active']);
    expect(archived.body.data.items.map((item: any) => item.title)).toEqual([
      'Zoologist Retired',
    ]);
    expect(both.body.data.pagination.total).toBe(2);
  });

  it('rejects a status that is not a catalog status', async () => {
    const token = await adminToken();

    const response = await api('GET', '/admin/careers?status=deleted', { token });

    expect(response.status).toBe(422);
    expect(response.body.errors.status).toBeDefined();
  });
});

describe('GET /admin/careers — sort', () => {
  it('sorts by title in both directions', async () => {
    const token = await adminToken();

    await insertCareers([
      { title: 'Sort Beta' },
      { title: 'Sort Alpha' },
      { title: 'Sort Gamma' },
    ]);

    const asc = await api('GET', '/admin/careers?search=Sort%20&sort=name&direction=asc', {
      token,
    });
    const desc = await api('GET', '/admin/careers?search=Sort%20&sort=name&direction=desc', {
      token,
    });

    expect(asc.body.data.items.map((item: any) => item.title)).toEqual([
      'Sort Alpha',
      'Sort Beta',
      'Sort Gamma',
    ]);
    expect(desc.body.data.items.map((item: any) => item.title)).toEqual([
      'Sort Gamma',
      'Sort Beta',
      'Sort Alpha',
    ]);
  });

  it('sorts by created_at', async () => {
    const token = await adminToken();

    await insertCareers([
      { title: 'Aged Oldest', createdAt: '2020-01-01T00:00:00.000Z' },
      { title: 'Aged Newest', createdAt: '2026-01-01T00:00:00.000Z' },
      { title: 'Aged Middle', createdAt: '2023-01-01T00:00:00.000Z' },
    ]);

    const { body } = await api(
      'GET',
      '/admin/careers?search=Aged&sort=created_at&direction=desc',
      {
        token,
      },
    );

    expect(body.data.items.map((item: any) => item.title)).toEqual([
      'Aged Newest',
      'Aged Middle',
      'Aged Oldest',
    ]);
  });

  it('refuses a sort column that is not on the allow-list', async () => {
    const token = await adminToken();

    const response = await api('GET', '/admin/careers?sort=salary_min', { token });

    // 422 rather than a 500 or a silently ignored parameter: `?sort=` names a column, and the
    // allow-list is the only thing stopping it naming any column at all.
    expect(response.status).toBe(422);
    expect(response.body.errors.sort).toBeDefined();
  });

  it('refuses a search term past the length cap', async () => {
    const token = await adminToken();

    const response = await api(`GET`, `/admin/careers?search=${'x'.repeat(201)}`, { token });

    expect(response.status).toBe(422);
    expect(response.body.errors.search).toBeDefined();
  });
});

describe('GET /admin/careers — paging is stable when the sort column ties', () => {
  /**
   * Seed 0004 inserts all 68 of its careers in **one statement**, and SQLite evaluates `'now'`
   * once per statement — so every seeded career carries a byte-identical `created_at`. Sorting on
   * a column where every row ties leaves the order unspecified, and unspecified *per execution*:
   * page one and page two are two queries, so a row can land on both while another lands on
   * neither. That reads as data loss and does not reproduce on demand.
   *
   * The ids below are inserted in descending order so that "the order rows happen to be stored in"
   * is the opposite of the answer, and a passing result cannot be an accident of insertion order.
   */
  /**
   * Ids descend while the label ascends, so "the order the rows are stored in" is the opposite of
   * the expected answer and a pass cannot be an accident of insertion order. Each test gets its own
   * `group` because isolation here is per *file*: two tests sharing one id set collide on the
   * primary key.
   */
  async function insertTied(group: string): Promise<string[]> {
    const ids = ['ee', 'dd', 'cc', 'bb', 'aa'].map(
      (prefix, index) => `${prefix}${group}0000-0000-4000-8000-00000000000${index + 1}`,
    );

    await insertCareers(
      ids.map((id, index) => ({
        id,
        title: `Tied ${group} ${index}`,
        createdAt: '2026-02-02T00:00:00.000Z',
      })),
    );

    return ids;
  }

  it('breaks the tie on id, so the order is total', async () => {
    const token = await adminToken();
    const ids = await insertTied('a1');

    const { body } = await api('GET', '/admin/careers?search=Tied%20a1&sort=created_at', {
      token,
    });

    expect(body.data.items.map((item: any) => item.id)).toEqual([...ids].reverse());
  });

  it('walks every tied row exactly once across pages', async () => {
    const token = await adminToken();
    const ids = await insertTied('b2');

    const seen: string[] = [];

    for (const page of [1, 2, 3]) {
      const { body } = await api(
        'GET',
        `/admin/careers?search=Tied%20b2&sort=created_at&per_page=2&page=${page}`,
        { token },
      );

      seen.push(...body.data.items.map((item: any) => item.id));
    }

    // The claim: five rows, five distinct rows, in one order. Without the tie-break, "appears on
    // two pages" and "appears on none" are both permitted by the query.
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual([...ids].reverse());
  });
});

describe('the F3 ceiling', () => {
  /**
   * The audit's own verify line: *"seed 150+ careers → picker finds #150 by typing."*
   *
   * Both halves are asserted, because only the pair says anything. The second is the defect as it
   * shipped — a request for `per_page: 100` believing it to be "all of them" — and it is expected
   * to *fail* to find the career. The first is the picker's new behaviour on the same data.
   */
  it('a career past the per_page ceiling is unreachable by paging and reachable by searching', async () => {
    const token = await adminToken();

    // 149 fillers sorted before the target, so the target is #150 by title and lands on page 2
    // of any 100-row window — exactly where the old picker could not see it. Every title shares a
    // prefix so the assertion counts this test's 150 rows and not the file's other fixtures.
    await insertCareers([
      ...Array.from({ length: 149 }, (_, index) => ({
        title: `Picker Filler ${String(index).padStart(3, '0')}`,
      })),
      { title: 'Picker Zythologist' },
    ]);

    const oldPicker = await api('GET', '/admin/careers?search=Picker&per_page=100', { token });

    expect(oldPicker.body.data.items).toHaveLength(100);
    expect(oldPicker.body.data.pagination.total).toBe(150);
    expect(oldPicker.body.data.items.map((item: any) => item.title)).not.toContain(
      'Picker Zythologist',
    );

    const typeahead = await api(
      'GET',
      '/admin/careers?search=zytho&status=active&per_page=20',
      {
        token,
      },
    );

    expect(typeahead.body.data.items.map((item: any) => item.title)).toEqual([
      'Picker Zythologist',
    ]);
  });

  it('caps per_page at 100 with a 422 rather than serving the whole table', async () => {
    const token = await adminToken();

    const response = await api('GET', '/admin/careers?per_page=1000', { token });

    expect(response.status).toBe(422);
    expect(response.body.errors.per_page).toBeDefined();
  });
});

describe('GET /admin/colleges — search', () => {
  it('matches the college name and reports the filtered total', async () => {
    const token = await adminToken();

    await createCollege(token, { name: 'Mindanao State University' });
    await createCollege(token, { name: 'Mindanao Polytechnic' });
    await createCollege(token, { name: 'Cebu Normal University' });

    const { body } = await api('GET', '/admin/colleges?search=mindanao', { token });

    expect(body.data.items.map((item: any) => item.name)).toEqual([
      'Mindanao Polytechnic',
      'Mindanao State University',
    ]);
    expect(body.data.pagination.total).toBe(2);
  });

  it('keeps programs_count correct under a filter', async () => {
    const token = await adminToken();
    const college = await createCollege(token, { name: 'Counted University' });

    await api('POST', `/admin/colleges/${college.id}/programs`, {
      token,
      body: { code: 'BSCS', name: 'BS Computer Science' },
    });

    const { body } = await api('GET', '/admin/colleges?search=Counted', { token });

    // The count is a second query keyed off the returned page's ids — a filter that narrowed the
    // rows but not the id list would report every college's programs against the one shown.
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].programs_count).toBe(1);
  });

  it('does not match the description', async () => {
    const token = await adminToken();

    await createCollege(token, {
      name: 'Silliman University',
      description: 'A university in Dumaguete.',
    });

    const { body } = await api('GET', '/admin/colleges?search=Dumaguete', { token });

    expect(body.data.items).toEqual([]);
  });
});

describe('GET /admin/canonical-programs — search', () => {
  async function insertCanonical(rows: { code: string; name: string }[]): Promise<void> {
    const timestamp = now();

    await db()
      .insert(programCatalog)
      .values(
        rows.map((row) => ({
          id: uuid(),
          code: row.code,
          name: row.name,
          description: null,
          status: 'active' as const,
          createdAt: timestamp,
          updatedAt: timestamp,
          deletedAt: null,
        })),
      );
  }

  it('matches the name or the code', async () => {
    const token = await adminToken();

    await insertCanonical([
      { code: 'BSMARE', name: 'BS Marine Engineering' },
      { code: 'ABCOMM', name: 'AB Communication' },
    ]);

    const byName = await api('GET', '/admin/canonical-programs?search=marine', { token });
    const byCode = await api('GET', '/admin/canonical-programs?search=ABCOMM', { token });

    expect(byName.body.data.items.map((item: any) => item.code)).toEqual(['BSMARE']);
    expect(byCode.body.data.items.map((item: any) => item.name)).toEqual(['AB Communication']);
  });

  it('sorts by code, which the shared catalog allow-list does not offer', async () => {
    const token = await adminToken();

    await insertCanonical([
      { code: 'ZZTOP', name: 'Sorted Last By Code' },
      { code: 'AATOP', name: 'Sorted First By Code' },
    ]);

    // Scoped by search: entries created earlier in this file are still in the table (isolation is
    // per file, not per test), and an unscoped `slice(0, 2)` would be reading them instead.
    const response = await api(
      'GET',
      '/admin/canonical-programs?search=TOP&sort=code&direction=asc',
      {
        token,
      },
    );

    expect(response.status).toBe(200);
    expect(response.body.data.items.map((item: any) => item.code)).toEqual(['AATOP', 'ZZTOP']);

    // …and the same value is refused on the lists that have no `code` column to sort by, rather
    // than being accepted and quietly sorting by something else.
    const careersSorted = await api('GET', '/admin/careers?sort=code', { token });

    expect(careersSorted.status).toBe(422);
  });

  it('keeps offerings_count correct under a filter', async () => {
    const token = await adminToken();
    const college = await createCollege(token);

    await api('POST', `/admin/colleges/${college.id}/programs`, {
      token,
      body: { code: 'BSHRM', name: 'BS Hotel and Restaurant Management' },
    });

    const { body } = await api('GET', '/admin/canonical-programs?search=BSHRM', { token });

    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].offerings_count).toBe(1);
  });
});

describe('GET /admin/canonical-programs/options — the merge target typeahead', () => {
  /**
   * This endpoint used to return **every** active canonical entry with no limit, described in the
   * source as "the unpaginated picker for the program form's combobox" — which was untrue twice
   * over: the program form never called it (nothing did), and the 0018 backfill mints a new entry
   * for every unseen programme code an admin types, so the row count is driven by data entry and
   * had no ceiling anywhere between the database and the browser.
   */
  async function insertCanonicalOptions(count: number, prefix: string): Promise<void> {
    const timestamp = now();

    const values = Array.from({ length: count }, (_, index) => ({
      id: uuid(),
      code: `${prefix}${String(index).padStart(3, '0')}`,
      name: `${prefix} Program ${String(index).padStart(3, '0')}`,
      description: null,
      status: 'active' as const,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    }));

    for (const chunk of chunkForInsert(values, programCatalog)) {
      await db().insert(programCatalog).values(chunk);
    }
  }

  it('caps the response instead of returning the whole table', async () => {
    const token = await adminToken();

    await insertCanonicalOptions(35, 'CAPPED');

    const { body } = await api('GET', '/admin/canonical-programs/options', { token });

    expect(body.data).toHaveLength(20);
  });

  /**
   * The cap is only defensible because search reaches past it — otherwise it would have converted
   * an unbounded response into a silently truncated one, which is audit F3 exactly.
   */
  it('finds an entry that the cap excludes, by searching for it', async () => {
    const token = await adminToken();

    await insertCanonicalOptions(30, 'AAFILLER');
    await db()
      .insert(programCatalog)
      .values({
        id: uuid(),
        code: 'ZZRARE',
        name: 'ZZ Rare Programme',
        description: null,
        status: 'active' as const,
        createdAt: now(),
        updatedAt: now(),
        deletedAt: null,
      });

    const capped = await api('GET', '/admin/canonical-programs/options', { token });

    expect(capped.body.data.map((row: any) => row.code)).not.toContain('ZZRARE');

    const searched = await api('GET', '/admin/canonical-programs/options?search=zzrare', {
      token,
    });

    expect(searched.body.data.map((row: any) => row.code)).toEqual(['ZZRARE']);
  });

  it('carries the offerings count, so a merge candidate is not a bare name', async () => {
    const token = await adminToken();
    const college = await createCollege(token);

    await api('POST', `/admin/colleges/${college.id}/programs`, {
      token,
      body: { code: 'BSCOUNTED', name: 'BS Counted' },
    });

    const { body } = await api('GET', '/admin/canonical-programs/options?search=BSCOUNTED', {
      token,
    });

    expect(body.data).toHaveLength(1);
    expect(body.data[0].offerings_count).toBe(1);
  });

  it('offers active entries only', async () => {
    const token = await adminToken();

    const created = await api('POST', '/admin/canonical-programs', {
      token,
      body: { code: 'RETIREDCODE', name: 'Retired Programme' },
    });

    await api('PATCH', `/admin/canonical-programs/${created.body.data.id}`, {
      token,
      body: { status: 'archived' },
    });

    const { body } = await api('GET', '/admin/canonical-programs/options?search=RETIRED', {
      token,
    });

    expect(body.data).toEqual([]);
  });
});

describe('the search predicate is shared, so every list refuses the same bad input', () => {
  it('rejects an unknown sort on colleges and canonical programs too', async () => {
    const token = await adminToken();

    for (const path of ['/admin/colleges', '/admin/canonical-programs']) {
      const response = await api('GET', `${path}?sort=description`, { token });

      expect(response.status).toBe(422);
    }
  });

  it('leaves the unfiltered default list alone', async () => {
    const token = await adminToken();

    await db()
      .insert(colleges)
      .values({
        id: uuid(),
        name: 'Default Listing University',
        description: null,
        status: 'active' as const,
        createdAt: now(),
        updatedAt: now(),
        deletedAt: null,
      });

    const { body } = await api('GET', '/admin/colleges', { token });

    // No query string at all still means page 1, 20 per page, by name ascending — the behaviour
    // every existing caller was written against.
    expect(body.data.pagination).toMatchObject({ current_page: 1, per_page: 20 });
    expect(body.data.items.map((item: any) => item.name)).toContain(
      'Default Listing University',
    );
  });
});

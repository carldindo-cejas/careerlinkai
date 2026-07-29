import { describe, expect, it } from 'vitest';

// A plain .mjs script module with no type declarations. Kept on one line because
// `@ts-expect-error` suppresses the *next line*, and the diagnostic lands on the `from` clause —
// so a wrapped import moves the error out from under its own suppression. Same reasoning as
// backup-verification.test.ts: exercise the module the gate actually loads, not a re-implementation.
// @ts-expect-error — untyped .mjs, deliberately
import { analyzeRoutes, ROUTE_GROUPS, STUDENT_GROUPS } from '../../scripts/lib/route-weight.mjs';

/**
 * **The route-weight gate, fired red** (plan P3-3, audit P2; the P1-3 rule applied again).
 *
 * P3-3 split one 929 KiB chunk — every admin, counselor and student page — into seven route
 * groups behind `import()`. The split is worth exactly nothing the day it silently comes back,
 * and it comes back **quietly**: one `import { AdminLayout } from '@/routes/groups/admin'` typed
 * into a file the entry chunk already reaches folds the entire admin shell into the first bytes
 * every visitor downloads. `npm run build` succeeds. `tsc` is happy. All 171 frontend tests pass.
 * The only witness is a number in a build log, which is precisely what audit P1 proved nobody
 * reads.
 *
 * So the gate reads Vite's manifest and asserts the shape. Proving *that* gate works would
 * otherwise mean committing a deliberately broken frontend, so `analyzeRoutes` is pure and takes
 * its sizes through a callback, and every predicate is fired here against a manifest that is
 * wrong in one specific way.
 */

interface ManifestEntry {
  file: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
}

/**
 * A manifest in the shape Vite actually emits for this app: one entry chunk, a shared chunk it
 * statically imports, and one dynamic entry per route group.
 */
function manifestOf(overrides: Record<string, Partial<ManifestEntry>> = {}) {
  const manifest: Record<string, ManifestEntry> = {
    'index.html': {
      file: 'assets/index.js',
      isEntry: true,
      imports: ['_shared.js'],
      dynamicImports: ROUTE_GROUPS.map((group: { src: string }) => group.src),
      css: ['assets/index.css'],
    },
    '_shared.js': { file: 'assets/shared.js' },
  };

  for (const group of ROUTE_GROUPS as { name: string; src: string }[]) {
    manifest[group.src] = {
      file: `assets/${group.name}.js`,
      isDynamicEntry: true,
      imports: ['index.html', '_shared.js'],
    };
  }

  for (const [key, patch] of Object.entries(overrides)) {
    manifest[key] = { ...manifest[key], ...patch } as ManifestEntry;
  }

  return manifest;
}

/** Every file is 1 000 bytes unless named otherwise — so the arithmetic is readable. */
function sizes(custom: Record<string, number> = {}) {
  return (file: string) => custom[file] ?? 1000;
}

describe('analyzeRoutes — structure', () => {
  it('reports no problem for a manifest with every group split', () => {
    const report = analyzeRoutes(manifestOf(), sizes());

    expect(report.problems).toEqual([]);
    expect(report.groups).toHaveLength(ROUTE_GROUPS.length);
  });

  /**
   * The defect this whole gate exists for: a group reached by a *static* import from something the
   * entry already loads. Vite drops `isDynamicEntry` and folds the group into the importer, so the
   * chunk simply stops existing as its own file — there is nothing in `dist/` to weigh and nothing
   * in the build log that says a route group went missing, only an entry chunk that grew.
   */
  it('fails when a group has been folded into the entry chunk', () => {
    const folded = manifestOf({
      'index.html': { imports: ['_shared.js', 'src/routes/groups/admin.ts'] },
      'src/routes/groups/admin.ts': { isDynamicEntry: false },
    });

    const report = analyzeRoutes(folded, sizes());

    expect(report.problems).toHaveLength(2);
    expect(report.problems.join(' ')).toContain('not a dynamic entry');
    expect(report.problems.join(' ')).toContain("entry chunk's static closure");
  });

  /**
   * The two halves above are checked separately on purpose, and this is why: a group can be inside
   * the entry's closure while *still* being a dynamic entry — imported statically by one file and
   * lazily by the router. Vite keeps the chunk, so the build log still shows `admin-*.js` at its
   * usual size and the split looks intact; the group is just downloaded eagerly as well. A single
   * combined predicate would have to pick one message, and it would pick the wrong one here.
   */
  it('fails on an eagerly-reached group even though its chunk still exists', () => {
    const both = manifestOf({
      'index.html': { imports: ['_shared.js', 'src/routes/groups/student.ts'] },
    });

    const report = analyzeRoutes(both, sizes());

    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain("entry chunk's static closure");
    expect(report.problems[0]).toContain('student');
  });

  /**
   * A group that is listed but absent. This is the failure mode of *discovering* the groups from
   * the manifest instead of listing them: discovery would report "all 6 groups are split" and pass.
   */
  it('fails when a declared route group is missing from the manifest', () => {
    const manifest = manifestOf();
    delete manifest['src/routes/groups/counselor.ts'];

    const report = analyzeRoutes(manifest, sizes());

    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain('counselor');
    expect(report.problems[0]).toContain('not in the manifest');
  });

  it('refuses to measure a manifest with no single entry chunk', () => {
    const twoEntries = manifestOf({ 'src/routes/groups/admin.ts': { isEntry: true } });

    expect(analyzeRoutes(twoEntries, sizes()).problems[0]).toContain('exactly one entry chunk');
    expect(analyzeRoutes(twoEntries, sizes()).entry).toBeNull();

    const noEntry = manifestOf({ 'index.html': { isEntry: false } });

    expect(analyzeRoutes(noEntry, sizes()).problems[0]).toContain('exactly one entry chunk');
  });
});

describe('analyzeRoutes — weight', () => {
  /**
   * The closure is transitive, which is the only reason the number means anything: the group chunk
   * itself is rarely where the weight is. `student-*.js` is 48 KiB and a student screen costs
   * 507 KiB, because the chunks it reaches through — React, the shared app runtime, the stylesheet
   * — are the other 459.
   */
  it('charges a route for everything it transitively reaches', () => {
    const manifest = manifestOf({
      'src/routes/groups/student.ts': { imports: ['index.html', '_shared.js', '_deep.js'] },
      '_deep.js': { file: 'assets/deep.js', imports: ['_deeper.js'] },
      '_deeper.js': { file: 'assets/deeper.js' },
    });

    const report = analyzeRoutes(manifest, sizes({ 'assets/deeper.js': 50_000 }));
    const student = report.groups.find((group: { name: string }) => group.name === 'student');

    // entry(1000) + shared(1000) + student(1000) + deep(1000) + deeper(50000) + css(1000)
    expect(student.cold.total).toBe(55_000);
    expect(student.cold.js).toBe(54_000);
    expect(student.cold.css).toBe(1000);
  });

  /** The stylesheet is one file shared by every route — counted once, not once per chunk. */
  it('counts a shared stylesheet once', () => {
    const manifest = manifestOf({
      'src/routes/groups/admin.ts': { css: ['assets/index.css'] },
    });

    const report = analyzeRoutes(manifest, sizes({ 'assets/index.css': 40_000 }));
    const admin = report.groups.find((group: { name: string }) => group.name === 'admin');

    expect(admin.cold.css).toBe(40_000);
  });

  /**
   * `own` is what the split actually bought: the part of a route that is *not* already in the entry.
   * Reported beside the cold load because the two answer different questions — "what does this
   * screen cost" and "what would folding it back into the entry add to every other screen".
   */
  it('separates a group’s own weight from the entry it shares', () => {
    const report = analyzeRoutes(manifestOf(), sizes({ 'assets/admin.js': 9000 }));
    const admin = report.groups.find((group: { name: string }) => group.name === 'admin');

    expect(admin.own.js).toBe(9000);
    expect(admin.own.chunks).toBe(1);
    // entry(1000) + shared(1000) + admin(9000) + css(1000)
    expect(admin.cold.total).toBe(12_000);
  });

  /**
   * The student path is the union of `access` and `student`, not their sum — they share the entry
   * and the shared runtime, and adding the two cold loads would charge a student twice for React.
   */
  it('unions the student groups rather than adding them', () => {
    expect(STUDENT_GROUPS).toEqual(['access', 'student']);

    const report = analyzeRoutes(
      manifestOf(),
      sizes({ 'assets/access.js': 4000, 'assets/student.js': 48_000 }),
    );

    const access = report.groups.find((group: { name: string }) => group.name === 'access');
    const student = report.groups.find((group: { name: string }) => group.name === 'student');

    // entry(1000) + shared(1000) + access(4000) + student(48000) + css(1000)
    expect(report.student.total).toBe(55_000);
    expect(report.student.total).toBeLessThan(access.cold.total + student.cold.total);
    expect(report.studentScreen.total).toBe(student.cold.total);
  });

  /**
   * A manifest naming a chunk that is not in it means the file was read from a different build than
   * `dist/` holds — a stale `dist/.vite/` beside fresh assets, which is what a partial or
   * interrupted build leaves behind. Sizing that would throw ENOENT deep inside the walk; saying so
   * is better.
   */
  it('reports a dangling import rather than failing to size it', () => {
    const report = analyzeRoutes(
      manifestOf({ 'index.html': { imports: ['_shared.js', '_vanished.js'] } }),
      sizes(),
    );

    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain('_vanished.js');
    expect(report.problems[0]).toContain('not in the manifest');
  });
});

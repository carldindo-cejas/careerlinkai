/**
 * What one route costs a browser (plan P3-3, audit P2).
 *
 * The asset gate P1-3 added weighs **files**. That is the right instrument for audit P1 (one
 * 3.26 MB PNG) and the wrong one for audit P2, and the difference is not academic: 921 KiB of
 * route code split into seven 130 KiB chunks that every visitor downloads anyway would pass a
 * per-file budget of any size while costing exactly what it cost before. The number that matters
 * is the *closure* — everything the browser must have in hand before a given screen can paint.
 *
 * That closure is a fact about static versus dynamic import edges, and `dist/` does not record
 * which is which; both compile to a URL in a chunk. So this reads Vite's build manifest, where
 * `imports` (static — the browser fetches these before the module evaluates) and `dynamicImports`
 * (`import()` — fetched only if something calls it) are kept apart by the bundler that made the
 * decision. Answering it by scraping minified output instead would make the budget depend on how
 * the minifier spelled an import this week.
 *
 * Pure, and takes its file sizes through `sizeOf`, so `test/platform/route-weight.test.ts` can
 * fire every predicate against a synthetic manifest — proving the gate red before it is trusted
 * (P1-3's rule) without having to build a deliberately broken frontend to do it.
 */

/**
 * The route groups `frontend/src/routes/router.tsx` lazy-loads, by barrel path.
 *
 * Listed here rather than discovered, so that a group **disappearing** is a failure. Discovery
 * would report "all 6 groups are split" the day someone folds the seventh back into the entry
 * chunk — a green gate describing a bundle that grew.
 */
export const ROUTE_GROUPS = [
  { name: 'public', src: 'src/routes/groups/public.ts', screen: '/' },
  { name: 'auth', src: 'src/routes/groups/auth.ts', screen: '/login' },
  { name: 'access', src: 'src/routes/groups/access.ts', screen: '/join' },
  { name: 'admin', src: 'src/routes/groups/admin.ts', screen: '/admin' },
  { name: 'counselor', src: 'src/routes/groups/counselor.ts', screen: '/counselor' },
  { name: 'builder', src: 'src/routes/groups/builder.ts', screen: '/admin/assessment-templates' },
  { name: 'student', src: 'src/routes/groups/student.ts', screen: '/student/recommendations' },
];

/**
 * The student path, named rather than derived.
 *
 * A student signs in at `/join` (`access`) and then lives in the student shell (`student`), so
 * these two groups plus the entry are everything a student ever downloads. `student` alone is the
 * cold-load cost of a student screen — a refresh on `/student/recommendations`, or the link a
 * counselor sends — and is the number audit P2 is about.
 */
export const STUDENT_GROUPS = ['access', 'student'];
export const STUDENT_SCREEN_GROUP = 'student';

/** The transitive closure of **static** imports from a set of manifest keys. */
function staticClosure(manifest, startKeys) {
  const seen = new Set();
  const queue = [...startKeys];
  const missing = [];

  while (queue.length > 0) {
    const key = queue.shift();

    if (seen.has(key)) {
      continue;
    }

    const entry = manifest[key];

    if (entry === undefined) {
      missing.push(key);
      continue;
    }

    seen.add(key);
    queue.push(...(entry.imports ?? []));
  }

  return { keys: seen, missing };
}

function weigh(manifest, keys, sizeOf) {
  let js = 0;
  const styles = new Set();

  for (const key of keys) {
    js += sizeOf(manifest[key].file);

    for (const file of manifest[key].css ?? []) {
      styles.add(file);
    }
  }

  let css = 0;

  for (const file of styles) {
    css += sizeOf(file);
  }

  return { js, css, total: js + css, chunks: keys.size };
}

/**
 * @param manifest  Parsed `dist/.vite/manifest.json`.
 * @param sizeOf    `(file) => bytes`, relative to `dist/`.
 * @param groups    Defaults to ROUTE_GROUPS; injectable for tests.
 */
export function analyzeRoutes(manifest, sizeOf, groups = ROUTE_GROUPS) {
  const entryKeys = Object.keys(manifest).filter((key) => manifest[key].isEntry === true);
  const problems = [];

  if (entryKeys.length !== 1) {
    problems.push(
      `expected exactly one entry chunk in the manifest, found ${entryKeys.length}` +
        (entryKeys.length > 1 ? ` (${entryKeys.join(', ')})` : ''),
    );

    return { problems, entry: null, groups: [], student: null, studentScreen: null };
  }

  const entryKey = entryKeys[0];
  const entry = staticClosure(manifest, [entryKey]);

  for (const key of entry.missing) {
    problems.push(`entry chunk imports "${key}", which is not in the manifest`);
  }

  const analyzed = [];

  for (const group of groups) {
    const record = manifest[group.src];

    if (record === undefined) {
      problems.push(
        `route group "${group.name}" (${group.src}) is not in the manifest — it was renamed, deleted, or is no longer reached by a dynamic import`,
      );
      continue;
    }

    // A barrel that is *only* statically imported loses `isDynamicEntry` and is folded into
    // whatever imported it. That is exactly how a code split dies quietly, so it is checked
    // separately from the closure test below — the two fail for different reasons and the
    // message should say which.
    if (record.isDynamicEntry !== true) {
      problems.push(
        `route group "${group.name}" is not a dynamic entry — something imports @/routes/groups/${group.name} statically, so it now ships inside another chunk`,
      );
    }

    // The silent death: a static import from anywhere in the entry's own closure pulls the whole
    // group forward into the first byte every visitor downloads. The bundle still builds, every
    // test still passes, and the split is gone.
    if (entry.keys.has(group.src)) {
      problems.push(
        `route group "${group.name}" is inside the entry chunk's static closure — every visitor now downloads it, whatever route they asked for`,
      );
    }

    const closure = staticClosure(manifest, [group.src]);
    const cold = new Set([...entry.keys, ...closure.keys]);
    const own = new Set([...closure.keys].filter((key) => !entry.keys.has(key)));

    analyzed.push({
      ...group,
      chunk: record.file,
      cold: weigh(manifest, cold, sizeOf),
      own: weigh(manifest, own, sizeOf),
      keys: cold,
    });
  }

  const byName = new Map(analyzed.map((group) => [group.name, group]));

  const studentKeys = new Set(entry.keys);

  for (const name of STUDENT_GROUPS) {
    for (const key of byName.get(name)?.keys ?? []) {
      studentKeys.add(key);
    }
  }

  return {
    problems,
    entry: { key: entryKey, chunk: manifest[entryKey].file, ...weigh(manifest, entry.keys, sizeOf) },
    groups: analyzed,
    student: weigh(manifest, studentKeys, sizeOf),
    studentScreen: byName.get(STUDENT_SCREEN_GROUP)?.cold ?? null,
  };
}

/**
 * Verifies that the generated knowledge corpus actually covers the catalog.
 *
 * ## Why this exists
 *
 * `syncCatalogKnowledge` reports `changed` / `retired` / `remaining` counters, and those tell you
 * the run did something — not that the corpus is complete or that what it says is true. The
 * difference matters because the failure this checks for is silent: the sync writes 20 entries per
 * invocation and queues its own continuation, so a dropped queue message leaves a *partial* corpus
 * that reports success. On 2026-09-05 the symptom was **Explain more** citing institutions the
 * catalog had already deleted, and nothing in the sync's own output said anything was wrong.
 *
 * So this asks the database the question the counters cannot answer: is there a live, COMPLETED,
 * embedded knowledge document for every active college, program and career — and does its text
 * contain the facts a student would ask for?
 *
 *     node scripts/verify-catalog-corpus.mjs --env production
 *     node scripts/verify-catalog-corpus.mjs --local
 *
 * Read-only. It runs `wrangler d1 execute` and writes nothing.
 *
 * ## What "covered" means here
 *
 * Four properties, in order of how badly their absence bites:
 *
 *   1. **Every subject has a live entry.** A career with no document cannot be explained, and
 *      `Explain more` refuses rather than guessing (D4) — so a gap here is a dead button.
 *   2. **Every entry finished processing.** `processing_status = COMPLETED` and at least one chunk
 *      carrying a `vector_id`. An UPLOADED or FAILED entry is a row that exists and retrieves
 *      nothing, which looks like coverage in a `COUNT(*)` and behaves like a gap.
 *   3. **No entry survives its subject.** A live document whose entity id is no longer in the
 *      catalog is the 2026-09-05 defect exactly.
 *   4. **The passages carry their facts.** Spot-checks that a college entry names its town, a
 *      program entry names its careers, and a career entry names the programs that lead to it —
 *      the reverse join that reached the corpus nowhere before 2026-09-09.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    env: { type: 'string' },
    local: { type: 'boolean', default: false },
    database: { type: 'string', default: 'CareerLinkAI_Main' },
  },
});

if (!values.local && values.env === undefined) {
  console.error('Pass --env <name> for a deployed database, or --local.');
  process.exit(2);
}

const target = values.local
  ? ['--local']
  : ['--remote', '--env', values.env, '-y'];

/**
 * Wrangler's JS entry point, run under this same Node.
 *
 * Not `npx`: on Windows the installed shim is `npx.cmd`, which `execFileSync` cannot spawn without
 * `shell: true` — and a shell would then have to survive the multi-line SQL below, quoting and all.
 * Calling the `.js` directly keeps the argument vector intact on every platform.
 */
const WRANGLER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'node_modules',
  'wrangler',
  'bin',
  'wrangler.js',
);

/** Run one read-only statement and return its rows. */
function query(sql) {
  const raw = execFileSync(
    process.execPath,
    [WRANGLER, 'd1', 'execute', values.database, ...target, '--json', '--command', sql],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );

  // Wrangler prints a banner before the JSON. The payload starts at the first bracket.
  return JSON.parse(raw.slice(raw.indexOf('['))).at(0).results;
}

const problems = [];
const note = (message) => problems.push(message);

/**
 * The corpus counts only `source_type = 'catalog'` entries as coverage.
 *
 * An admin-authored document about Nursing does not make Nursing covered: this sync owns the
 * catalog entries and would not notice a hand-written one going stale.
 */
const LIVE_CATALOG_ENTRY = `
  SELECT entity_type, entity_id, id, title, processing_status
  FROM knowledge_documents
  WHERE source_type = 'catalog' AND archived_at IS NULL
`;

console.log(`Corpus check — ${values.local ? 'local' : values.env} / ${values.database}\n`);

// --- 1. every active subject has exactly one live entry -----------------------------------------

const subjects = query(`
  SELECT 'college' AS kind, id, name AS label FROM colleges
    WHERE status = 'active' AND deleted_at IS NULL
  UNION ALL
  SELECT 'program', p.id, p.name || ' at ' || c.name FROM programs p
    JOIN colleges c ON c.id = p.college_id
    WHERE p.status = 'active' AND p.deleted_at IS NULL
      AND c.status = 'active' AND c.deleted_at IS NULL
  UNION ALL
  SELECT 'career', id, title FROM careers
    WHERE status = 'active' AND deleted_at IS NULL
`);

const entries = query(LIVE_CATALOG_ENTRY);
const byEntity = new Map(entries.map((row) => [`${row.entity_type}:${row.entity_id}`, row]));

const counts = { college: 0, program: 0, career: 0 };
const missing = [];
const unfinished = [];

for (const subject of subjects) {
  counts[subject.kind] += 1;
  const entry = byEntity.get(`${subject.kind}:${subject.id}`);

  if (entry === undefined) {
    missing.push(`${subject.kind}: ${subject.label}`);
  } else if (entry.processing_status !== 'COMPLETED') {
    unfinished.push(`${subject.kind}: ${subject.label} (${entry.processing_status})`);
  }
}

console.log(
  `catalog:  ${counts.college} colleges, ${counts.program} programmes, ${counts.career} careers ` +
    `= ${subjects.length} subjects`,
);
console.log(`corpus:   ${entries.length} live catalog entries\n`);

if (missing.length > 0) {
  note(`${missing.length} subject(s) have no knowledge entry`);
  for (const line of missing.slice(0, 15)) console.log(`   no entry: ${line}`);
  if (missing.length > 15) console.log(`   ... and ${missing.length - 15} more`);
}

if (unfinished.length > 0) {
  note(`${unfinished.length} entr(y/ies) did not finish processing`);
  for (const line of unfinished.slice(0, 15)) console.log(`   unfinished: ${line}`);
  if (unfinished.length > 15) console.log(`   ... and ${unfinished.length - 15} more`);
}

// --- 2. every live entry is actually embedded ----------------------------------------------------

const unembedded = query(`
  SELECT d.title
  FROM knowledge_documents d
  WHERE d.source_type = 'catalog' AND d.archived_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM knowledge_chunks k
      WHERE k.document_id = d.id AND k.vector_id IS NOT NULL
    )
`);

if (unembedded.length > 0) {
  note(`${unembedded.length} live entr(y/ies) have no embedded chunk — they retrieve nothing`);
  for (const row of unembedded.slice(0, 15)) console.log(`   no vector: ${row.title}`);
  if (unembedded.length > 15) console.log(`   ... and ${unembedded.length - 15} more`);
}

// --- 3. no entry outlives its subject -------------------------------------------------------------

const live = new Set(subjects.map((subject) => `${subject.kind}:${subject.id}`));
const orphans = entries.filter((row) => !live.has(`${row.entity_type}:${row.entity_id}`));

if (orphans.length > 0) {
  note(`${orphans.length} live entr(y/ies) describe a subject that is no longer in the catalog`);
  for (const row of orphans.slice(0, 15)) console.log(`   orphan: ${row.title}`);
  if (orphans.length > 15) console.log(`   ... and ${orphans.length - 15} more`);
}

// --- 4. the passages carry the facts a student asks for --------------------------------------------

/**
 * Chunk text is the thing retrieval actually returns, so the spot-checks read `knowledge_chunks`
 * rather than the R2 sidecar the entry was built from — a sidecar that is right and a chunk that
 * is empty is still a corpus that answers nothing.
 */
const sample = (label, sql, expectation) => {
  const rows = query(sql);

  if (rows.length === 0) {
    note(`spot-check "${label}" found no chunk to read`);
    return;
  }

  const text = rows.at(0).content ?? '';
  const ok = expectation.every((needle) => text.includes(needle));

  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);

  if (!ok) {
    note(`spot-check "${label}" is missing: ${expectation.filter((n) => !text.includes(n)).join(', ')}`);
    console.log(`        text: ${text.replace(/\s+/g, ' ').slice(0, 240)}`);
  }
};

console.log('spot-checks:');

sample(
  'a college entry names its town and its programmes',
  `SELECT k.content FROM knowledge_chunks k
     JOIN knowledge_documents d ON d.id = k.document_id
     JOIN colleges c ON c.id = d.entity_id
    WHERE d.entity_type = 'college' AND d.archived_at IS NULL
      AND c.name LIKE '%Candijay%'
    ORDER BY k.chunk_number LIMIT 1`,
  ['Candijay', 'Programs offered'],
);

sample(
  'a programme entry names where it leads',
  `SELECT k.content FROM knowledge_chunks k
     JOIN knowledge_documents d ON d.id = k.document_id
     JOIN programs p ON p.id = d.entity_id
    WHERE d.entity_type = 'program' AND d.archived_at IS NULL
      AND p.code = 'BSFISH'
    ORDER BY k.chunk_number LIMIT 1`,
  ['commonly go into these careers', 'Fisheries Technologist'],
);

sample(
  'a career entry names the programmes that reach it',
  `SELECT k.content FROM knowledge_chunks k
     JOIN knowledge_documents d ON d.id = k.document_id
     JOIN careers cr ON cr.id = d.entity_id
    WHERE d.entity_type = 'career' AND d.archived_at IS NULL
      AND cr.title = 'Registered Criminologist'
    ORDER BY k.chunk_number LIMIT 1`,
  ['Programs that lead to this career', 'salary'],
);

sample(
  'a regulated career states its licence',
  `SELECT k.content FROM knowledge_chunks k
     JOIN knowledge_documents d ON d.id = k.document_id
     JOIN careers cr ON cr.id = d.entity_id
    WHERE d.entity_type = 'career' AND d.archived_at IS NULL
      AND cr.title = 'Midwife'
    ORDER BY k.chunk_number LIMIT 1`,
  ['PRC', 'RA 7392'],
);

// --- 5. full-text search answers the obvious questions ----------------------------------------------
//
// FTS is half of the hybrid retrieval (the other half is Vectorize, which SQL cannot reach), so a
// term that returns nothing here is a question the assistant answers worse than it should.

console.log('\nfull-text probes:');

for (const term of [
  'Candijay',
  'Talibon',
  'Panglao',
  '"Marine Biology"',
  '"Food Technology"',
  'Midwifery',
  '"Juris Doctor"',
  'Forestry',
  '"Pollution Control Officer"',
  '"Deck Officer"',
]) {
  const [{ n }] = query(
    `SELECT COUNT(*) AS n FROM knowledge_chunks_fts WHERE knowledge_chunks_fts MATCH '${term.replace(/'/g, "''")}'`,
  );

  console.log(`${n > 0 ? 'ok  ' : 'FAIL'}  ${String(n).padStart(4)} chunk(s) match ${term}`);
  if (n === 0) note(`no chunk matches the search term ${term}`);
}

// --- verdict -------------------------------------------------------------------------------------

console.log('');

if (problems.length === 0) {
  console.log(`CORPUS COMPLETE — ${entries.length} entries cover all ${subjects.length} catalog subjects.`);
  process.exit(0);
}

console.log(`${problems.length} problem(s):`);
for (const problem of problems) console.log(`  - ${problem}`);
process.exit(1);

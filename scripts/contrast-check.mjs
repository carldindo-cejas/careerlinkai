/**
 * **The live proof of audit item C1** (IMPLEMENTATION-PLAN P2-2, step 6).
 *
 * Audit C1 was that the catalog was too small to discriminate: §27 keeps the top ten, and with ten
 * careers in the database every student received *every* career, reordered. The fix (seed 0004)
 * grew the catalog to 68 careers and 309 programmes. This script is the check that the fix
 * actually did what it was for — and it is the one a panellist will ask to see.
 *
 * It drives **two students through the real API with deliberately opposite RIASEC answers** and
 * compares the career lists they receive. Their SCCT answers are identical on purpose, so the only
 * variable is interest profile: any difference in the output is attributable to the thing under
 * test and nothing else.
 *
 * The answer key is fetched **as staff**, through the builder's own version endpoint. It cannot come
 * from the student session: the player payload deliberately carries no dimension and no option score
 * (§25), so a student's client genuinely cannot know which item measures what — the property that
 * makes the instrument honest, and the reason this script needs a second, authorised identity.
 *
 *   node scripts/contrast-check.mjs --app https://careerlinkai-staging.cejascarldindo.workers.dev \
 *     --class-code GZUY-2673 --a juan.delacruz2 --b jose.pena.edited \
 *     --counselor-password 'Walkthrough@Counselor1'
 *
 * The two students must be on the class roster and must not have attempted anything yet.
 */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const APP = (flag('app', 'https://careerlinkai-staging.cejascarldindo.workers.dev') ?? '').replace(/\/$/, '');
const API = `${APP}/api/v1`;
const CLASS_CODE = flag('class-code');
const STUDENT_A = flag('a');
const STUDENT_B = flag('b');
const COUNSELOR_PASSWORD = flag('counselor-password', 'Walkthrough@Counselor1');
const ADMIN_PASSWORD = flag('admin-password', 'Walkthrough@Admin1');

/** The two contrasting interest profiles. Disjoint by construction — no dimension is in both. */
const PROFILE_A = ['R', 'I', 'C']; // things, ideas, order
const PROFILE_B = ['A', 'S', 'E']; // expression, people, influence

let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
}


/**
 * **Retries the transport, never the answer.**
 *
 * One full run is ~190 requests — two students × (60 + 30) answers, plus the joins, starts and
 * submits — and against a deployed Worker some of them will not arrive. Running this against
 * production for the P3-1 cutover, `read ECONNRESET` killed the process twice: once before student
 * B started, and once mid-instrument. There is no retry to be had by re-running the script either,
 * because `start` returns 422 on an assignment the student has already submitted (§21) — so a
 * network blip half way through does not cost a request, it costs the whole run and the two
 * students, who can never be used again.
 *
 * Only *network* failures are retried. A 4xx or 5xx is the application answering and must be
 * reported exactly as received: this script exists to detect a broken deployment, and a retry loop
 * around a real error is how a check reports green on a system that is failing.
 */
async function api(path, { token, method = 'GET', body } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const res = await fetch(API + path, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

      return { status: res.status, json: await res.json().catch(() => null) };
    } catch (error) {
      lastError = error;

      if (attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  console.log(`  ..   ${method} ${path} — network failure after 4 attempts`);

  throw lastError;
}

/**
 * The answer key: every question of one instrument, its dimension, and its options with scores.
 *
 * Read over HTTP as staff through the builder's own version endpoint, not out of the database.
 * The staff view legitimately carries option scores and dimension mappings — that is what an author
 * edits — while the *student* payload deliberately carries neither (§25). Reading it this way keeps
 * the whole check to one protocol and, more usefully, means the key comes from the same serializer
 * the product uses rather than from a hand-written join that could drift from it.
 */
async function answerKeyFor(category, token) {
  const templates = (await api('/counselor/assessment-templates', { token })).json?.data ?? [];
  const template = templates.find((t) => t.category === category && t.ownership === 'GLOBAL');
  const versionId = template?.assignable_version?.id;

  if (!versionId) return new Map();

  const version = (await api(`/assessment-versions/${versionId}`, { token })).json?.data;
  const questions = new Map();

  for (const question of version?.questions ?? []) {
    questions.set(question.id, {
      // One dimension per item on both instruments; `.at(0)` rather than an assumption of exactly one.
      dimension: question.dimensions?.at(0)?.code ?? null,
      options: (question.options ?? []).map((option) => ({ id: option.id, score: Number(option.score) })),
    });
  }

  return questions;
}

/** Highest-scoring option when the item measures a dimension we want high; lowest otherwise. */
function choose(entry, highDimensions) {
  const wantHigh = highDimensions === null || highDimensions.includes(entry.dimension);
  const sorted = [...entry.options].sort((a, b) => a.score - b.score);

  return (wantHigh ? sorted.at(-1) : sorted[0]).id;
}

async function runStudent(username, riasecProfile, riasecKey, scctKey) {
  const join = await api('/student-access/join', {
    method: 'POST',
    body: { class_code: CLASS_CODE, username },
  });

  check(`[${username}] joins the class`, join.status === 200, `status ${join.status}`);

  const token = join.json?.data?.token;

  if (!token) return null;

  const assignments = (await api('/student/assignments', { token })).json?.data ?? [];

  for (const [category, key, profile] of [
    ['RIASEC', riasecKey, riasecProfile],
    // Identical for both students, so the only variable is the interest profile above.
    ['SCCT', scctKey, null],
  ]) {
    const assignment = assignments.find((a) => a.assessment?.category === category);

    if (!assignment) {
      check(`[${username}] has a ${category} assignment`, false, 'not assigned to this class');
      continue;
    }

    const started = await api(`/student/assignments/${assignment.id}/start`, { method: 'POST', token });
    const attempt = started.json?.data;
    const questions = attempt?.questions ?? [];

    check(
      `[${username}] starts ${category}`,
      started.status === 200 && questions.length > 0,
      `${questions.length} questions`,
    );

    let answered = 0;

    for (const question of questions) {
      const entry = key.get(question.id);

      if (!entry) continue;

      const saved = await api(`/student/attempts/${attempt.attempt_id ?? attempt.id}/answers`, {
        method: 'POST',
        token,
        body: { question_id: question.id, selected_option_id: choose(entry, profile) },
      });

      if (saved.status === 200) answered += 1;
    }

    check(`[${username}] answers every ${category} item`, answered === questions.length, `${answered}/${questions.length}`);

    const submitted = await api(`/student/attempts/${attempt.attempt_id ?? attempt.id}/submit`, {
      method: 'POST',
      token,
    });

    check(
      `[${username}] ${category} scores`,
      submitted.status === 200,
      category === 'RIASEC' ? `Holland ${submitted.json?.data?.result?.result_code ?? '?'}` : '',
    );
  }

  return token;
}

// ── Run ──────────────────────────────────────────────────────────────────────────────────────
console.log(`\nC1 contrast check against ${APP}\n${'─'.repeat(70)}`);
console.log(`  A = ${STUDENT_A} (high ${PROFILE_A.join('')})`);
console.log(`  B = ${STUDENT_B} (high ${PROFILE_B.join('')})\n`);

const login = await api('/auth/login', {
  method: 'POST',
  body: { email: 'counselor@careerlinkai.online', password: COUNSELOR_PASSWORD },
});
const counselorToken = login.json?.data?.token;

check('counselor signs in', Boolean(counselorToken), `status ${login.status}`);

/**
 * The answer key needs the **admin**, not the counselor.
 *
 * RIASEC and SCCT are GLOBAL templates, and the builder refuses a counselor read of one — a
 * counselor authors only their own COUNSELOR_PRIVATE instruments. That is the §4 rule working, so
 * the script brings the identity that is actually entitled to the key rather than treating a
 * correct 404 as an obstacle. The recommendations below are still read as the *counselor*, because
 * that is the claim being tested.
 */
const adminLogin = await api('/auth/login', {
  method: 'POST',
  body: { email: 'admin@careerlinkai.online', password: ADMIN_PASSWORD },
});
const adminToken = adminLogin.json?.data?.token;

check('admin signs in (for the answer key)', Boolean(adminToken), `status ${adminLogin.status}`);

const riasecKey = await answerKeyFor('RIASEC', adminToken);
const scctKey = await answerKeyFor('SCCT', adminToken);

check(
  'the RIASEC answer key carries a dimension for every item',
  riasecKey.size > 0 && [...riasecKey.values()].every((q) => q.dimension),
  `${riasecKey.size} questions`,
);
check('the SCCT answer key loaded', scctKey.size > 0, `${scctKey.size} questions`);

await runStudent(STUDENT_A, PROFILE_A, riasecKey, scctKey);
await runStudent(STUDENT_B, PROFILE_B, riasecKey, scctKey);

// Read both students' recommendations through the **counselor's own §4 route**, not the database:
// this asserts what the counselor's screen actually shows, which is the claim being made.
const classes = (await api('/counselor/classes', { token: counselorToken })).json?.data?.items ?? [];
const classRoom = classes.find((c) => c.join_code === CLASS_CODE);

check('the class is found by its join code', Boolean(classRoom), CLASS_CODE);

const roster = (await api(`/counselor/classes/${classRoom?.id}/students`, { token: counselorToken })).json?.data ?? [];
const sets = {};

for (const username of [STUDENT_A, STUDENT_B]) {
  const entry = roster.find((r) => r.username === username);
  const res = await api(`/counselor/students/${entry?.student_id}/recommendations`, { token: counselorToken });

  sets[username] = res.json?.data;
  check(
    `[${username}] the counselor can read their recommendations`,
    res.status === 200 && res.json?.data !== null,
    `status ${res.status}`,
  );
}

const a = sets[STUDENT_A];
const b = sets[STUDENT_B];

if (a && b) {
  const aCareers = a.careers.map((c) => c.career.title);
  const bCareers = b.careers.map((c) => c.career.title);
  const overlap = aCareers.filter((t) => bCareers.includes(t));

  console.log(`\n  ${STUDENT_A} — top 10 careers (Holland-weighted ${PROFILE_A.join('')}):`);
  for (const c of a.careers) console.log(`   ${String(c.ranking).padStart(2)}. ${c.career.title.padEnd(34)} ${c.match_score.toFixed(1)}  ${c.career.typical_riasec_code ?? ''}`);

  console.log(`\n  ${STUDENT_B} — top 10 careers (Holland-weighted ${PROFILE_B.join('')}):`);
  for (const c of b.careers) console.log(`   ${String(c.ranking).padStart(2)}. ${c.career.title.padEnd(34)} ${c.match_score.toFixed(1)}  ${c.career.typical_riasec_code ?? ''}`);

  console.log(`\n  overlap: ${overlap.length}/10 ${overlap.length ? `(${overlap.join(', ')})` : ''}`);

  // The audit's own bar: with a 10-career catalog the overlap was 10/10 by construction. Anything
  // approaching that means the catalog still is not discriminating, whatever its row count says.
  check('the two profiles receive visibly different careers (overlap < 5/10)', overlap.length < 5, `${overlap.length}/10 shared`);

  const aPrograms = a.programs.map((p) => `${p.program.name} @ ${p.college.name}`);
  const bPrograms = b.programs.map((p) => `${p.program.name} @ ${p.college.name}`);
  const programOverlap = aPrograms.filter((t) => bPrograms.includes(t));

  console.log(`\n  ${STUDENT_A} — top 5 programmes:`);
  for (const p of a.programs.slice(0, 5)) console.log(`   ${p.ranking}. ${p.program.name} @ ${p.college.name} — ${p.match_score.toFixed(1)}`);
  console.log(`\n  ${STUDENT_B} — top 5 programmes:`);
  for (const p of b.programs.slice(0, 5)) console.log(`   ${p.ranking}. ${p.program.name} @ ${p.college.name} — ${p.match_score.toFixed(1)}`);

  console.log(`\n  programme overlap: ${programOverlap.length}/10`);
  check('the two profiles receive different programmes (overlap < 8/10)', programOverlap.length < 8, `${programOverlap.length}/10 shared`);
}

console.log(`\n${'─'.repeat(70)}`);
console.log(`${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`);
process.exit(failures === 0 ? 0 : 1);

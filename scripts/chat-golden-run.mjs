#!/usr/bin/env node
/**
 * Golden-question run against a deployed CareerLinkAI (AI-COVERAGE-PLAN.md Phase 6).
 *
 * The hermetic suite (`backend/test/ai/golden-questions.test.ts`) proves the gates route each
 * question correctly against a stubbed model. This script is the other half: it asks the real
 * deployment the same questions as a real student and reports which gate answered, whether the
 * answer contains what it must, and how many model tokens the run spent.
 *
 * It **writes** to the target: every question becomes a chat turn in the test student's transcript
 * and costs real neurons on generated turns (roughly 20 questions, most answered at zero cost). Run
 * it with a dedicated test student, not a real one, and clear the transcript afterwards.
 *
 *   CAREERLINKAI_URL=https://careerlinkai.online \
 *   CAREERLINKAI_STUDENT_TOKEN=<bearer token of a test student with recommendations> \
 *   node scripts/chat-golden-run.mjs [--clear]
 *
 * Exit code 1 if any question falls below its expectation, so it can gate a deploy by hand.
 */

const base = (process.env.CAREERLINKAI_URL ?? 'https://careerlinkai.online').replace(/\/$/, '');
const token = process.env.CAREERLINKAI_STUDENT_TOKEN;
const clear = process.argv.includes('--clear');

if (!token) {
  console.error('Set CAREERLINKAI_STUDENT_TOKEN to a test student’s bearer token.');
  process.exit(2);
}

/**
 * `gate`: which kind of answer is expected — `lookup` (Gate 2, a source line, no model),
 * `curated` (Gate 1), `generated` (Gate 3), `redirect` or `refused`. `contains`: case-insensitive
 * strings the answer must include. Mirrors AI-COVERAGE-PLAN.md §6.
 */
const GOLDEN = [
  { q: 'Where is Holy Name University located?', gate: 'lookup', contains: ['Tagbilaran', 'maps'] },
  { q: 'HNU located', gate: 'lookup', contains: ['Tagbilaran'] },
  { q: 'What Colleges offer BS Computer Science in Bohol', gate: 'lookup', contains: ['University of Bohol', 'Bilar'] },
  { q: 'What colleges in Cebu offer BS Computer Science?', gate: 'lookup', contains: ['only'] },
  { q: 'what school should i enroll for database administrator career', gate: 'lookup', contains: ['Information'] },
  { q: 'What careers can I take after BS Accountancy at Holy Name University?', gate: 'lookup', contains: ['Certified Public Accountant'] },
  { q: 'Which of my top three careers pays the best?', gate: 'lookup', contains: ['highest listed pay'] },
  { q: 'Whats my top 1 program?', gate: 'lookup', contains: ['#1'] },
  { q: 'What is my Holland code?', gate: 'lookup', contains: ['Holland code'] },
  { q: 'What can you do?', gate: 'lookup', contains: ['college catalog'] },
  { q: 'How much is the tuition fee?', gate: 'curated', contains: ['guidance counselor'] },
  { q: 'Is nursing a stressful job?', gate: 'curated', contains: ['shifts'] },
  { q: 'Why bs accountancy where I am artistic I can take bs architecture', gate: 'lookup-or-generated', contains: [] },
  { q: 'What subjects should I focus on for these?', gate: 'generated', contains: [] },
  { q: 'What if I cant take BS Accountancy', gate: 'generated', contains: [] },
  { q: 'Explain my results', gate: 'generated', contains: [] },
  { q: 'my parents will be angry if I dont pick engineering and I am very stressed', gate: 'redirect', contains: ['counselor'] },
  { q: 'solve x^2 - 4 = 0', gate: 'redirect', contains: ['schoolwork'] },
];

async function call(method, path, body) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok && response.status !== 201) {
    throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`);
  }

  return response.status === 204 ? null : response.json();
}

/** What kind of answer came back, from the fields the API returns. */
function gateOf(answer, failure) {
  if (failure?.startsWith('OUT_OF_SCOPE')) return 'redirect';
  if (answer.knowledge_request === 'OFFERED') return 'refused';
  if (answer.answer_kind === 'CURATED') return 'curated';
  if (answer.answer_kind === 'KNOWLEDGE') return 'generated';
  if (answer.answer_kind === 'CANNED' && answer.sources.length > 0) return 'lookup';

  return 'other';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const tally = {};

for (const item of GOLDEN) {
  const result = await call('POST', '/student/chat', { message: item.q });
  const { answer, failure } = result.data;
  const gate = gateOf(answer, failure);
  const text = answer.content.toLowerCase();
  const missing = item.contains.filter((needle) => !text.includes(needle.toLowerCase()));
  const gateOk = item.gate.split('-or-').includes(gate);
  const ok = gateOk && missing.length === 0;

  tally[gate] = (tally[gate] ?? 0) + 1;

  if (!ok) failures += 1;

  console.log(`${ok ? 'PASS' : 'FAIL'}  [${gate}${gateOk ? '' : ` ≠ ${item.gate}`}]  ${item.q}`);

  if (!ok) {
    if (missing.length > 0) console.log(`      missing: ${missing.join(', ')}`);
    console.log(`      answer: ${answer.content.replace(/\s+/g, ' ').slice(0, 220)}`);
  }

  // Stay under the 10 AI requests per minute per user limit.
  await sleep(6500);
}

const total = GOLDEN.length;
const free = (tally.lookup ?? 0) + (tally.curated ?? 0) + (tally.redirect ?? 0);

console.log('');
console.log(`Gates: ${Object.entries(tally).map(([gate, n]) => `${gate} ${n}`).join(', ')}`);
console.log(`Answered without a model call: ${free} of ${total}`);
console.log(`Below expectation: ${failures} of ${total}`);

if (clear) {
  await call('DELETE', '/student/chat');
  console.log('Transcript cleared.');
}

process.exit(failures === 0 ? 0 : 1);

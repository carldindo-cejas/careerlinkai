import { SELF, env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';

import { createDatabase } from '@/db/client';
import type { UserRole, UserStatus } from '@/db/enums';
import {
  apiTokens,
  appSettings,
  auditLogs,
  classStudents,
  classes,
  colleges,
  counselorProfiles,
  counselorSignupRequests,
  gradeLevels,
  passwordResetTokens,
  programCareers,
  programs,
  shsStrands,
  users,
} from '@/db/schema';
import { hashPassword } from '@/do/auth-guard';
import { uuid } from '@/lib/crypto';
import { AssessmentTaxonomyService } from '@/modules/assessment/assessment-taxonomy-service';
import { seedAssessmentInstruments } from '@/modules/assessment/instruments';
import { now } from '@/lib/datetime';

/**
 * Shared test fixtures.
 *
 * Users are inserted through Drizzle against the real D1 binding rather than through the
 * API, because the API has no user-creation endpoint in Phase 3.5 Step 1 — staff accounts
 * arrive via the seeder (§57 Step 1.8). Passwords go through the real `hashPassword`, so a
 * test exercises the same PBKDF2 path production does.
 */

export const BASE_URL = 'https://careerlinkai.test/api/v1';

/** The password every fixture user gets unless told otherwise — satisfies the §38 policy. */
export const VALID_PASSWORD = 'CorrectHorse1';

export function db() {
  return createDatabase(env.DB);
}

/**
 * Fixture password hashes are memoised per password.
 *
 * A 600k-iteration PBKDF2 derivation is expensive by design (§38), and a fixture re-deriving
 * the same known password for every user it creates is pure cost with no coverage: the real
 * `hashPassword` is still what produces the hash, and its salting and parameters are asserted
 * directly in test/unit/crypto.test.ts.
 */
const hashCache = new Map<string, string>();

async function fixtureHash(password: string): Promise<string> {
  const cached = hashCache.get(password);

  if (cached !== undefined) {
    return cached;
  }

  const hash = await hashPassword(password);
  hashCache.set(password, hash);

  return hash;
}

export interface StaffUserOptions {
  role?: Extract<UserRole, 'admin' | 'counselor'>;
  email?: string;
  password?: string;
  status?: UserStatus;
  mustChangePassword?: boolean;
  name?: string;
}

export interface StaffUserFixture {
  id: string;
  email: string;
  password: string;
  role: UserRole;
}

/** A staff user with a real PBKDF2 hash, plus a counselor profile when the role calls for one. */
export async function createStaffUser(
  options: StaffUserOptions = {},
): Promise<StaffUserFixture> {
  const role = options.role ?? 'counselor';
  const email = options.email ?? `${role}.${uuid().slice(0, 8)}@school.test`;
  const password = options.password ?? VALID_PASSWORD;
  const id = uuid();
  const timestamp = now();

  await db()
    .insert(users)
    .values({
      id,
      name: options.name ?? (role === 'admin' ? 'Test Admin' : 'Test Counselor'),
      email,
      password: await fixtureHash(password),
      role,
      status: options.status ?? 'active',
      mustChangePassword: options.mustChangePassword ?? false,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

  if (role === 'counselor') {
    await db().insert(counselorProfiles).values({
      id: uuid(),
      userId: id,
      firstName: 'Test',
      lastName: 'Counselor',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  return { id, email, password, role };
}

/**
 * A student — passwordless by design (§38), so `password` stays NULL. Used to prove a
 * student can never authenticate through the staff login endpoint.
 */
export async function createStudentUser(): Promise<{ id: string; email: string }> {
  const id = uuid();
  const email = `student.${uuid().slice(0, 8)}@school.test`;
  const timestamp = now();

  await db().insert(users).values({
    id,
    name: 'Test Student',
    email,
    password: null,
    role: 'student',
    status: 'active',
    mustChangePassword: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  return { id, email };
}

export interface ApiResponse<TBody = any> {
  status: number;
  body: TBody;
}

/** Call the Worker exactly as the frontend would — through the real router and middleware. */
export async function api<TBody = any>(
  method: string,
  path: string,
  options: { body?: unknown; token?: string; ip?: string } = {},
): Promise<ApiResponse<TBody>> {
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  // The join throttle and the audit trail both key off the client IP (§38); in production
  // the edge sets this header, and here the test does.
  headers['CF-Connecting-IP'] = options.ip ?? '203.0.113.10';

  const response = await SELF.fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  // A 204 has no body at all, so `.json()` on it throws. DELETE returns 204 by contract, and
  // a helper that could not read that response would make every delete test fail for a reason
  // that has nothing to do with the endpoint.
  const text = await response.text();

  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** Log a fixture user in and return the bearer token. */
export async function login(user: StaffUserFixture): Promise<string> {
  const response = await api('POST', '/auth/login', {
    body: { email: user.email, password: user.password },
  });

  if (response.status !== 200) {
    throw new Error(`Fixture login failed with ${response.status}: ${JSON.stringify(response.body)}`);
  }

  return response.body.data.token as string;
}

/**
 * A class owned by `counselor`, created **through the API** so the join code comes from the
 * real generator and the real uniqueness check — a fixture that inserted the row directly
 * would be testing a class the application could never have produced.
 */
export async function createClass(
  token: string,
  overrides: {
    name?: string;
    academic_year?: string;
    grade_level_id?: string | null;
    shs_strand_id?: string | null;
  } = {},
): Promise<any> {
  const response = await api('POST', '/counselor/classes', {
    token,
    body: {
      name: overrides.name ?? 'Grade 12 STEM A',
      academic_year: overrides.academic_year ?? '2026-2027',
      /**
       * **Both default to NULL**, and every fixture that wants a derived grade level or strand
       * asks for one explicitly (migration 0017).
       *
       * That is the safer default by a distance: a class carrying a strand *locks* its students'
       * profile fields, so defaulting to "Grade 12 / Academic" here would silently make the
       * majority of the suite's students unable to PATCH their own strand — and every test that
       * does so would fail for a reason that has nothing to do with what it is testing.
       */
      grade_level_id: overrides.grade_level_id ?? null,
      shs_strand_id: overrides.shs_strand_id ?? null,
    },
  });

  if (response.status !== 201) {
    throw new Error(`Fixture class creation failed: ${JSON.stringify(response.body)}`);
  }

  return response.body.data;
}

/**
 * The §13.1 lookup ids (migration 0017), resolved by `code`.
 *
 * By code rather than pasted UUIDs, for the same reason `assessmentTaxonomy()` above does it: a
 * test that hard-coded `91000001-…` would still pass if the seeded row came to mean something
 * else, and this way the fixture fails loudly if the migration ever stops shipping the reference
 * rows that validation and the derivation both read.
 */
export async function profileLookups(): Promise<{
  grade11: string;
  grade12: string;
  academic: string;
  technical: string;
}> {
  const database = db();
  const [levels, strands] = await Promise.all([
    database.select().from(gradeLevels),
    database.select().from(shsStrands),
  ]);

  const byCode = <T extends { code: string; id: string }>(rows: T[], code: string): string => {
    const row = rows.find((candidate) => candidate.code === code);

    if (row === undefined) {
      throw new Error(`Migration 0017 did not seed the "${code}" reference row.`);
    }

    return row.id;
  };

  return {
    grade11: byCode(levels, 'GRADE_11'),
    grade12: byCode(levels, 'GRADE_12'),
    academic: byCode(strands, 'ACADEMIC'),
    technical: byCode(strands, 'TECHNICAL_PROFESSIONAL'),
  };
}

/** Enrol students via preview → confirm, the only path that ever creates a student. */
export async function enrolStudents(
  token: string,
  classId: string,
  names: string[],
): Promise<any[]> {
  const preview = await api('POST', `/counselor/classes/${classId}/students/preview`, {
    token,
    body: { names },
  });

  if (preview.status !== 200) {
    throw new Error(`Fixture preview failed: ${JSON.stringify(preview.body)}`);
  }

  const confirm = await api('POST', `/counselor/classes/${classId}/students/confirm`, {
    token,
    body: {
      students: preview.body.data.students.map((student: any) => ({
        first_name: student.first_name,
        last_name: student.last_name,
        username: student.username,
      })),
    },
  });

  if (confirm.status !== 201) {
    throw new Error(`Fixture confirm failed: ${JSON.stringify(confirm.body)}`);
  }

  return confirm.body.data;
}

/**
 * Join a class as a student and return the bearer token.
 *
 * `confirm: true` because a join is two calls now (see `StudentAccessService`): without it the
 * endpoint answers with the student's name and issues nothing. Fixtures want the session, so they
 * take the second step directly; the confirmation itself is tested in `student-access/join.test.ts`.
 */
export async function joinClass(classCode: string, username: string): Promise<string> {
  const response = await api('POST', '/student-access/join', {
    body: { class_code: classCode, username, confirm: true },
  });

  if (response.status !== 200) {
    throw new Error(`Fixture join failed: ${JSON.stringify(response.body)}`);
  }

  return response.body.data.token as string;
}

/** Expire a class's join code by moving the row, since the clock cannot move in workerd. */
export async function expireJoinCode(classId: string): Promise<void> {
  await db()
    .update(classes)
    .set({ joinCodeExpiresAt: new Date(Date.now() - 1000).toISOString() })
    .where(eq(classes.id, classId));
}

/** The most recent audit row for an action, by the class it targeted. */
export async function findAuditRowForClass(action: string, classId: string) {
  const rows = await db().select().from(auditLogs).where(eq(auditLogs.action, action));

  return rows.filter((row) => row.targetId === classId).at(-1);
}

/** Soft-delete a user, the way an admin's DELETE would (§12). */
export async function softDeleteUser(id: string): Promise<void> {
  await db().update(users).set({ deletedAt: now() }).where(eq(users.id, id));
}

/** Move a user out of `active` — the state the §38 middleware check exists for. */
export async function setUserStatus(id: string, status: UserStatus): Promise<void> {
  await db().update(users).set({ status }).where(eq(users.id, id));
}

/**
 * Backdate every token a user holds so it reads as expired.
 *
 * Time cannot be advanced inside workerd, so expiry is tested by moving the row rather than
 * the clock — the code path under test (`isExpired`) compares the same two values either way.
 */
export async function expireTokensFor(userId: string): Promise<void> {
  await db()
    .update(apiTokens)
    .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    .where(eq(apiTokens.userId, userId));
}

export async function countTokensFor(userId: string): Promise<number> {
  const rows = await db().select().from(apiTokens).where(eq(apiTokens.userId, userId));

  return rows.length;
}

/** Backdate a password-reset row past its 60-minute TTL. */
export async function backdateResetToken(email: string, minutesAgo: number): Promise<void> {
  await db()
    .update(passwordResetTokens)
    .set({ createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() })
    .where(eq(passwordResetTokens.email, email.toLowerCase()));
}

/**
 * Open or close counselor self-signup (migration 0034).
 *
 * Written straight to the table rather than through `PATCH /admin/settings`, so a signup test is
 * testing signup rather than also testing the admin route that happens to precede it — and so it
 * does not need an admin fixture and a login (two PBKDF2 derivations) just to arrive at its
 * subject. The route has its own tests.
 *
 * Upserted, because the migration's seeded row exists in the isolated schema each test builds.
 */
export async function setCounselorSignupEnabled(enabled: boolean): Promise<void> {
  const value = enabled ? 'true' : 'false';

  await db()
    .insert(appSettings)
    .values({ key: 'counselor_signup_enabled', value, updatedAt: now() })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: now() },
    });
}

/** Backdate a staged signup past the 15-minute code TTL. */
export async function backdateSignupRequest(email: string, minutesAgo: number): Promise<void> {
  await db()
    .update(counselorSignupRequests)
    .set({ createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() })
    .where(eq(counselorSignupRequests.email, email.toLowerCase()));
}

export async function findSignupRequest(email: string) {
  return db().query.counselorSignupRequests.findFirst({
    where: eq(counselorSignupRequests.email, email.toLowerCase()),
  });
}

/** Every audit action recorded for a user, oldest first — the §13.8 trail under assertion. */
export async function auditActionsFor(userId: string): Promise<string[]> {
  const rows = await db()
    .select({ action: auditLogs.action, createdAt: auditLogs.createdAt })
    .from(auditLogs)
    .where(eq(auditLogs.userId, userId));

  return rows.map((row) => row.action);
}

/**
 * Find an audit row by action and by the email recorded in `new_values` — the only way to
 * identify the entry for a login that resolved no user, since `user_id` is NULL there.
 *
 * Storage is shared across the tests in a file (see test/setup.ts), so this deliberately
 * matches one row rather than reading "the" row out of the table.
 */
export async function findAuditRowByEmail(action: string, email: string) {
  const rows = await db().select().from(auditLogs).where(eq(auditLogs.action, action));

  return rows.find((row) => row.newValues?.email === email.toLowerCase());
}

/** Every audit row. Filter it yourself — storage is shared across a file's tests. */
export async function allAuditRows() {
  return db().select().from(auditLogs);
}

/** The `class_students` row itself, to assert that removal keeps history rather than deleting. */
export async function findEnrollment(id: string) {
  return db().query.classStudents.findFirst({ where: eq(classStudents.id, id) });
}

// --- Academic catalog (Step 3) ---------------------------------------------------------

/**
 * A college, created **through the API** so it goes through the real uniqueness check.
 *
 * The name is made unique per fixture because storage is *not* rolled back between the tests
 * in a file (see test/setup.ts) — a fixed name would collide with the previous test's college
 * on the second run and fail the live-row uniqueness rule for reasons unrelated to the test.
 */
export async function createCollege(
  token: string,
  overrides: { name?: string; description?: string } = {},
): Promise<any> {
  const response = await api('POST', '/admin/colleges', {
    token,
    body: {
      name: overrides.name ?? `University of ${uuid().slice(0, 8)}`,
      description: overrides.description ?? 'A test institution.',
    },
  });

  if (response.status !== 201) {
    throw new Error(`Fixture college creation failed: ${JSON.stringify(response.body)}`);
  }

  return response.body.data;
}

export async function createProgram(
  token: string,
  collegeId: string,
  overrides: Record<string, unknown> = {},
): Promise<any> {
  const response = await api('POST', `/admin/colleges/${collegeId}/programs`, {
    token,
    body: {
      code: `BS${uuid().slice(0, 4).toUpperCase()}`,
      name: 'BS Computer Science',
      department_name: 'College of Engineering',
      recommended_strand: 'Academic',
      ...overrides,
    },
  });

  if (response.status !== 201) {
    throw new Error(`Fixture program creation failed: ${JSON.stringify(response.body)}`);
  }

  return response.body.data;
}

export async function createCareer(
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<any> {
  const response = await api('POST', '/admin/careers', {
    token,
    body: {
      title: `Software Engineer ${uuid().slice(0, 8)}`,
      typical_riasec_code: 'IEC',
      ...overrides,
    },
  });

  if (response.status !== 201) {
    throw new Error(`Fixture career creation failed: ${JSON.stringify(response.body)}`);
  }

  return response.body.data;
}

/** Link a career to a program through the real endpoint; returns the updated program. */
export async function attachCareer(
  token: string,
  programId: string,
  careerId: string,
): Promise<any> {
  const response = await api('POST', `/admin/programs/${programId}/careers`, {
    token,
    body: { career_id: careerId },
  });

  if (response.status !== 201) {
    throw new Error(`Fixture career link failed: ${JSON.stringify(response.body)}`);
  }

  return response.body.data;
}

/** The raw program row — to assert a soft delete really did set `deleted_at`. */
export async function findProgramRow(id: string) {
  return db().query.programs.findFirst({ where: eq(programs.id, id) });
}

export async function findCollegeRow(id: string) {
  return db().query.colleges.findFirst({ where: eq(colleges.id, id) });
}

/** The mapping rows for a program — the set §27 will average over. */
export async function findLinksForProgram(id: string) {
  return db().select().from(programCareers).where(eq(programCareers.programId, id));
}

export async function findUser(id: string) {
  return db().query.users.findFirst({ where: eq(users.id, id) });
}

// --- Assessment fixtures (Phase 3.5 Step 4) --------------------------------------------------

/**
 * Install RIASEC + SCCT **through the real `AssessmentBuilderService`**, exactly as the seeder
 * does — so every assessment test runs against instruments that passed the real publish gate
 * (§25), not against rows a fixture hand-wrote into a PUBLISHED state.
 *
 * That distinction is the whole point of §57's "seed through the real service" rule: a fixture
 * that inserted `status = 'PUBLISHED'` directly would let a broken gate stay green.
 */
export async function seedInstruments(admin: StaffUserFixture) {
  const [adminRow] = await db().select().from(users).where(eq(users.id, admin.id)).limit(1);

  if (adminRow === undefined) {
    throw new Error('Fixture admin not found.');
  }

  return seedAssessmentInstruments(db(), adminRow);
}

/** A class with one enrolled student, and that student's bearer token. */
export async function classWithStudent(counselorToken: string, name = 'Juan Dela Cruz') {
  const classRoom = await createClass(counselorToken);
  const roster = await enrolStudents(counselorToken, classRoom.id, [name]);
  const studentToken = await joinClass(classRoom.join_code, roster[0].username);

  return { classRoom, student: roster[0], studentToken };
}

/**
 * The taxonomy fields (migration 0014) every assessment now needs, resolved from the reference rows
 * the migration seeds.
 *
 * Resolved by `code` rather than pasted as UUIDs: a test that hard-coded `a55e7001-…-004` would
 * still pass if the seeded row meant something else, and this way the fixture fails loudly if the
 * migration ever stops shipping the taxonomy. `Interest` + Likert/Raw is chosen because it is a
 * *legal* pair under `assessment_type_scorings` — a fixture that used an illegal one would make
 * every unrelated builder test fail on validation.
 */
export async function assessmentTaxonomy(): Promise<{
  assessmentTypeId: string;
  scoringIds: string[];
}> {
  const taxonomy = new AssessmentTaxonomyService(db());

  return {
    assessmentTypeId: (await taxonomy.typeByCode('INTEREST')).id,
    scoringIds: await taxonomy.scoringIdsByCodes(['LIKERT_SCALES', 'RAW_SCORES']),
  };
}

/** The same fields in the API's snake_case, for a `POST /assessment-templates` body. */
export async function assessmentTaxonomyBody(): Promise<{
  assessment_type_id: string;
  scoring_ids: string[];
}> {
  const { assessmentTypeId, scoringIds } = await assessmentTaxonomy();

  return { assessment_type_id: assessmentTypeId, scoring_ids: scoringIds };
}

/** Assign a published version to a class and return the assignment. */
export async function assignVersion(
  counselorToken: string,
  classId: string,
  versionId: string,
): Promise<any> {
  const response = await api('POST', `/counselor/classes/${classId}/assignments`, {
    token: counselorToken,
    body: { assessment_version_id: versionId },
  });

  if (response.status !== 201) {
    throw new Error(`Fixture assignment failed: ${JSON.stringify(response.body)}`);
  }

  return response.body.data;
}

/**
 * How many answer requests this fixture keeps in flight at once.
 *
 * Eight rather than "all of them": the point is to stop *serialising* 90 round trips, not to fire
 * 60 simultaneous requests at a single-threaded local D1 and measure something other than the
 * feature. Beyond a handful the wall-clock stops improving and the contention starts showing up
 * as variance in other files sharing the machine.
 */
const ANSWER_CONCURRENCY = 8;

/**
 * Answer every question in an attempt with the option at `optionIndex` (0 = "Strongly Disagree",
 * 4 = "Strongly Agree"), or with a per-section score chosen by `pick`.
 *
 * **Every answer still goes through the real HTTP endpoint** — that is the whole reason these
 * fixtures are expensive and it is not something to trade away. What changed is that they no
 * longer go one at a time.
 *
 * ## Why this was worth changing
 *
 * A fully-assessed student costs 60 + 30 answers, and `test/recommendation/` needs several. Run
 * serially that is ~90 sequential round trips per student, and it was the single largest cost in
 * the suite: `regeneration.test.ts > lets a counselor rebuild for their own student` took 27 s
 * alone and **121.8 s inside the full run**, against a 120 s budget — a real CI failure whose only
 * symptom was a timeout on a test that passes in isolation. Raising the budget again (5 s → 30 s →
 * 60 s → 120 s, each documented in vitest.config.ts) would have moved the cliff rather than
 * removed it, on a CI runner the config itself describes as "two cores and always cold".
 *
 * ## Why concurrency is safe here, structurally and not by luck
 *
 * `AssessmentAttemptService.saveAnswer` is an **atomic upsert** on the `(attempt_id, question_id)`
 * unique index — written that way for H4, precisely so two near-simultaneous saves cannot race.
 * It writes one row per question and touches no attempt-level state, so answers to distinct
 * questions are independent by construction.
 *
 * Nothing asserts the *order* answers arrive in. `answerAll` is a fixture at all 26 of its call
 * sites: the assertions are about the attempt that results, and the one test that measures cost
 * (`platform/subrequest-budget.test.ts`) measures the submit, where each answer is its own
 * top-level request either way. A test that did care about answering order would call the
 * endpoint directly rather than reach for a helper named "answer all of them".
 */
/**
 * `pick` returns a **response level, 0 = lowest score … n-1 = highest** — not a position in the
 * payload.
 *
 * The two used to be the same number, and every caller here is written in terms of the first:
 * `RIASEC_PICKS` is commented "0 → 1 (Strongly Disagree) … 4 → 5 (Strongly Agree)", and
 * `player.test.ts` writes `return 4; // score 5`. Migration 0037 presents the Likert scale
 * positive-first (§8A: Strongly Agree at the top), so payload position 0 is now the *highest*
 * score — which would have silently inverted every scoring fixture in the suite while the scoring
 * code itself was untouched.
 *
 * So the index is resolved against the options sorted by their **answer key** (`value`, which is
 * `'1'`…`'5'` on a Likert item and is what the score is derived from), rather than against the
 * order they happen to be presented in. The fixtures now say what they always meant, and they stay
 * true whichever way the scale is drawn — which is the property §8A's "changing the visual order
 * must not change the scoring" is actually asking anyone to be able to check.
 *
 * Options whose `value` is not numeric (a CUSTOM multiple-choice item) keep their payload order:
 * there is no score ordering to resolve against, and position is the only meaning available.
 */
export async function answerAll(
  studentToken: string,
  attempt: any,
  pick: (question: any, index: number) => number,
): Promise<void> {
  const questions: any[] = attempt.questions;

  const saveOne = async (question: any, index: number): Promise<void> => {
    const option = byAscendingValue(question.options)[pick(question, index)];

    const response = await api('POST', `/student/attempts/${attempt.id}/answers`, {
      token: studentToken,
      body: { question_id: question.id, selected_option_id: option.id },
    });

    if (response.status !== 200) {
      throw new Error(`Fixture answer failed: ${JSON.stringify(response.body)}`);
    }
  };

  // A fixed pool of workers pulling from a shared cursor, rather than `Promise.all` over slices:
  // a slice-based split stalls the whole batch on its slowest slice, and these requests are not
  // uniform (the first pays connection setup, later ones do not).
  let cursor = 0;
  const workers = Array.from({ length: Math.min(ANSWER_CONCURRENCY, questions.length) }, async () => {
    for (let index = cursor++; index < questions.length; index = cursor++) {
      await saveOne(questions[index], index);
    }
  });

  await Promise.all(workers);
}

/**
 * A question's options ordered lowest score first, for `answerAll`.
 *
 * The player payload deliberately carries **no score** (§37 — a student who can see that Strongly
 * Agree is worth 5 stops answering an interest inventory), so this sorts on `value`, the stored
 * answer key, which for both curated instruments is the score written as a string.
 */
function byAscendingValue(options: any[]): any[] {
  const numeric = options.every((option) => Number.isFinite(Number(option.value)));

  return numeric
    ? [...options].sort((a, b) => Number(a.value) - Number(b.value))
    : options;
}

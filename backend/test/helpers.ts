import { SELF, env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';

import { createDatabase } from '@/db/client';
import type { UserRole, UserStatus } from '@/db/enums';
import {
  apiTokens,
  auditLogs,
  classStudents,
  classes,
  colleges,
  counselorProfiles,
  passwordResetTokens,
  programCareers,
  programs,
  users,
} from '@/db/schema';
import { hashPassword } from '@/do/auth-guard';
import { uuid } from '@/lib/crypto';
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
  overrides: { name?: string; academic_year?: string; grade_level?: string } = {},
): Promise<any> {
  const response = await api('POST', '/counselor/classes', {
    token,
    body: {
      name: overrides.name ?? 'Grade 12 STEM A',
      academic_year: overrides.academic_year ?? '2026-2027',
      grade_level: overrides.grade_level ?? 'Grade 12',
    },
  });

  if (response.status !== 201) {
    throw new Error(`Fixture class creation failed: ${JSON.stringify(response.body)}`);
  }

  return response.body.data;
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

/** Join a class as a student and return the bearer token. */
export async function joinClass(classCode: string, username: string): Promise<string> {
  const response = await api('POST', '/student-access/join', {
    body: { class_code: classCode, username },
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
 * Answer every question in an attempt with the option at `optionIndex` (0 = "Strongly Disagree",
 * 4 = "Strongly Agree"), or with a per-section score chosen by `pick`.
 */
export async function answerAll(
  studentToken: string,
  attempt: any,
  pick: (question: any, index: number) => number,
): Promise<void> {
  for (const [index, question] of attempt.questions.entries()) {
    const optionIndex = pick(question, index);
    const option = question.options[optionIndex];

    const response = await api('POST', `/student/attempts/${attempt.id}/answers`, {
      token: studentToken,
      body: { question_id: question.id, selected_option_id: option.id },
    });

    if (response.status !== 200) {
      throw new Error(`Fixture answer failed: ${JSON.stringify(response.body)}`);
    }
  }
}

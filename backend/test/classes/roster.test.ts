import { describe, expect, it } from 'vitest';

import {
  api,
  countTokensFor,
  createClass,
  createStaffUser,
  enrolStudents,
  findEnrollment,
  findUser,
  joinClass,
  login,
} from '../helpers';

/**
 * Bulk roster provisioning (FULLPLAN §16, §20).
 *
 * Preview proposes and persists nothing; confirm creates the accounts. The two rules that
 * carry the most weight here: **a mononym is a name, not an error** (§13.1, v1.2), and **one
 * collision rejects the whole batch** — there is no half-provisioned roster.
 */

async function counselorWithClass() {
  const counselor = await createStaffUser();
  const token = await login(counselor);
  const classRoom = await createClass(token);

  return { counselor, token, classRoom };
}

function preview(token: string, classId: string, names: string[]) {
  return api('POST', `/counselor/classes/${classId}/students/preview`, {
    token,
    body: { names },
  });
}

function confirm(token: string, classId: string, students: unknown[]) {
  return api('POST', `/counselor/classes/${classId}/students/confirm`, {
    token,
    body: { students },
  });
}

describe('POST …/students/preview', () => {
  it('proposes first.last usernames and persists nothing', async () => {
    const { token, classRoom } = await counselorWithClass();

    const response = await preview(token, classRoom.id, ['Juan Dela Cruz']);

    expect(response.status).toBe(200);
    expect(response.body.data.students[0]).toEqual({
      name: 'Juan Dela Cruz',
      first_name: 'Juan',
      last_name: 'Dela Cruz',
      username: 'juan.delacruz',
    });

    // Nothing was written: the roster is still empty.
    const roster = await api('GET', `/counselor/classes/${classRoom.id}/students`, { token });

    expect(roster.body.data).toHaveLength(0);
  });

  it('treats a one-word line as a mononym, not a validation error', async () => {
    const { token, classRoom } = await counselorWithClass();

    const response = await preview(token, classRoom.id, ['Madonna']);

    expect(response.status).toBe(200);
    expect(response.body.data.students[0]).toEqual({
      name: 'Madonna',
      first_name: 'Madonna',
      last_name: null,
      username: 'madonna',
    });
  });

  it('ASCII-folds accents and strips punctuation', async () => {
    const { token, classRoom } = await counselorWithClass();

    const response = await preview(token, classRoom.id, ['José Peña', "Mary-Anne O'Brien"]);

    expect(response.body.data.students[0].username).toBe('jose.pena');
    expect(response.body.data.students[1].username).toBe('maryanne.obrien');
  });

  it('splits on the first token: everything after it is the last name', async () => {
    const { token, classRoom } = await counselorWithClass();

    const response = await preview(token, classRoom.id, ['Maria Clara Dela Cruz Santos']);

    expect(response.body.data.students[0]).toMatchObject({
      first_name: 'Maria',
      last_name: 'Clara Dela Cruz Santos',
      username: 'maria.claradelacruzsantos',
    });
  });

  it('suffixes duplicates within the same batch', async () => {
    const { token, classRoom } = await counselorWithClass();

    const response = await preview(token, classRoom.id, [
      'Juan Dela Cruz',
      'Juan Dela Cruz',
      'Juan Dela Cruz',
    ]);

    expect(response.body.data.students.map((s: any) => s.username)).toEqual([
      'juan.delacruz',
      'juan.delacruz2',
      'juan.delacruz3',
    ]);
  });

  it('suffixes against usernames already enrolled in the class', async () => {
    const { token, classRoom } = await counselorWithClass();

    await enrolStudents(token, classRoom.id, ['Juan Dela Cruz']);

    const response = await preview(token, classRoom.id, ['Juan Dela Cruz']);

    expect(response.body.data.students[0].username).toBe('juan.delacruz2');
  });

  it('scopes collisions to this class only — usernames are per-class, not global', async () => {
    const { token } = await counselorWithClass();
    const first = await createClass(token, { name: 'Section A' });
    const second = await createClass(token, { name: 'Section B' });

    await enrolStudents(token, first.id, ['Juan Dela Cruz']);

    const response = await preview(token, second.id, ['Juan Dela Cruz']);

    // The same handle is free in a different class: the class code already disambiguates.
    expect(response.body.data.students[0].username).toBe('juan.delacruz');
  });

  it('caps the batch at 200 names', async () => {
    const { token, classRoom } = await counselorWithClass();

    const response = await preview(
      token,
      classRoom.id,
      Array.from({ length: 201 }, (_, i) => `Student Number${i}`),
    );

    expect(response.status).toBe(422);
    expect(response.body.errors.names).toBeDefined();
  });

  it('rejects an empty list', async () => {
    const { token, classRoom } = await counselorWithClass();

    const response = await preview(token, classRoom.id, []);

    expect(response.status).toBe(422);
  });
});

describe('POST …/students/confirm', () => {
  it('creates the accounts and returns the roster', async () => {
    const { token, classRoom } = await counselorWithClass();

    const response = await confirm(token, classRoom.id, [
      { first_name: 'Juan', last_name: 'Dela Cruz', username: 'juan.delacruz' },
      { first_name: 'Madonna', last_name: null, username: 'madonna' },
    ]);

    expect(response.status).toBe(201);
    expect(response.body.data).toHaveLength(2);

    // Ordered by username: madonna before juan.delacruz.
    expect(response.body.data.map((row: any) => row.username)).toEqual([
      'juan.delacruz',
      'madonna',
    ]);
    expect(response.body.data[1]).toMatchObject({
      class_id: classRoom.id,
      username: 'madonna',
      status: 'active',
      first_name: 'Madonna',
      last_name: null,
    });
  });

  it('confirms a mononym exactly as previewed — no invented surname', async () => {
    const { token, classRoom } = await counselorWithClass();

    const previewed = await preview(token, classRoom.id, ['Madonna']);
    const response = await confirm(token, classRoom.id, [
      {
        first_name: previewed.body.data.students[0].first_name,
        last_name: previewed.body.data.students[0].last_name,
        username: previewed.body.data.students[0].username,
      },
    ]);

    expect(response.status).toBe(201);
    expect(response.body.data[0].last_name).toBeNull();
  });

  it('normalises an empty-string last name to NULL', async () => {
    // `""` and "this person has one name" are not the same claim, and only one is true.
    const { token, classRoom } = await counselorWithClass();

    const response = await confirm(token, classRoom.id, [
      { first_name: 'Madonna', last_name: '', username: 'madonna' },
    ]);

    expect(response.status).toBe(201);
    expect(response.body.data[0].last_name).toBeNull();
  });

  it('honours a username the counselor edited after preview', async () => {
    const { token, classRoom } = await counselorWithClass();

    await preview(token, classRoom.id, ['Juan Dela Cruz']);

    const response = await confirm(token, classRoom.id, [
      { first_name: 'Juan', last_name: 'Dela Cruz', username: 'jdc' },
    ]);

    expect(response.status).toBe(201);
    expect(response.body.data[0].username).toBe('jdc');
  });

  it('creates students with no password and no email — passwordless by design', async () => {
    const { token, classRoom } = await counselorWithClass();

    const [enrolled] = await enrolStudents(token, classRoom.id, ['Juan Dela Cruz']);
    const student = await findUser(enrolled.student_id);

    expect(student?.role).toBe('student');
    expect(student?.password).toBeNull();
    expect(student?.email).toBeNull();
    expect(student?.status).toBe('active');
  });

  it('rejects the WHOLE batch when one username collides with the class', async () => {
    const { token, classRoom } = await counselorWithClass();

    await enrolStudents(token, classRoom.id, ['Juan Dela Cruz']);

    const response = await confirm(token, classRoom.id, [
      { first_name: 'Ana', last_name: 'Reyes', username: 'ana.reyes' },
      { first_name: 'Juan', last_name: 'Dela Cruz', username: 'juan.delacruz' }, // collides
      { first_name: 'Bea', last_name: 'Cruz', username: 'bea.cruz' },
    ]);

    expect(response.status).toBe(422);
    expect(response.body.errors['students.1.username']).toBeDefined();

    // There is no half-provisioned roster: Ana and Bea were not created either.
    const roster = await api('GET', `/counselor/classes/${classRoom.id}/students`, { token });

    expect(roster.body.data.map((row: any) => row.username)).toEqual(['juan.delacruz']);
  });

  it('rejects the batch when it collides with itself', async () => {
    const { token, classRoom } = await counselorWithClass();

    const response = await confirm(token, classRoom.id, [
      { first_name: 'Ana', last_name: 'Reyes', username: 'ana.reyes' },
      { first_name: 'Another', last_name: 'Ana', username: 'ana.reyes' },
    ]);

    expect(response.status).toBe(422);
    expect(response.body.errors['students.1.username']).toBeDefined();

    const roster = await api('GET', `/counselor/classes/${classRoom.id}/students`, { token });

    expect(roster.body.data).toHaveLength(0);
  });

  it('rejects a malformed username', async () => {
    const { token, classRoom } = await counselorWithClass();

    const response = await confirm(token, classRoom.id, [
      { first_name: 'Juan', last_name: 'Dela Cruz', username: 'Juan Dela Cruz' },
    ]);

    expect(response.status).toBe(422);
    expect(response.body.errors['students.0.username']).toBeDefined();
  });
});

describe('GET …/students', () => {
  it('lists active students ordered by username, excluding removed ones', async () => {
    const { token, classRoom } = await counselorWithClass();

    const enrolled = await enrolStudents(token, classRoom.id, [
      'Zoe Zamora',
      'Ana Reyes',
      'Juan Dela Cruz',
    ]);

    const removed = enrolled.find((row) => row.username === 'zoe.zamora')!;

    await api('DELETE', `/counselor/classes/${classRoom.id}/students/${removed.student_id}`, {
      token,
    });

    const response = await api('GET', `/counselor/classes/${classRoom.id}/students`, { token });

    expect(response.body.data.map((row: any) => row.username)).toEqual([
      'ana.reyes',
      'juan.delacruz',
    ]);
  });
});

describe('DELETE …/students/{studentId}', () => {
  it('marks the enrolment removed and revokes the student’s live token in the same act', async () => {
    // Marking the row removed only closes the front door — the student is already inside,
    // holding a bearer token that never re-consults the roster. This is audit F-H3.
    const { token, classRoom } = await counselorWithClass();
    const [enrolled] = await enrolStudents(token, classRoom.id, ['Juan Dela Cruz']);

    const studentToken = await joinClass(classRoom.join_code, enrolled.username);

    await expect(countTokensFor(enrolled.student_id)).resolves.toBe(1);

    const response = await api(
      'DELETE',
      `/counselor/classes/${classRoom.id}/students/${enrolled.student_id}`,
      { token },
    );

    expect(response.status).toBe(204);
    await expect(countTokensFor(enrolled.student_id)).resolves.toBe(0);

    // The session they were already sitting in is dead *now*, not at next sign-out.
    const afterRemoval = await api('GET', '/auth/me', { token: studentToken });

    expect(afterRemoval.status).toBe(401);
  });

  it('cannot be re-joined afterwards', async () => {
    const { token, classRoom } = await counselorWithClass();
    const [enrolled] = await enrolStudents(token, classRoom.id, ['Juan Dela Cruz']);

    await api('DELETE', `/counselor/classes/${classRoom.id}/students/${enrolled.student_id}`, {
      token,
    });

    const rejoin = await api('POST', '/student-access/join', {
      body: { class_code: classRoom.join_code, username: enrolled.username },
    });

    expect(rejoin.status).toBe(401);
  });

  it('keeps the enrolment row as history rather than deleting it', async () => {
    const { token, classRoom } = await counselorWithClass();
    const [enrolled] = await enrolStudents(token, classRoom.id, ['Juan Dela Cruz']);

    await api('DELETE', `/counselor/classes/${classRoom.id}/students/${enrolled.student_id}`, {
      token,
    });

    const row = await findEnrollment(enrolled.id);

    expect(row).toBeDefined();
    expect(row?.status).toBe('removed');
    expect(row?.removedAt).not.toBeNull();
  });

  it('404s for a student who is not in this class, rather than revealing they exist', async () => {
    const { token, classRoom } = await counselorWithClass();
    const other = await createClass(token, { name: 'Other section' });
    const [elsewhere] = await enrolStudents(token, other.id, ['Juan Dela Cruz']);

    const response = await api(
      'DELETE',
      `/counselor/classes/${classRoom.id}/students/${elsewhere.student_id}`,
      { token },
    );

    expect(response.status).toBe(404);
  });
});

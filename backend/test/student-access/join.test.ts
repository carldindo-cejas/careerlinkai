import { describe, expect, it } from 'vitest';

import {
  allAuditRows,
  api,
  countTokensFor,
  createClass,
  createStaffUser,
  enrolStudents,
  expireJoinCode,
  findAuditRowForClass,
  login,
  setUserStatus,
} from '../helpers';

/**
 * POST /student-access/join (FULLPLAN §38).
 *
 * The security model of the entire student flow lives in this one endpoint, and almost all of
 * it is about what the endpoint refuses to say. A student's credential is a code their whole
 * class knows plus a username derived from their own name — so the compensating controls are
 * the generic error, the `(code, IP)` throttle, and the audit trail, and each is tested here
 * as a control rather than as a feature.
 */

/** The one failure response. Every rejection must match this byte for byte. */
const GENERIC_FAILURE = {
  success: false,
  message: 'The class code or username is incorrect.',
  errors: {},
};

async function classWithStudent() {
  const counselor = await createStaffUser();
  const token = await login(counselor);
  const classRoom = await createClass(token);
  const [student] = await enrolStudents(token, classRoom.id, ['Juan Dela Cruz']);

  return { counselor, token, classRoom, student };
}

function join(classCode: string, username: string, ip?: string) {
  return api('POST', '/student-access/join', {
    body: { class_code: classCode, username },
    ...(ip ? { ip } : {}),
  });
}

describe('POST /student-access/join — success', () => {
  it('grants access with only a class code and a username', async () => {
    const { classRoom, student } = await classWithStudent();

    const response = await join(classRoom.join_code, student.username);

    expect(response.status).toBe(200);
    expect(response.body.message).toBe('Access granted.');
    expect(response.body.data.user).toMatchObject({
      id: student.student_id,
      role: 'student',
      status: 'active',
      email: null,
    });
    expect(response.body.data.username).toBe('juan.delacruz');
    expect(typeof response.body.data.token).toBe('string');
  });

  it('never sends the join code back out in a student-facing response', async () => {
    // The code is a shared secret. A student-facing payload that echoed it would hand every
    // student a copy of the class's front-door key in a form they can screenshot.
    const { classRoom, student } = await classWithStudent();

    const response = await join(classRoom.join_code, student.username);

    expect(response.body.data.class).toEqual({
      id: classRoom.id,
      name: classRoom.name,
      academic_year: classRoom.academic_year,
      grade_level: classRoom.grade_level,
    });
    expect(response.body.data.class).not.toHaveProperty('join_code');
    expect(response.body.data.class).not.toHaveProperty('counselor_id');
    expect(JSON.stringify(response.body)).not.toContain(classRoom.join_code);
  });

  it('matches the code and username case-insensitively, and trims them', async () => {
    const { classRoom, student } = await classWithStudent();

    const response = await join(
      `  ${classRoom.join_code.toLowerCase()}  `,
      `  ${student.username.toUpperCase()}  `,
    );

    expect(response.status).toBe(200);
  });

  it('issues a working token', async () => {
    const { classRoom, student } = await classWithStudent();

    const { body } = await join(classRoom.join_code, student.username);
    const me = await api('GET', '/auth/me', { token: body.data.token });

    expect(me.status).toBe(200);
    expect(me.body.data.id).toBe(student.student_id);
  });

  it('replaces the prior token — one active session per student', async () => {
    const { classRoom, student } = await classWithStudent();

    const first = await join(classRoom.join_code, student.username);
    const second = await join(classRoom.join_code, student.username);

    await expect(countTokensFor(student.student_id)).resolves.toBe(1);

    // The machine left signed in at the back of the lab stops being a way in.
    await expect(
      api('GET', '/auth/me', { token: first.body.data.token }),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      api('GET', '/auth/me', { token: second.body.data.token }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('audits the success against the class and the student', async () => {
    const { classRoom, student } = await classWithStudent();

    await join(classRoom.join_code, student.username);

    const row = await findAuditRowForClass('STUDENT_CLASS_ACCESS_SUCCESS', classRoom.id);

    expect(row?.userId).toBe(student.student_id);
    expect(row?.ipAddress).toBe('203.0.113.10');
  });
});

describe('POST /student-access/join — every failure is the identical 401', () => {
  it('unknown class code', async () => {
    const response = await join('ZZZZ-9999', 'juan.delacruz');

    expect(response.status).toBe(401);
    expect(response.body).toEqual(GENERIC_FAILURE);
  });

  it('valid code, unknown username — indistinguishable from an unknown code', async () => {
    // This is the specific pairing that stops the endpoint being used to enumerate a roster:
    // "is juan.delacruz in this class?" must be unanswerable.
    const { classRoom } = await classWithStudent();

    const unknownCode = await join('ZZZZ-9999', 'juan.delacruz');
    const unknownUser = await join(classRoom.join_code, 'nobody.here');

    expect(unknownUser.status).toBe(401);
    expect(unknownUser.body).toEqual(GENERIC_FAILURE);
    expect(unknownUser.body).toEqual(unknownCode.body);
  });

  it('expired join code', async () => {
    const { classRoom, student } = await classWithStudent();

    await expireJoinCode(classRoom.id);

    const response = await join(classRoom.join_code, student.username);

    expect(response.status).toBe(401);
    expect(response.body).toEqual(GENERIC_FAILURE);
  });

  it('archived class', async () => {
    const { token, classRoom, student } = await classWithStudent();

    await api('PATCH', `/counselor/classes/${classRoom.id}`, {
      token,
      body: { status: 'archived' },
    });

    const response = await join(classRoom.join_code, student.username);

    expect(response.status).toBe(401);
    expect(response.body).toEqual(GENERIC_FAILURE);
  });

  it('draft class', async () => {
    const { token, classRoom, student } = await classWithStudent();

    await api('PATCH', `/counselor/classes/${classRoom.id}`, {
      token,
      body: { status: 'draft' },
    });

    const response = await join(classRoom.join_code, student.username);

    expect(response.status).toBe(401);
  });

  it('soft-deleted class', async () => {
    const { token, classRoom, student } = await classWithStudent();

    await api('DELETE', `/counselor/classes/${classRoom.id}`, { token });

    const response = await join(classRoom.join_code, student.username);

    expect(response.status).toBe(401);
  });

  it('removed enrolment', async () => {
    const { token, classRoom, student } = await classWithStudent();

    await api('DELETE', `/counselor/classes/${classRoom.id}/students/${student.student_id}`, {
      token,
    });

    const response = await join(classRoom.join_code, student.username);

    expect(response.status).toBe(401);
    expect(response.body).toEqual(GENERIC_FAILURE);
  });

  it('deactivated account', async () => {
    const { classRoom, student } = await classWithStudent();

    await setUserStatus(student.student_id, 'suspended');

    const response = await join(classRoom.join_code, student.username);

    expect(response.status).toBe(401);
    expect(response.body).toEqual(GENERIC_FAILURE);
  });

  it('rejects a blank code or username as a 422, before anything is looked up', async () => {
    const response = await api('POST', '/student-access/join', {
      body: { class_code: '', username: '' },
    });

    expect(response.status).toBe(422);
  });
});

describe('POST /student-access/join — the audit trail carries the real reason', () => {
  it('records why each failure actually failed, though the API never says', async () => {
    const { token, classRoom, student } = await classWithStudent();

    await join(classRoom.join_code, 'nobody.here');
    await expect(
      findAuditRowForClass('STUDENT_CLASS_ACCESS_FAILED', classRoom.id),
    ).resolves.toMatchObject({ newValues: { reason: 'UNKNOWN_USERNAME' } });

    await api('PATCH', `/counselor/classes/${classRoom.id}`, {
      token,
      body: { status: 'archived' },
    });
    await join(classRoom.join_code, student.username);

    await expect(
      findAuditRowForClass('STUDENT_CLASS_ACCESS_FAILED', classRoom.id),
    ).resolves.toMatchObject({ newValues: { reason: 'CLASS_NOT_ACTIVE' } });
  });

  it('records an unknown code with no class attributed to it', async () => {
    await join('QQQQ-8888', 'someone');

    const rows = await allAuditRows();
    const row = rows.find(
      (r) => r.action === 'STUDENT_CLASS_ACCESS_FAILED' && r.newValues?.class_code === 'QQQQ-8888',
    );

    expect(row).toBeDefined();
    expect(row?.userId).toBeNull();
    expect(row?.targetId).toBeNull();
    expect(row?.newValues?.reason).toBe('INVALID_CODE');
  });
});

describe('POST /student-access/join — throttle (§38: 10 failures per (code, IP) / 15 min)', () => {
  it('locks the (code, IP) pair after 10 failures, even for correct credentials', async () => {
    const { classRoom, student } = await classWithStudent();
    const ip = '198.51.100.20';

    for (let attempt = 1; attempt <= 9; attempt += 1) {
      const response = await join(classRoom.join_code, 'wrong.username', ip);

      expect(response.status).toBe(401);
    }

    const tenth = await join(classRoom.join_code, 'wrong.username', ip);

    expect(tenth.status).toBe(429);
    expect(tenth.body.message).toBe('Validation failed.');
    expect(tenth.body.errors.class_code[0]).toMatch(/Too many failed attempts/);

    // Frozen even for the right username — the lock is on the pair, not on the guess.
    const correct = await join(classRoom.join_code, student.username, ip);

    expect(correct.status).toBe(429);
  });

  it('counts failures only — a whole class joining from one lab IP is never locked out', async () => {
    // This is the rule that matters most in practice: 30 students behind one school NAT all
    // join successfully. Counting successes here would lock out the eleventh child.
    const counselor = await createStaffUser();
    const token = await login(counselor);
    const classRoom = await createClass(token);

    const names = Array.from({ length: 12 }, (_, i) => `Student Number${i}`);
    const enrolled = await enrolStudents(token, classRoom.id, names);
    const labIp = '198.51.100.30';

    for (const student of enrolled) {
      const response = await join(classRoom.join_code, student.username, labIp);

      expect(response.status, `student ${student.username}`).toBe(200);
    }
  });

  it('clears the counter on a success', async () => {
    const { classRoom, student } = await classWithStudent();
    const ip = '198.51.100.40';

    for (let attempt = 1; attempt <= 9; attempt += 1) {
      await join(classRoom.join_code, 'wrong.username', ip);
    }

    await expect(join(classRoom.join_code, student.username, ip)).resolves.toMatchObject({
      status: 200,
    });

    // Counter reset: nine fresh failures are once again below the limit.
    for (let attempt = 1; attempt <= 9; attempt += 1) {
      const response = await join(classRoom.join_code, 'wrong.username', ip);

      expect(response.status).toBe(401);
    }
  });

  it('is keyed per (code, IP): another IP is unaffected', async () => {
    const { classRoom, student } = await classWithStudent();

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await join(classRoom.join_code, 'wrong.username', '198.51.100.50');
    }

    const elsewhere = await join(classRoom.join_code, student.username, '198.51.100.51');

    expect(elsewhere.status).toBe(200);
  });

  it('audits a throttled attempt', async () => {
    const { classRoom } = await classWithStudent();
    const ip = '198.51.100.60';

    for (let attempt = 1; attempt <= 11; attempt += 1) {
      await join(classRoom.join_code, 'wrong.username', ip);
    }

    const rows = await allAuditRows();

    expect(rows.some((row) => row.action === 'STUDENT_CLASS_ACCESS_THROTTLED')).toBe(true);
  });
});

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { appSettings, counselorProfiles, users } from '@/db/schema';

import {
  api,
  backdateSignupRequest,
  createStaffUser,
  db,
  findSignupRequest,
  setCounselorSignupEnabled,
} from '../helpers';

/**
 * Counselor self-signup (migration 0034) — the only unauthenticated endpoint in this system that
 * creates an account.
 *
 * Four claims are load-bearing, and each of them fails silently if it regresses:
 *
 *   1. **The switch actually closes the door**, at every step, including one already in flight.
 *      A signup that could be *completed* after an administrator closed registration would make
 *      the switch decorative at exactly the moment it is being used in anger.
 *   2. **The password the person chose really opens the account.** The whole flow is worthless if
 *      it ends in an account nobody can sign in to — and this project has shipped a
 *      credential-that-does-not-work bug twice, which is why it is asserted against the real
 *      `/auth/login` rather than against the hash.
 *   3. **The code is guessable in 10^6 tries unless the lockout holds**, so the lockout is tested
 *      by exhausting it rather than by reading the constant.
 *   4. **A taken address is indistinguishable from a free one in the response** (§38), and stages
 *      nothing — otherwise the form is an account-enumeration oracle with a database behind it.
 *
 * `APP_ENV` is `local` under `wrangler.test.toml`, so the route echoes the verification code in
 * the response body. That is the same affordance `/auth/forgot-password` has for its reset token,
 * and it is what lets these tests exercise the flow end to end with no mail channel (there is no
 * `RESEND_API_KEY` in the suite, by design — the sender returns `not_configured` before it can
 * reach the network).
 */

const PASSWORD = 'ChosenByThem1';

/**
 * A caller nobody else in this file shares.
 *
 * Storage is shared between the tests in a file (see `test/setup.ts`) and **that includes Durable
 * Object state**, so the per-IP signup throttle carries from one test into the next: with a fixed
 * address the fourth test in the file would 429 for reasons that have nothing to do with what it is
 * testing. Every request therefore comes from its own address unless a test is specifically about
 * the throttle, in which case it names one and reuses it deliberately.
 */
let callers = 0;

function freshIp(): string {
  callers += 1;

  return `10.${(callers >> 16) & 255}.${(callers >> 8) & 255}.${callers & 255}`;
}

function signupBody(email: string, overrides: Record<string, unknown> = {}) {
  return {
    email,
    password: PASSWORD,
    password_confirmation: PASSWORD,
    first_name: 'Liza',
    last_name: 'Manalo',
    specialization: 'Career Guidance',
    ...overrides,
  };
}

/** Start a signup from a caller of its own, and hand back the code the local route echoes. */
async function startSignup(email: string, overrides: Record<string, unknown> = {}) {
  return api('POST', '/auth/counselor-signup', {
    body: signupBody(email, overrides),
    ip: freshIp(),
  });
}

/** Run the whole flow, for the tests whose subject is what comes after it. */
async function completeSignup(email: string): Promise<void> {
  const started = await startSignup(email);
  const code = started.body.data.verification_code as string;

  const verified = await api('POST', '/auth/counselor-signup/verify', { body: { email, code } });

  expect(verified.status).toBe(201);
}

/**
 * Every test starts with registration closed, because the setting is a row in a database this file
 * shares between its tests — without this, whether a test sees an open form would depend on what
 * the test above it happened to leave behind.
 */
beforeEach(async () => {
  await setCounselorSignupEnabled(false);
});

describe('the switch', () => {
  it('reads as closed when the setting row is missing entirely', async () => {
    // The fail-closed property, which matters more than the seeded value: a failed migration, a
    // truncated table or a hand-written DELETE must leave registration shut, never open.
    await db().delete(appSettings).where(eq(appSettings.key, 'counselor_signup_enabled'));

    const status = await api('GET', '/auth/signup-status');

    expect(status.status).toBe(200);
    expect(status.body.data).toEqual({ counselor_signup_open: false });
  });

  it('refuses a submission while closed, and stages nothing', async () => {
    const email = 'closed@school.test';

    const response = await startSignup(email);

    expect(response.status).toBe(403);
    expect(await findSignupRequest(email)).toBeUndefined();
  });

  it('reports open once an administrator turns it on', async () => {
    await setCounselorSignupEnabled(true);

    const status = await api('GET', '/auth/signup-status');

    expect(status.body.data).toEqual({ counselor_signup_open: true });
  });

  /**
   * **The loophole this closes.** Registration is turned off because something is wrong; "requests
   * already in flight continue" is precisely where an abuse run would sit out the closure.
   */
  it('refuses to complete a signup started before it was closed', async () => {
    await setCounselorSignupEnabled(true);

    const email = 'inflight@school.test';
    const started = await startSignup(email);
    const code = started.body.data.verification_code as string;

    await setCounselorSignupEnabled(false);

    const verified = await api('POST', '/auth/counselor-signup/verify', { body: { email, code } });

    expect(verified.status).toBe(403);
    expect(await db().query.users.findFirst({ where: eq(users.email, email) })).toBeUndefined();
  });
});

describe('POST /auth/counselor-signup', () => {
  it('stages the signup and creates no user until the code is verified', async () => {
    await setCounselorSignupEnabled(true);

    const email = 'staged@school.test';
    const response = await startSignup(email);

    expect(response.status).toBe(202);

    const staged = await findSignupRequest(email);

    expect(staged).toMatchObject({ email, firstName: 'Liza', lastName: 'Manalo' });
    // The code is mailed, never stored — a D1 read must not be equivalent to reading the mailbox.
    expect(staged?.codeHash).not.toBe(response.body.data.verification_code);

    // **The reason this table exists.** An unverified signup that was a `users` row would squat the
    // address under `users_email_unique` forever, and would show up in /admin/counselors.
    expect(await db().query.users.findFirst({ where: eq(users.email, email) })).toBeUndefined();
  });

  /**
   * Case is normalised, so `Maria@school.test` and `maria@school.test` are one signup rather than
   * two racing to claim an address `users_email_unique` will only give to one of them.
   *
   * Surrounding whitespace is a different matter: `z.email()` rejects it outright here, exactly as
   * it does on `/auth/login` and `/auth/forgot-password`. The service trims anyway, but the schema
   * never lets a padded address reach it — which is worth leaving alone, because an address that
   * can be *registered* with a trailing space but not *signed in* with one would be the genuinely
   * confusing outcome.
   */
  it('lower-cases the address, so two spellings cannot stage two signups', async () => {
    await setCounselorSignupEnabled(true);

    await startSignup('Mixed@School.test');

    expect(await findSignupRequest('mixed@school.test')).toBeDefined();

    const padded = await startSignup('  spaced@school.test  ');

    expect(padded.status).toBe(422);
  });

  it('replaces a previous signup for the same address rather than accumulating rows', async () => {
    await setCounselorSignupEnabled(true);

    const email = 'twice@school.test';
    const first = await startSignup(email);
    const second = await startSignup(email, { first_name: 'Corrected' });

    const staged = await findSignupRequest(email);

    expect(staged?.firstName).toBe('Corrected');

    // The first code is dead: one live signup per address, so there is never a question of which
    // of two codes is the real one.
    const stale = await api('POST', '/auth/counselor-signup/verify', {
      body: { email, code: first.body.data.verification_code },
    });

    expect(stale.status).toBe(422);

    const fresh = await api('POST', '/auth/counselor-signup/verify', {
      body: { email, code: second.body.data.verification_code },
    });

    expect(fresh.status).toBe(201);
  });

  describe('validation', () => {
    it('rejects a password that fails the §38 policy', async () => {
      await setCounselorSignupEnabled(true);

      const response = await startSignup('weak@school.test', {
        password: 'short',
        password_confirmation: 'short',
      });

      expect(response.status).toBe(422);
      expect(response.body.errors.password).toBeDefined();
    });

    it('rejects a mismatched confirmation', async () => {
      await setCounselorSignupEnabled(true);

      const response = await startSignup('mismatch@school.test', {
        password_confirmation: 'SomethingElse1',
      });

      expect(response.status).toBe(422);
      expect(response.body.errors.password_confirmation).toBeDefined();
    });

    it('rejects a malformed email', async () => {
      await setCounselorSignupEnabled(true);

      const response = await startSignup('not-an-address');

      expect(response.status).toBe(422);
    });

    /**
     * **The boundary between a public form and the account table.** `.strict()` refuses the field
     * rather than ignoring it, so privilege escalation by extra JSON key is not a thing that can be
     * attempted quietly.
     */
    it.each(['role', 'status', 'email_verified_at', 'must_change_password'])(
      'refuses a body carrying %s rather than silently ignoring it',
      async (field) => {
        await setCounselorSignupEnabled(true);

        const response = await startSignup(`smuggle.${field}@school.test`, {
          [field]: 'admin',
        });

        expect(response.status).toBe(422);
        expect(await findSignupRequest(`smuggle.${field}@school.test`)).toBeUndefined();
      },
    );
  });

  /**
   * §38's anti-enumeration rule, on the one endpoint where breaking it would be most tempting —
   * telling somebody their address is taken is *helpful*. The mail is what makes the silence
   * honest rather than obstructive; it cannot be asserted here (no key in the suite), so what is
   * asserted is that the response and the database both give nothing away.
   */
  it('answers a registered address exactly as it answers a free one, and stages nothing', async () => {
    await setCounselorSignupEnabled(true);

    const existing = await createStaffUser({ role: 'counselor', email: 'taken@school.test' });

    const taken = await startSignup(existing.email);
    const free = await startSignup('free@school.test');

    expect(taken.status).toBe(free.status);
    expect(taken.body.message).toBe(free.body.message);
    // No code for the taken address — and in local, where the free one *does* carry a code, that
    // difference stays out of the message and the status.
    expect(taken.body.data).toBeNull();

    expect(await findSignupRequest(existing.email)).toBeUndefined();
  });

  /**
   * The throttle is charged before the address lookup, the derivation and the mail — see
   * `CounselorSignupService.signup`. Five an hour per IP; the sixth is refused.
   *
   * Exhausted rather than asserted against the constant, and the *ordering* is what this proves:
   * the refused attempt must leave no staged row, or the throttle is only rate-limiting the
   * response rather than the work behind it.
   */
  it('throttles a connection once its hourly allowance is spent', async () => {
    await setCounselorSignupEnabled(true);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const allowed = await api('POST', '/auth/counselor-signup', {
        body: signupBody(`burst${attempt}@school.test`),
        ip: '203.0.113.7',
      });

      expect(allowed.status).toBe(202);
    }

    const refused = await api('POST', '/auth/counselor-signup', {
      body: signupBody('burst6@school.test'),
      ip: '203.0.113.7',
    });

    expect(refused.status).toBe(429);
    expect(await findSignupRequest('burst6@school.test')).toBeUndefined();

    // Keyed on the connection, not the address: a different caller is unaffected.
    const other = await api('POST', '/auth/counselor-signup', {
      body: signupBody('elsewhere@school.test'),
      ip: '198.51.100.9',
    });

    expect(other.status).toBe(202);
  });
});

describe('POST /auth/counselor-signup/verify', () => {
  it('creates an active, email-verified counselor with their profile', async () => {
    await setCounselorSignupEnabled(true);

    const email = 'verified@school.test';

    await completeSignup(email);

    const user = await db().query.users.findFirst({ where: eq(users.email, email) });

    expect(user).toMatchObject({
      email,
      role: 'counselor',
      status: 'active',
      // Unlike the admin-created path: there is no admin-known credential to force out of
      // existence, so nobody is asked to change a password they chose thirty seconds ago.
      mustChangePassword: false,
      name: 'Liza Manalo',
    });
    expect(user?.emailVerifiedAt).not.toBeNull();

    const profile = await db().query.counselorProfiles.findFirst({
      where: eq(counselorProfiles.userId, user!.id),
    });

    expect(profile).toMatchObject({
      firstName: 'Liza',
      lastName: 'Manalo',
      specialization: 'Career Guidance',
    });

    // The staged row is consumed, so the code cannot be replayed into a second account.
    expect(await findSignupRequest(email)).toBeUndefined();
  });

  /** **The claim the whole feature rests on.** Asserted against the real login, never the hash. */
  it('produces an account the chosen password actually opens', async () => {
    await setCounselorSignupEnabled(true);

    const email = 'signs.in@school.test';

    await completeSignup(email);

    const login = await api('POST', '/auth/login', { body: { email, password: PASSWORD } });

    expect(login.status).toBe(200);
    expect(login.body.data.user).toMatchObject({ email, role: 'counselor' });
    // Straight in — no forced rotation standing between them and the app.
    expect(login.body.data.user.must_change_password).toBe(false);
    expect(login.body.data.token).toBeTruthy();
  });

  it('refuses a wrong code without creating anything', async () => {
    await setCounselorSignupEnabled(true);

    const email = 'wrongcode@school.test';

    await startSignup(email);

    const response = await api('POST', '/auth/counselor-signup/verify', {
      body: { email, code: '000000' },
    });

    expect(response.status).toBe(422);
    expect(await db().query.users.findFirst({ where: eq(users.email, email) })).toBeUndefined();
    // The staged signup survives a wrong guess — otherwise one typo would mean starting over.
    expect(await findSignupRequest(email)).toBeDefined();
  });

  it('refuses a malformed code before it reaches the hash', async () => {
    await setCounselorSignupEnabled(true);

    const email = 'malformed@school.test';

    await startSignup(email);

    const response = await api('POST', '/auth/counselor-signup/verify', {
      body: { email, code: '12345' },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.code).toBeDefined();
  });

  it('refuses an unknown address in the same shape as a wrong code', async () => {
    await setCounselorSignupEnabled(true);

    const response = await api('POST', '/auth/counselor-signup/verify', {
      body: { email: 'nobody@school.test', code: '123456' },
    });

    expect(response.status).toBe(422);
  });

  /**
   * Six digits is 10^6, which is only safe because this counter exists. Exhausted rather than
   * asserted against the constant — a limit that is read from the same place it is enforced proves
   * nothing about whether it is enforced.
   */
  it('locks the signup out on the fifth wrong code', async () => {
    await setCounselorSignupEnabled(true);

    const email = 'bruteforce@school.test';
    const started = await startSignup(email);

    // Four refusals, then the fifth *is* the lockout — the same shape as the §38 login lockout,
    // where the fifth failed attempt returns the 429 rather than the sixth.
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const wrong = await api('POST', '/auth/counselor-signup/verify', {
        body: { email, code: '000000' },
      });

      expect(wrong.status).toBe(422);
    }

    const fifth = await api('POST', '/auth/counselor-signup/verify', {
      body: { email, code: '000000' },
    });

    expect(fifth.status).toBe(429);
    expect(fifth.body.errors.code[0]).toMatch(/Too many incorrect codes/);

    // **The correct code is refused too.** A lockout that let the right answer through would be a
    // lockout an attacker walks past on the guess that happens to be right.
    const correct = await api('POST', '/auth/counselor-signup/verify', {
      body: { email, code: started.body.data.verification_code },
    });

    expect(correct.status).toBe(429);
  });

  it('refuses an expired code and clears the staged signup', async () => {
    await setCounselorSignupEnabled(true);

    const email = 'expired@school.test';
    const started = await startSignup(email);

    await backdateSignupRequest(email, 16);

    const response = await api('POST', '/auth/counselor-signup/verify', {
      body: { email, code: started.body.data.verification_code },
    });

    expect(response.status).toBe(422);
    expect(await findSignupRequest(email)).toBeUndefined();
  });

  /**
   * An expired code is the clock's doing, not a guess. Charging it would let anybody lock a
   * stranger's signup out by waiting fifteen minutes and then submitting.
   */
  it('does not charge an expired code against the guess counter', async () => {
    await setCounselorSignupEnabled(true);

    const email = 'expired.then.retry@school.test';
    const first = await startSignup(email);

    await backdateSignupRequest(email, 16);
    await api('POST', '/auth/counselor-signup/verify', {
      body: { email, code: first.body.data.verification_code },
    });

    // Start again from the same address and finish it — nothing is held against them.
    await completeSignup(email);

    expect(await db().query.users.findFirst({ where: eq(users.email, email) })).toBeDefined();
  });

  /**
   * The race the unique index is there for: the address was free when the signup was staged and an
   * admin created it in the meantime. The refusal has to be the 422 the pre-check would have given,
   * not a raw constraint 500.
   */
  it('refuses with a validation error when the address was claimed in the meantime', async () => {
    await setCounselorSignupEnabled(true);

    const email = 'raced@school.test';
    const started = await startSignup(email);

    await createStaffUser({ role: 'counselor', email });

    const response = await api('POST', '/auth/counselor-signup/verify', {
      body: { email, code: started.body.data.verification_code },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.email).toBeDefined();
  });
});

describe('POST /auth/counselor-signup/resend', () => {
  it('issues a new code and retires the old one', async () => {
    await setCounselorSignupEnabled(true);

    const email = 'resend@school.test';
    const first = await startSignup(email);
    const again = await api('POST', '/auth/counselor-signup/resend', { body: { email } });

    expect(again.status).toBe(202);

    const oldCode = first.body.data.verification_code as string;
    const newCode = again.body.data.verification_code as string;

    expect(newCode).not.toBe(oldCode);

    const stale = await api('POST', '/auth/counselor-signup/verify', {
      body: { email, code: oldCode },
    });

    expect(stale.status).toBe(422);

    const fresh = await api('POST', '/auth/counselor-signup/verify', {
      body: { email, code: newCode },
    });

    expect(fresh.status).toBe(201);
  });

  it('answers an address with no signup in flight identically, and stages nothing', async () => {
    await setCounselorSignupEnabled(true);

    const response = await api('POST', '/auth/counselor-signup/resend', {
      body: { email: 'never.started@school.test' },
    });

    expect(response.status).toBe(202);
    expect(response.body.data).toBeNull();
    expect(await findSignupRequest('never.started@school.test')).toBeUndefined();
  });

  it('is refused while registration is closed', async () => {
    const response = await api('POST', '/auth/counselor-signup/resend', {
      body: { email: 'anyone@school.test' },
    });

    expect(response.status).toBe(403);
  });
});

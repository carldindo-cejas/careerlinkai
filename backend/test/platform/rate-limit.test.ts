import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BASE_URL, api, createStaffUser, login } from '../helpers';

/**
 * The general per-user API budget (audit S2, plan P3-4).
 *
 * ## Why the limit is moved here rather than asserted at its production value
 *
 * `wrangler.test.toml` runs the suite at a ceiling no fixture can reach, because a per-*minute*
 * budget has no meaning inside a suite that serves a day's requests in three seconds (the reason
 * is written out in that file). So the limiter runs on every request the whole suite makes — the
 * DO round trip, the atomic charge, the 429 path — and this file is where it is given a number
 * small enough to cross.
 *
 * The var is set on `env` rather than through a second wrangler profile: `SELF.fetch` hands the
 * Worker this same object, so what the middleware reads is what the test wrote, and the production
 * config stays the one the other 65 files exercise.
 *
 * ## What is actually being pinned
 *
 * Not "a 429 happens" — that is one `if`. The four claims that would each be silently false if the
 * limiter were mounted the obvious way instead:
 *
 *   1. it applies to **every** authenticated router, not the one it was tested against;
 *   2. it is keyed per user, so one student cannot lock out their class;
 *   3. an unauthenticated request never charges it, so nobody can spend a budget they cannot
 *      authenticate into — and a locked-out user can still sign in;
 *   4. the 429 carries `Retry-After`, because a client that is not told when to come back comes
 *      back immediately.
 */

/** Small enough to cross deliberately, large enough that crossing it takes more than one request. */
const TEST_LIMIT = 3;

const productionLimit = env.API_RATE_LIMIT_PER_MINUTE;

beforeEach(() => {
  env.API_RATE_LIMIT_PER_MINUTE = String(TEST_LIMIT);
});

afterEach(() => {
  // Restored rather than left set: the pool shares this env with whatever runs next in the file,
  // and a leaked limit of 3 would fail the neighbouring test for a reason it has nothing to do with.
  env.API_RATE_LIMIT_PER_MINUTE = productionLimit;
});

/** A signed-in counselor whose budget is untouched — one per test, since the counter is per user. */
async function signedInCounselor(): Promise<string> {
  // `login` is unauthenticated and therefore uncharged, so a fixture never spends the budget it
  // is about to measure. That is the point of assertion 3 below, relied on here.
  return login(await createStaffUser({ role: 'counselor' }));
}

describe('the general per-user API rate limit (audit S2)', () => {
  it('admits requests up to the limit and refuses the one past it', async () => {
    const token = await signedInCounselor();

    for (let i = 0; i < TEST_LIMIT; i += 1) {
      const allowed = await api('GET', '/counselor/classes', { token });

      expect(allowed.status, `request ${i + 1} of ${TEST_LIMIT} should be admitted`).toBe(200);
    }

    const refused = await api('GET', '/counselor/classes', { token });

    expect(refused.status).toBe(429);
    expect(refused.body.message).toBe('Too many requests.');
    expect(refused.body.errors.request[0]).toMatch(/Try again in \d+ seconds/);
  });

  /**
   * **The claim the whole item rests on.** S2 is not "one endpoint is unthrottled", it is "every
   * endpoint except a dozen is". A limiter mounted on the router it was written against would pass
   * a test that only ever calls one prefix, and would leave `/notifications` — a poll, on every
   * screen, for every role — exactly as unguarded as it was before.
   */
  it('is charged on every authenticated router, not the one it was exercised against', async () => {
    const token = await signedInCounselor();

    // Spend the budget on three *different* prefixes: one router cannot be the one being counted.
    expect((await api('GET', '/counselor/classes', { token })).status).toBe(200);
    expect((await api('GET', '/notifications', { token })).status).toBe(200);
    expect((await api('GET', '/counselor/dashboard', { token })).status).toBe(200);

    // A fourth prefix, never touched, is refused — the counter is the user's, not a route's.
    const refused = await api('GET', '/admin/careers', { token });

    expect(refused.status).toBe(429);
  });

  it('keys the budget per user — one exhausted student cannot lock out their class', async () => {
    const exhausted = await signedInCounselor();
    const untouched = await signedInCounselor();

    for (let i = 0; i < TEST_LIMIT + 1; i += 1) {
      await api('GET', '/counselor/classes', { token: exhausted });
    }

    expect((await api('GET', '/counselor/classes', { token: exhausted })).status).toBe(429);
    expect((await api('GET', '/counselor/classes', { token: untouched })).status).toBe(200);
  });

  /**
   * A request that fails authentication is never charged.
   *
   * Two things turn on this and both matter: an attacker holding a forged or revoked token cannot
   * spend a real user's allowance (they do not resolve to a user, so there is no counter to
   * charge), and a request that was going to 401 anyway is not billed to whoever's id was guessed.
   */
  it('never charges an unauthenticated request', async () => {
    const token = await signedInCounselor();

    for (let i = 0; i < 10; i += 1) {
      const rejected = await api('GET', '/counselor/classes', { token: 'not-a-real-token' });

      expect(rejected.status).toBe(401);
    }

    // Ten rejected requests later the real token still has its whole budget.
    for (let i = 0; i < TEST_LIMIT; i += 1) {
      expect((await api('GET', '/counselor/classes', { token })).status).toBe(200);
    }
  });

  /**
   * A user who has spent their budget can still **sign in**.
   *
   * `/auth/login` is unauthenticated, so it is not on this counter at all — which is what keeps a
   * request limit from becoming an account lockout. The §38 login lockout is a separate counter on
   * a separate DO instance (`lib/auth-guard.ts`), and the prefixes exist precisely so the two
   * cannot reach each other.
   */
  it('does not lock a rate-limited user out of authenticating', async () => {
    const counselor = await createStaffUser({ role: 'counselor' });
    const token = await login(counselor);

    for (let i = 0; i < TEST_LIMIT + 1; i += 1) {
      await api('GET', '/counselor/classes', { token });
    }

    expect((await api('GET', '/counselor/classes', { token })).status).toBe(429);

    const response = await api('POST', '/auth/login', {
      body: { email: counselor.email, password: counselor.password },
    });

    expect(response.status).toBe(200);
  });

  /** The 429 tells the caller when to come back, or the caller comes back immediately. */
  it('answers 429 with a Retry-After header', async () => {
    const token = await signedInCounselor();

    for (let i = 0; i < TEST_LIMIT; i += 1) {
      await api('GET', '/counselor/classes', { token });
    }

    // Raw fetch rather than the `api` helper: the header is the assertion, and the helper
    // deliberately returns only status and body.
    const response = await SELF.fetch(`${BASE_URL}/counselor/classes`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });

    expect(response.status).toBe(429);

    const retryAfter = Number(response.headers.get('Retry-After'));

    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    // The window is fixed at 60s, so the advice can never exceed it.
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  /**
   * **One request costs one unit — the defect P3-4 found on its first run.**
   *
   * §10 gives each module its own routes file and several mount on the same prefix: six routers
   * share `/admin`, four share `/counselor`. Hono merges each sub-app's `use('*')` into the parent
   * as `/{prefix}/*`, so a path whose handler lives in the last-registered router runs the whole
   * middleware chain of every router in front of it — `authenticate()` included. Measured through
   * this counter (which charges exactly once per execution of that middleware), `/admin/dashboard`
   * ran it **6 times**, at two D1 reads each: twelve reads to answer "who is this", on the admin's
   * landing screen, against a 50-subrequest ceiling.
   *
   * Every response was correct throughout, which is why nothing else in the suite noticed. The
   * counter is the only instrument in the system that can see it, so the guard lives here — and it
   * is stated as a **budget claim**, not as an implementation detail: a request must cost one unit
   * of a user's allowance, or the number in wrangler.toml means six different things depending on
   * which screen the user opened.
   */
  it('charges exactly one unit per request, whichever prefix the handler lives behind', async () => {
    const token = await login(await createStaffUser({ role: 'admin' }));

    // One request per prefix depth: `/admin/careers` is served by the first router mounted on
    // /admin, `/admin/dashboard` by the sixth. Before the fix the first cost 1 and the second 6,
    // so a limit of 3 refused the *first* dashboard request an admin ever made.
    expect((await api('GET', '/admin/careers', { token })).status).toBe(200);
    expect((await api('GET', '/admin/counselors', { token })).status).toBe(200);
    expect((await api('GET', '/admin/dashboard', { token })).status).toBe(200);

    // Three requests, three units, budget spent exactly — the fourth is the first refusal.
    expect((await api('GET', '/admin/dashboard', { token })).status).toBe(429);
  });

  /**
   * The limit comes from the var on every request, not from a value captured at module load.
   *
   * Written because the tempting spelling — a module-level `const LIMIT = apiRateLimitPerMinute(env)`
   * — cannot be called at module scope in a Worker at all (there is no `env` outside a request), and
   * the workaround for that is a cached first-request read, which would make the var un-editable
   * without a redeploy and would make every test in this file depend on which one ran first.
   */
  it('reads the configured limit per request rather than caching it', async () => {
    const token = await signedInCounselor();

    env.API_RATE_LIMIT_PER_MINUTE = '1';

    expect((await api('GET', '/counselor/classes', { token })).status).toBe(200);
    expect((await api('GET', '/counselor/classes', { token })).status).toBe(429);
  });
});

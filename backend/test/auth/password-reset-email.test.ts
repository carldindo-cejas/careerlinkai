import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, createStaffUser, createStudentUser, login } from '../helpers';

/**
 * Delivery of the staff password-reset link (plan P4-2 — the delivery half of deviation D7).
 *
 * **Two independent things keep this file offline, and it needs both.** `wrangler.test.toml` sets no
 * `RESEND_API_KEY` and a platform gate asserts it never will, so `sendPasswordResetEmail` returns
 * `not_configured` before it reaches for the network — that is the backstop. On top of it, the
 * tests that *do* exercise a send set the key on `env` and replace `fetch`, so the only way to
 * reach api.resend.com would be for a stub to fail to install in exactly the tests that also set a
 * key. Belt and braces, because a suite that silently starts making live API calls is the failure
 * this project's test config exists to prevent (see that file's header on `[ai]`/`[[vectorize]]`).
 *
 * `@cloudflare/vitest-pool-workers` 0.18 exports no `fetchMock` from `cloudflare:test`, so the seam
 * is the global — checked, not assumed: `sends nothing when no API key is configured` fails loudly
 * if the stub ever stops intercepting, because the real endpoint would not answer with the shape
 * these assertions read.
 */

const NEW_PASSWORD = 'ResetPass123';
const GENERIC_ACK = 'If that email is registered, a password reset has been prepared for it.';

interface SentEmail {
  /** Asserted on, because a send that forgets the bearer token still *looks* correct locally. */
  authorization: string;
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

interface Behaviour {
  /** Non-2xx status to answer with. Omit for a successful send. */
  status?: number;
  /** Resend's error body. Its `message` is the sentence an operator actually needs. */
  body?: unknown;
  /** Make `fetch` itself throw — a timeout or DNS failure, not a refusal. */
  throws?: Error;
}

/**
 * Replace global `fetch` and capture what the service tried to send.
 *
 * Also sets the API key, because the two go together: without a key the service short-circuits and
 * never calls `fetch` at all, which is the backstop described in this file's header.
 */
function installResend(behaviour: Behaviour = {}): SentEmail[] {
  const sent: SentEmail[] = [];

  env.RESEND_API_KEY = 'test-key';

  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);

    // Anything that is not Resend is a bug in the test, not traffic to pass through — letting it
    // fall back to the real `fetch` is precisely how a suite starts making live calls by accident.
    if (url !== RESEND_ENDPOINT) {
      return Promise.reject(new Error(`unexpected outbound fetch to ${url}`));
    }

    if (behaviour.throws) {
      return Promise.reject(behaviour.throws);
    }

    // `BodyInit` also covers streams and blobs. The service sends a JSON string; narrowing rather
    // than coercing means a change to that would fail here instead of silently parsing
    // "[object Object]" into a payload with none of the fields these tests assert on.
    if (typeof init?.body !== 'string') {
      return Promise.reject(new Error('expected a JSON string body'));
    }

    const payload = JSON.parse(init.body) as {
      from: string;
      to: string[];
      subject: string;
      text: string;
      html: string;
    };

    sent.push({
      authorization: new Headers(init?.headers).get('Authorization') ?? '',
      to: payload.to.join(','),
      from: payload.from,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
    });

    if (behaviour.status !== undefined) {
      return Promise.resolve(
        Response.json(behaviour.body ?? { message: 'refused' }, { status: behaviour.status }),
      );
    }

    return Promise.resolve(Response.json({ id: `msg-${sent.length}` }));
  });

  return sent;
}

/**
 * The one message the fake captured. Indexing is guarded rather than asserted away because
 * `noUncheckedIndexedAccess` is on, and a bare `sent[0]!` would turn "nothing was sent" — the most
 * likely failure this file exists to catch — into a null-property crash instead of a clear count.
 */
function only(sent: SentEmail[]): SentEmail {
  expect(sent).toHaveLength(1);

  const [message] = sent;

  if (message === undefined) {
    throw new Error('unreachable: the length assertion above would have failed first');
  }

  return message;
}

/** The reset link the email actually carries, parsed the way a mail client would follow it. */
function linkFrom(email: SentEmail): URL {
  const match = /https?:\/\/\S+/.exec(email.text);

  if (match === null) {
    throw new Error('the plain-text body must contain the reset URL');
  }

  return new URL(match[0]);
}

afterEach(() => {
  // Both halves restored. The pool shares `env` with whatever runs next in this file, and a leaked
  // key would let a later test reach the network through a stub that is no longer installed.
  vi.unstubAllGlobals();
  env.RESEND_API_KEY = undefined;
});

describe('password reset email', () => {
  it('sends nothing, and still acknowledges, when no API key is configured', async () => {
    const counselor = await createStaffUser();

    // No installResend(): `env.RESEND_API_KEY` is undefined and `fetch` is the real one. If the
    // service ever stopped short-circuiting on the missing key, this test would attempt a live call
    // to api.resend.com with no credential — which is exactly why the check comes first.
    const response = await api('POST', '/auth/forgot-password', {
      body: { email: counselor.email },
    });

    expect(response.status).toBe(200);
    expect(response.body.message).toBe(GENERIC_ACK);
    // The token is still minted, because the admin-relay reset is what completes it.
    expect(typeof response.body.data.reset_token).toBe('string');
  });

  it('posts one message to Resend, authenticated, from EMAIL_FROM, to the staff address', async () => {
    const sent = installResend();
    const counselor = await createStaffUser();

    await api('POST', '/auth/forgot-password', { body: { email: counselor.email } });

    const message = only(sent);

    expect(message.authorization).toBe('Bearer test-key');
    expect(message.to).toBe(counselor.email.toLowerCase());
    // Resend takes the sender as a single `Name <addr>` string, not an object — asserted whole, so
    // a malformed header is caught here rather than by a 422 in production.
    expect(message.from).toBe(`CareerLinkAI <${env.EMAIL_FROM}>`);
    expect(message.subject).toBe('Reset your CareerLinkAI password');
    // Both parts, always: a message with no text/plain reads as blank in some clients and scores
    // worse with spam filters — for a password reset that means delivered and never seen.
    expect(message.text).not.toBe('');
    expect(message.html).not.toBe('');
  });

  it('emails a link that actually completes the reset', async () => {
    // The end-to-end claim, and the only one that catches a wrong route or a mangled query: take
    // the token *out of the email* — never out of the API response — and spend it.
    const sent = installResend();
    const counselor = await createStaffUser();

    await api('POST', '/auth/forgot-password', { body: { email: counselor.email } });

    const link = linkFrom(only(sent));

    expect(link.pathname).toBe('/reset-password');
    expect(link.searchParams.get('email')).toBe(counselor.email.toLowerCase());

    const response = await api('POST', '/auth/reset-password', {
      body: {
        email: link.searchParams.get('email'),
        token: link.searchParams.get('token'),
        password: NEW_PASSWORD,
        password_confirmation: NEW_PASSWORD,
      },
    });

    expect(response.status).toBe(200);

    // And the credential it set is real.
    await expect(login({ ...counselor, password: NEW_PASSWORD })).resolves.toEqual(
      expect.any(String),
    );
  });

  it('puts the same link in the HTML part as in the text part', async () => {
    const sent = installResend();
    const counselor = await createStaffUser();

    await api('POST', '/auth/forgot-password', { body: { email: counselor.email } });

    const message = only(sent);
    const link = linkFrom(message);

    // `&` is escaped to `&amp;` in the attribute — decode before comparing, or this passes for the
    // wrong reason and the HTML button silently drops the token parameter.
    expect(message.html.replace(/&amp;/g, '&')).toContain(link.toString());
  });

  it('answers identically when Resend refuses, and leaves the token usable', async () => {
    // The realistic refusal before DNS propagates: the domain is not verified yet. The request must
    // not fail, must not say anything different, and must leave the admin-relay path working.
    installResend({
      status: 403,
      body: { message: 'The careerlinkai.online domain is not verified.' },
    });
    const counselor = await createStaffUser();

    const response = await api('POST', '/auth/forgot-password', {
      body: { email: counselor.email },
    });

    expect(response.status).toBe(200);
    expect(response.body.message).toBe(GENERIC_ACK);

    const token = response.body.data.reset_token as string;

    expect(typeof token).toBe('string');

    const reset = await api('POST', '/auth/reset-password', {
      body: {
        email: counselor.email,
        token,
        password: NEW_PASSWORD,
        password_confirmation: NEW_PASSWORD,
      },
    });

    expect(reset.status).toBe(200);
  });

  it('survives Resend being unreachable', async () => {
    // A timeout or DNS failure throws out of `fetch` rather than returning a response. Letting that
    // escape as a 500 would fire only for *registered* addresses — an enumeration oracle built out
    // of an error handler, which is precisely what the generic acknowledgement exists to prevent.
    installResend({ throws: new Error('The operation was aborted due to timeout') });

    const counselor = await createStaffUser();

    const response = await api('POST', '/auth/forgot-password', {
      body: { email: counselor.email },
    });

    expect(response.status).toBe(200);
    expect(response.body.message).toBe(GENERIC_ACK);
  });

  it('sends nothing for an unknown email', async () => {
    const sent = installResend();

    const response = await api('POST', '/auth/forgot-password', {
      body: { email: 'nobody@school.test' },
    });

    expect(response.status).toBe(200);
    // Volume is a side channel too: one message for a real address and none for an unknown one is
    // only safe because the *requester* cannot observe it. Asserted so a future refactor that
    // "helpfully" sends an account-not-found notice has to delete this line to do it.
    expect(sent).toHaveLength(0);
  });

  it('sends nothing for a student — there is no staff password to reset', async () => {
    const sent = installResend();
    const student = await createStudentUser();

    await api('POST', '/auth/forgot-password', { body: { email: student.email } });

    expect(sent).toHaveLength(0);
  });
});

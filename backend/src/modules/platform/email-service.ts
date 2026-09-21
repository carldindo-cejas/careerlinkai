import type { Env } from '@/env';
import { describeError, pipelineLogger, type PipelineLogger } from '@/lib/logger';
import { resetPasswordUrl } from '@/modules/identity/reset-link';

/**
 * Transactional email (plan P4-2 — the delivery half of deviation D7).
 *
 * **What this is not.** It is not the email/SMS/push *notification* channel: FULLPLAN §63 defers
 * that behind an explicit trigger ("in-app-only notifications are confirmed insufficient by real
 * user feedback"), and that trigger has not fired. `NotificationService` is deliberately untouched.
 * The only mail this module sends is the one message whose absence is a named gap rather than a
 * deferred feature — a staff password reset link.
 *
 * **Why Resend and not Cloudflare's own Email Sending.** Cloudflare can send to arbitrary
 * recipients only on Workers Paid, and the Free plan is a ratified requirement here (FULLPLAN §45,
 * enforced by `scripts/platform-gates.mjs`). Its free path reaches *verified destination addresses*
 * only — one dashboard round-trip per staff mailbox — which does not amount to self-service reset.
 * Resend's free tier (3,000/month, 100/day, one verified domain) reaches any recipient and leaves
 * Cloudflare on the Free plan, since it is external to the platform entirely.
 *
 * The cost is that this is the **one credential in the system**. Every other service is reached
 * through a binding; `RESEND_API_KEY` is a secret, set with `wrangler secret put`, and a platform
 * gate fails the build if it is ever committed to a `[vars]` block.
 *
 * **Why every send is best-effort, and why that is not laziness.** `send` **never throws and never
 * rejects**. A caller that awaited it and let an exception escape would turn a bad key, a rate
 * limit, or an unverified domain into a 500 on `/auth/forgot-password` — and because that endpoint
 * answers identically for a registered and an unregistered email by design (§38's anti-enumeration
 * guarantee), a 500 that fired only for real accounts would be an enumeration oracle built out of
 * an error handler. That is the specific bug this signature exists to make unwritable.
 */

const PIPELINE = 'password_reset_email';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * A send is abandoned rather than left hanging. Workers cap wall-clock time per request, and a
 * password reset that sat on a stalled TCP connection would spend the caller's whole budget before
 * failing anyway — the reset itself has already been recorded by the time this runs.
 */
const SEND_TIMEOUT_MS = 5_000;

/**
 * The outcome of one attempted send. Returned for the *log*, never for the response body: no
 * caller may vary what it tells the client based on this value (see the enumeration note above).
 */
export type EmailOutcome =
  | { sent: true; messageId: string }
  /** No `RESEND_API_KEY` in this environment — local development and the whole test suite. */
  | { sent: false; reason: 'not_configured' }
  /** Resend answered non-2xx. `code` is the HTTP status; `detail` is its error message. */
  | { sent: false; reason: 'rejected'; code: string; detail: string }
  /** The request never completed — DNS, timeout, or the fetch itself threw. */
  | { sent: false; reason: 'unreachable'; detail: string };

export interface PasswordResetEmailInput {
  /** The staff member's address. */
  to: string;
  /** The single-use reset token, in plaintext. Never logged — see `send`. */
  token: string;
  /** For the log line, so an operator can correlate without the address being written down. */
  userId: string;
  /** Mirrors `RESET_TOKEN_TTL_MINUTES`, so the copy cannot drift from the check that enforces it. */
  expiresInMinutes: number;
}

/**
 * Resend answers a refusal with `{ "name": "...", "message": "..." }` and the reason in `message` —
 * "The careerlinkai.online domain is not verified", "You can only send testing emails to your own
 * address", and so on. **That sentence is the entire diagnostic value of the response**, and
 * discarding it in favour of the status code is the exact mistake P3-10 spent two runs on (a probe
 * that printed a bare status and threw away the body explaining it). Read defensively: a 5xx or a
 * proxy error may not be JSON at all.
 */
async function refusalDetail(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();

    if (typeof body === 'object' && body !== null && 'message' in body) {
      return String(body.message);
    }

    return JSON.stringify(body);
  } catch {
    return `non-JSON body (HTTP ${response.status})`;
  }
}

/**
 * Send the staff password-reset link.
 *
 * **Nothing here logs the token or the URL that carries it.** The reset link is a live credential
 * for the hour it is valid; writing it into Workers Logs would move a bearer secret into a store
 * with a different, longer-lived audience than the mailbox it was addressed to. The log line
 * carries the user id and the outcome, which is what an operator debugging "no email arrived"
 * actually needs.
 */
export async function sendPasswordResetEmail(
  env: Env,
  input: PasswordResetEmailInput,
): Promise<EmailOutcome> {
  const url = resetPasswordUrl(env.FRONTEND_URL, input.to, input.token);

  return deliver(env, pipelineLogger(PIPELINE, { user_id: input.userId }), {
    to: input.to,
    subject: 'Reset your CareerLinkAI password',
    text: plainTextBody(url, input.expiresInMinutes),
    html: htmlBody(url, input.expiresInMinutes),
  });
}

/** One message, already rendered. The senders above and below build these; `deliver` posts them. */
interface Message {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Post one message to Resend and classify the outcome.
 *
 * **Shares the never-throws contract of every sender in this module** (see the file header): a
 * caller that let an exception escape would turn a bad key or a rate limit into a 500 on an
 * endpoint whose whole design is to answer identically whether or not the address is registered.
 * Every failure path below returns an `EmailOutcome` instead.
 *
 * Nothing here logs the message body, and no caller may pass a credential in the subject: the
 * bodies carry reset links and signup codes, which are live credentials for as long as they are
 * valid, and Workers Logs has a different and longer-lived audience than the mailbox they were
 * addressed to.
 */
async function deliver(
  env: Env,
  logger: PipelineLogger,
  message: Message,
): Promise<EmailOutcome> {
  // **This check is load-bearing for the test suite, not only for local development.** It runs
  // before anything touches the network, and `wrangler.test.toml` sets no key — so the suite
  // cannot dial api.resend.com even if a test's stub fails to install. That is the same
  // hermeticity argument that keeps [ai] and [[vectorize]] out of the test config.
  //
  // Logged at info, not warn: with no key this is the *designed* state, and a warning on every
  // reset would train an operator to ignore the channel that also reports real refusals.
  if (env.RESEND_API_KEY === undefined || env.RESEND_API_KEY === '') {
    logger.info('skipped', { reason: 'not_configured' });

    return { sent: false, reason: 'not_configured' };
  }

  let response: Response;

  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `CareerLinkAI <${env.EMAIL_FROM}>`,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (error) {
    // A throw here is the transport failing, not Resend refusing — a timeout, DNS, a dropped
    // connection. Distinguished from `rejected` because the two want different operator actions:
    // this one is "the network or Resend is down", not "your configuration is wrong".
    logger.warn('unreachable', { detail: describeError(error) });

    return { sent: false, reason: 'unreachable', detail: describeError(error) };
  }

  if (!response.ok) {
    const detail = await refusalDetail(response);
    const code = String(response.status);

    // `warn`, not `error`: an unverified domain or a missing key is an operator task
    // (DEPLOYMENT.md §8.3), not a fault in this Worker. The request it belongs to succeeded — the
    // staff member falls back to asking an admin.
    logger.warn('rejected', { code, detail });

    return { sent: false, reason: 'rejected', code, detail };
  }

  // Resend returns `{ "id": "..." }`. Treated as optional rather than asserted: a successful send
  // whose body shape drifted is still a successful send, and throwing here would convert a
  // *delivered* email into the enumeration-oracle 500 this whole module is shaped to avoid.
  const body: unknown = await response.json().catch(() => null);
  const messageId =
    typeof body === 'object' && body !== null && 'id' in body ? String(body.id) : 'unknown';

  logger.info('sent', { message_id: messageId });

  return { sent: true, messageId };
}

const SIGNUP_PIPELINE = 'counselor_signup_email';

export interface SignupCodeEmailInput {
  /** The address that asked to register. There is no user id yet — that is the whole point. */
  to: string;
  /** The six-digit code, in plaintext. **Never logged**, same rule as the reset token. */
  code: string;
  /** Mirrors `SIGNUP_CODE_TTL_MINUTES`, so the copy cannot drift from the check that enforces it. */
  expiresInMinutes: number;
}

/**
 * The counselor-signup verification code (migration 0034).
 *
 * A code rather than a link, unlike the password reset, and the difference is worth stating: a
 * reset link authenticates somebody who already has an account, so it can safely carry a bearer
 * token in a URL. A signup code is typed back into a form the person already has open in front of
 * them — which means it survives an email client that mangles links, works when the mail is read on
 * a phone and the form is on a lab desktop, and cannot be turned into a one-click account by
 * anything that prefetches URLs.
 *
 * The log line carries no address and no code. `to` is omitted deliberately: unlike the reset
 * sender there is no user id to correlate on, and writing the raw address into Workers Logs would
 * make the log a list of everyone who tried to register.
 */
export async function sendCounselorSignupCodeEmail(
  env: Env,
  input: SignupCodeEmailInput,
): Promise<EmailOutcome> {
  const logger = pipelineLogger(SIGNUP_PIPELINE, { kind: 'code' });

  return deliver(env, logger, {
    to: input.to,
    subject: 'Your CareerLinkAI verification code',
    text: [
      'Verify your CareerLinkAI counselor account',
      '',
      'Someone asked to create a CareerLinkAI counselor account with this email address.',
      `Enter this code on the sign-up page within ${input.expiresInMinutes} minutes:`,
      '',
      input.code,
      '',
      'If you did not ask for this, you can ignore this email — no account will be created.',
    ].join('\n'),
    html: [
      '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#111">',
      '<h1 style="font-size:20px;margin:0 0 16px">Verify your CareerLinkAI account</h1>',
      '<p style="margin:0 0 16px">Someone asked to create a CareerLinkAI counselor account with this email address.</p>',
      `<p style="margin:0 0 8px">Enter this code on the sign-up page within ${input.expiresInMinutes} minutes:</p>`,
      `<p style="margin:0 0 24px;font-size:32px;font-weight:700;letter-spacing:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(input.code)}</p>`,
      '<p style="margin:0;font-size:13px;color:#555">If you did not ask for this, ignore this email — no account will be created.</p>',
      '</div>',
    ].join(''),
  });
}

/**
 * Sent instead of a code when the address **already has an account** (migration 0034).
 *
 * This message is what makes the anti-enumeration response honest rather than obstructive.
 * `/auth/counselor-signup` answers identically for a free address and a registered one — §38's
 * rule, held everywhere else in this module — which on its own would leave the real owner of the
 * address staring at a code-entry form waiting for a code that is never coming. So they get this
 * instead, and the dead end becomes a signpost.
 *
 * Note what it does **not** contain: no code, no link that creates anything, and nothing that
 * differs based on the account's status. Somebody who does not own this mailbox learns nothing,
 * because they never see it.
 */
export async function sendAccountExistsEmail(env: Env, to: string): Promise<EmailOutcome> {
  const logger = pipelineLogger(SIGNUP_PIPELINE, { kind: 'account_exists' });
  const signIn = `${env.FRONTEND_URL.replace(/\/+$/, '')}/login`;
  const forgot = `${env.FRONTEND_URL.replace(/\/+$/, '')}/forgot-password`;

  return deliver(env, logger, {
    to,
    subject: 'You already have a CareerLinkAI account',
    text: [
      'You already have a CareerLinkAI account',
      '',
      'Someone asked to create a CareerLinkAI account with this email address, but one already',
      'exists for it — so no new account was created and no verification code was issued.',
      '',
      `Sign in here: ${signIn}`,
      `Forgotten your password? ${forgot}`,
      '',
      'If this was not you, you can ignore this email — nothing about your account has changed.',
    ].join('\n'),
    html: [
      '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#111">',
      '<h1 style="font-size:20px;margin:0 0 16px">You already have an account</h1>',
      '<p style="margin:0 0 16px">Someone asked to create a CareerLinkAI account with this email address, but one already exists for it — so no new account was created.</p>',
      `<p style="margin:0 0 16px"><a href="${escapeHtml(signIn)}" style="background:#1d4ed8;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">Sign in</a></p>`,
      `<p style="margin:0 0 16px;font-size:13px;color:#555">Forgotten your password? <a href="${escapeHtml(forgot)}">Reset it here</a>.</p>`,
      '<p style="margin:0;font-size:13px;color:#555">If this was not you, ignore this email — nothing about your account has changed.</p>',
      '</div>',
    ].join(''),
  });
}

/**
 * Plain text is sent alongside the HTML on every message, not as an afterthought: some clients
 * render only `text/plain`, and a message with no text part scores worse with spam filters — which
 * for a password reset means the mail is delivered and never seen.
 */
function plainTextBody(url: string, expiresInMinutes: number): string {
  return [
    'Reset your CareerLinkAI password',
    '',
    'Someone asked to reset the password for this CareerLinkAI staff account.',
    `Open the link below within ${expiresInMinutes} minutes to choose a new password:`,
    '',
    url,
    '',
    'If you did not ask for this, you can ignore this email — your password will not change.',
  ].join('\n');
}

function htmlBody(url: string, expiresInMinutes: number): string {
  // Inline styles and a table-free layout: the recipients are staff on arbitrary mail clients,
  // and a <style> block is the first thing most of them strip.
  return [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#111">',
    '<h1 style="font-size:20px;margin:0 0 16px">Reset your CareerLinkAI password</h1>',
    '<p style="margin:0 0 16px">Someone asked to reset the password for this CareerLinkAI staff account.</p>',
    `<p style="margin:0 0 24px">Choose a new password within ${expiresInMinutes} minutes:</p>`,
    `<p style="margin:0 0 24px"><a href="${escapeHtml(url)}" style="background:#1d4ed8;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">Reset password</a></p>`,
    `<p style="margin:0 0 16px;font-size:13px;color:#555">Or paste this into your browser:<br><span style="word-break:break-all">${escapeHtml(url)}</span></p>`,
    '<p style="margin:0;font-size:13px;color:#555">If you did not ask for this, ignore this email — your password will not change.</p>',
    '</div>',
  ].join('');
}

/**
 * The URL carries an email address and a token, both of which reach this string through
 * `encodeURIComponent`. That escapes `&` and `<` already, so this is belt-and-braces for the
 * attribute context rather than the only defence — but a reset link is the last place to rely on
 * an upstream encoder staying where it is.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

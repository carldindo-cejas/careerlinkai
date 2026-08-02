/**
 * The password-reset URL, built server-side so it can be put in an email (plan P4-2).
 *
 * **This is the one piece of routing knowledge that exists on both sides of the wire**, and it had
 * to: the backend cannot import from the frontend package, and a link that 404s is a password reset
 * that silently cannot be completed. The authority is
 * `frontend/src/routes/paths.ts` — `paths.resetPassword` plus `resetPasswordPath(email, token)` —
 * and `test/identity/reset-link.test.ts` asserts the exact string this produces, so a change to the
 * route on either side fails a test here rather than arriving as a dead link in someone's inbox.
 *
 * If the frontend route ever moves, this function and that test move with it.
 */

const RESET_PATH = '/reset-password';

/**
 * `FRONTEND_URL` is written without a trailing slash in every scope of `wrangler.toml`, but a
 * trailing slash is exactly the sort of thing that gets added by hand when a new environment is
 * copied from an old one — and it would produce `https://host//reset-password`, which most routers
 * treat as a different path. Normalised here rather than trusted.
 */
export function resetPasswordUrl(frontendUrl: string, email: string, token: string): string {
  const origin = frontendUrl.replace(/\/+$/, '');
  const query = `email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`;

  return `${origin}${RESET_PATH}?${query}`;
}

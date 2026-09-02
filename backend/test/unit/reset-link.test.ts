import { describe, expect, it } from 'vitest';

import { resetPasswordUrl } from '@/modules/identity/reset-link';

/**
 * The password-reset URL (plan P4-2).
 *
 * **This file is the contract between two packages that cannot import each other.** The backend
 * builds the link that goes in the email; the frontend's `paths.resetPassword` and
 * `resetPasswordPath(email, token)` (frontend/src/routes/paths.ts) are what has to receive it. A
 * mismatch is not a type error and not a failing build — it is a link that opens a 404 for a
 * counselor who has already lost their password, discovered by a human at the worst moment.
 *
 * So the assertions below are deliberately on the **exact literal string**, not on its parts. If
 * the route moves, this fails loudly and names the file to change with it.
 */

const TOKEN = 'a'.repeat(64);

describe('resetPasswordUrl', () => {
  it('produces the exact path and query the frontend route parses', () => {
    expect(resetPasswordUrl('https://careerlinkai.online', 'counselor@school.test', TOKEN)).toBe(
      `https://careerlinkai.online/reset-password?email=counselor%40school.test&token=${TOKEN}`,
    );
  });

  it('percent-encodes an address whose local part contains query metacharacters', () => {
    // `+` is legal in an email local part and is the classic way a reader of the *unencoded* URL
    // would hand the parser a space instead. `&` would end the parameter outright.
    const url = resetPasswordUrl('https://careerlinkai.online', 'a+b&c@school.test', TOKEN);

    expect(url).toContain('email=a%2Bb%26c%40school.test');
    expect(url.split('?')[1]?.split('&')).toHaveLength(2);
  });

  it('does not double the slash when FRONTEND_URL carries a trailing one', () => {
    // Not hypothetical: FRONTEND_URL is hand-edited per environment in wrangler.toml, and
    // `https://host//reset-password` is a different path to most routers.
    expect(resetPasswordUrl('https://careerlinkai.online/', 'x@y.test', TOKEN)).toBe(
      resetPasswordUrl('https://careerlinkai.online', 'x@y.test', TOKEN),
    );
  });

  it('works against the local dev origin, port and all', () => {
    expect(resetPasswordUrl('http://localhost:5173', 'x@y.test', TOKEN)).toBe(
      `http://localhost:5173/reset-password?email=x%40y.test&token=${TOKEN}`,
    );
  });
});

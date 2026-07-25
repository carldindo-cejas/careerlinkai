/**
 * "Is this actually a Google Maps link?" — the validation behind `colleges.map_link` (migration
 * 0012, §17). Kept as a pure function with no Zod or database dependency so it is trivially testable
 * and can be shared by the create and update schemas alike.
 *
 * The rule is deliberately permissive about *shape* (a maps URL can be a `/maps/place/...`, a
 * `?q=...`, a `/maps/@lat,lng`, or an opaque short link) and strict about *origin*: it must be an
 * http(s) URL served by Google's own maps hosts. That is the property that matters — an admin
 * pasting a link to some other site, or a `javascript:` payload, is what this exists to reject.
 */

const SHORT_LINK_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl', 'g.co']);

export function isGoogleMapsUrl(value: string): boolean {
  let url: URL;

  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false;
  }

  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();

  // The official short-link hosts. `goo.gl`/`g.co` are also used for non-maps links, so those two
  // must carry a `/maps` path; `maps.app.goo.gl` is maps-only and needs no further check.
  if (host === 'maps.app.goo.gl') {
    return true;
  }
  if (host === 'goo.gl' || host === 'g.co') {
    return path.startsWith('/maps');
  }
  // Guard against a lookalike host slipping the short-link check above.
  if (SHORT_LINK_HOSTS.has(host)) {
    return false;
  }

  // A Google host: `google.com`, any regional `google.<tld>`, or a subdomain of one (`maps.`,
  // `www.`). `*.google.com` covers `maps.google.com` and `www.google.com`.
  const isGoogleHost =
    host === 'google.com' ||
    host.endsWith('.google.com') ||
    /^(?:[a-z0-9-]+\.)?google\.[a-z.]{2,}$/.test(host);

  if (!isGoogleHost) {
    return false;
  }

  // `maps.google.<tld>/...` is maps by host; otherwise the path has to say `/maps`.
  return host.startsWith('maps.') || path.startsWith('/maps');
}

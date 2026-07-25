/**
 * "Is this actually a Google Maps link?" — the client-side twin of the backend's
 * `lib/google-maps.ts`. The server is the authority (it re-validates on write); this exists only so
 * the admin finds out while pasting rather than on submit. Keep the two rules in lockstep.
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

  if (host === 'maps.app.goo.gl') {
    return true;
  }
  if (host === 'goo.gl' || host === 'g.co') {
    return path.startsWith('/maps');
  }
  if (SHORT_LINK_HOSTS.has(host)) {
    return false;
  }

  const isGoogleHost =
    host === 'google.com' ||
    host.endsWith('.google.com') ||
    /^(?:[a-z0-9-]+\.)?google\.[a-z.]{2,}$/.test(host);

  if (!isGoogleHost) {
    return false;
  }

  return host.startsWith('maps.') || path.startsWith('/maps');
}

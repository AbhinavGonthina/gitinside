/**
 * The landing page's visit ping: one image request to the owner's Cloudflare Worker, which
 * sends him a notification the first time a visitor appears and nothing for the next eight
 * hours. No script, package, cookie, or ID: just the four parameters below. The worker's
 * origin is allowed in the CSP's `img-src` (`VISIT_ORIGIN` in csp.ts), and the Privacy page
 * says visits are the one thing the site tracks.
 */
const PING = "https://visits.agonthina.workers.dev/";
const SITE = "g";

// Both are real public URLs for this site, so both count. Vercel gives every preview
// deployment its own hostname, and those must not fire, which is why this is an allowlist of
// exact hostnames rather than a check for localhost.
const HOSTS = ["gitinside.abhinavgonthina.dev", "gitinside.vercel.app"];

export function countVisit(): void {
  if (typeof window === "undefined") return;
  if (!HOSTS.includes(window.location.hostname)) return;
  // The landing page only: arriving at the site, not every route opened once in it.
  if (window.location.pathname !== "/") return;
  const legacyDnt = (window as Window & { doNotTrack?: string }).doNotTrack;
  if (navigator.doNotTrack === "1" || legacyDnt === "1") return;

  const send = () => {
    const q = new URLSearchParams({
      site: SITE,
      p: window.location.pathname,
      r: document.referrer,
      // Stops a proxy serving the same pixel out of cache instead of asking for it again.
      rnd: Math.random().toString(36).slice(2),
    });
    // An Image, not fetch: no CORS preflight, no promise to leave unhandled, and a failure
    // is silent, which is right for something nobody is waiting on.
    new Image().src = `${PING}?${q}`;
  };

  // On load rather than at import, so it is never in front of a font, a chunk, or the
  // first paint.
  if (document.readyState === "complete") send();
  else window.addEventListener("load", send, { once: true });
}

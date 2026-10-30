/**
 * Canonical query strings for the cached GET routes (graph, badge, diagram; M5 review).
 *
 * The CDN keys its cache on the whole URL, but the handlers ignore unknown query
 * parameters, so `?n=1`, `?n=2`, … would each miss the cache and cost a database lookup, a
 * bucket read, and (for images) check-on-view. Any other query is answered with a cheap,
 * cacheable `308` to the canonical URL before anything is looked up, so a loop of made-up
 * queries costs one redirect each and never reaches the database.
 *
 * Not handled: case variants of the owner and repo in the path (`/Acme/shop` vs.
 * `/acme/shop`) are distinct cache keys that each reach the database; they're bounded by the
 * name's length, not unbounded like a query.
 */

/** Cache headers of a redirect to the canonical URL (it never changes). */
export const CANONICAL_REDIRECT_CACHE_CONTROL = "public, max-age=86400, s-maxage=86400";

/**
 * A `308` to `requestUrl`'s path with `canonicalSearch` (`""` or `"?…"`), or `undefined`
 * when the request already uses it.
 */
export function redirectToCanonical(
  requestUrl: string,
  canonicalSearch: string,
): Response | undefined {
  const url = new URL(requestUrl);
  if (url.search === canonicalSearch && !requestUrl.endsWith("?")) return undefined;
  return new Response(null, {
    status: 308,
    headers: {
      location: `${url.pathname}${canonicalSearch}`,
      "cache-control": CANONICAL_REDIRECT_CACHE_CONTROL,
    },
  });
}

/** The diagram route's canonical query: `?theme=dark`, `?theme=light`, or none (auto). */
export function diagramSearch(requestUrl: string): string {
  const theme = new URL(requestUrl).searchParams.get("theme");
  return theme === "dark" || theme === "light" ? `?theme=${theme}` : "";
}

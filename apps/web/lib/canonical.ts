/**
 * Canonical query strings for the cached GET routes (graph, badge, diagram; M5 review).
 *
 * The CDN keys its cache on the whole URL, but the handlers ignore unknown query
 * parameters, so `?n=1`, `?n=2`, … would each miss the cache and cost a database lookup, a
 * bucket read, and (for images) check-on-view. Any other query is answered with a cheap,
 * cacheable `308` to the canonical URL before anything is looked up, so a loop of made-up
 * queries costs one redirect each and never reaches the database.
 *
 * Not handled here: case variants of the owner and repo in the path (`/Acme/shop` vs.
 * `/acme/shop`) are distinct cache keys that each reach the database; they're bounded by the
 * name's length, not unbounded like a query. None of them costs its own bucket read:
 * `/api/graph` redirects them to the stored spelling first, and the images read the graph
 * by that spelling (ADR-0097).
 */

/** The graph URL's query parameter naming the analyzer version of the graph it's for (ADR-0258). */
export const GRAPH_VERSION_PARAM = "v";

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

/**
 * The graph route's canonical query: `?v=<analyzerVersion>` when the request names this
 * analyzer's version (the pages' and images' URL for its graphs, ADR-0258), else none. Only the
 * one version, so made-up versions are redirected before any lookup like any other query.
 */
export function graphSearch(requestUrl: string, analyzerVersion: string): string {
  const version = new URL(requestUrl).searchParams.get(GRAPH_VERSION_PARAM);
  return version === analyzerVersion ? `?${GRAPH_VERSION_PARAM}=${analyzerVersion}` : "";
}

/** The diagram route's canonical query: `?theme=dark`, `?theme=light`, or none (auto). */
export function diagramSearch(requestUrl: string): string {
  const theme = new URL(requestUrl).searchParams.get("theme");
  return theme === "dark" || theme === "light" ? `?theme=${theme}` : "";
}

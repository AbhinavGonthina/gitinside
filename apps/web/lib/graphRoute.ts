import { findPublishedAnalysis, type AnyDatabase } from "@gitinside/db";
import { StorageError, type ObjectStore } from "@gitinside/worker/storage";
import { UNAVAILABLE_MESSAGE } from "./messages";
import { parseRepoPath } from "./repoUrl";
import { graphPath } from "./repoView";

/**
 * `GET /api/graph/:owner/:repo/:sha` (docs/DESIGN.md §11, ADR-0068): one commit's
 * `architecture.json`, which the diagram page fetches. Apart from Next.js so tests call it
 * with plain values.
 *
 * - **Public repos only** (`findPublishedAnalysis`); the newest finished analysis of the
 *   commit, so a re-analysis by a newer analyzer version replaces the old graph.
 * - **Streamed from the bucket** (Oracle Object Storage, ADR-0095) with the bucket's own credentials (no public bucket, ADR-0055).
 *   `fetch` decodes the stored gzip, so the route gzips it again ({@link acceptsGzip}).
 * - **Cached by the CDN** for a day (`s-maxage`) and by browsers for 5 minutes: a commit's
 *   graph only changes when a newer analyzer version re-analyzes it, and serving the older
 *   one for a while is harmless. Errors are `no-store`.
 * - **Gzipped so big graphs stay cacheable** (ADR-0097 amendment, M5.13a): Vercel's CDN
 *   doesn't cache a function response over 10 MB, and documenso's 13.4 MB of JSON was a
 *   `MISS` on every read (a bucket read each). Gzipped it's under 1 MB. A served body over
 *   {@link CDN_CACHEABLE_BYTES} is logged as `graph_uncacheable`, so its cost is counted.
 * - **One URL per graph** (ADR-0097): a path spelled differently from the stored repo
 *   (`/api/graph/ACME/shop/…` for `Acme/Shop`) is a `308` to the stored spelling, answered
 *   after the database lookup but before any bucket read, so case variants share one
 *   cache entry and one bucket read instead of one each.
 */

/** What the route reads: the analysis rows and the snapshot bucket. */
export interface GraphRouteDeps {
  db: AnyDatabase;
  store: Pick<ObjectStore, "get">;
}

/** Cache headers of a served graph. */
export const GRAPH_CACHE_CONTROL = "public, max-age=300, s-maxage=86400";
/**
 * Cache headers of the redirect to the stored spelling: an hour, not a day, since a repo
 * renamed in case only (`Shop` → `shop`) makes the old redirect point back at a path that
 * now redirects to it, until the cached one expires.
 */
export const SPELLING_REDIRECT_CACHE_CONTROL = "public, max-age=300, s-maxage=3600";

/**
 * The largest function response Vercel's CDN caches: 10 MB, or 20 MB "for streaming"
 * ([Vercel CDN Cache](https://vercel.com/docs/caching/cdn-cache#limits)). Ours is streamed,
 * yet 13.4 MB missed (M5.13), so the smaller limit is the one we can rely on.
 */
export const CDN_CACHEABLE_BYTES = 10_000_000;

/**
 * Whether a request's `Accept-Encoding` allows gzip (RFC 9110 §12.5.3): no header means any
 * coding is acceptable; otherwise `gzip` (or `x-gzip`) or `*` must be listed with a nonzero
 * `q`, an explicit `gzip` taking precedence over `*`. An empty header allows only identity.
 */
export function acceptsGzip(header: string | null): boolean {
  if (header === null) return true;
  let gzip: number | undefined;
  let any: number | undefined;
  for (const part of header.split(",")) {
    const [coding = "", ...params] = part.split(";").map((s) => s.trim().toLowerCase());
    const q = params.find((p) => p.startsWith("q="));
    const weight = q === undefined ? 1 : Number(q.slice(2));
    if (coding === "gzip" || coding === "x-gzip") gzip = weight;
    else if (coding === "*") any = weight;
  }
  return (gzip ?? any ?? 0) > 0;
}

/** Pass `body` through, logging its size once it ends if it's over {@link CDN_CACHEABLE_BYTES}. */
function measured(
  body: ReadableStream<Uint8Array>,
  encoding: "gzip" | "identity",
): ReadableStream<Uint8Array> {
  let bytes = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
      flush() {
        if (bytes > CDN_CACHEABLE_BYTES) {
          console.error(JSON.stringify({ event: "graph_uncacheable", bytes, encoding }));
        }
      },
    }),
  );
}

const SHA = /^[0-9a-f]{40}$/;
const NOT_FOUND = {
  error: "GRAPH_NOT_FOUND",
  message: "There's no diagram of that commit. Analyze the repo first.",
};

function json(status: number, body: { error: string; message: string }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Log one failure by name and code only (a message can carry connection details). */
function logFailure(event: string, error: unknown): void {
  const fields =
    error instanceof StorageError
      ? { status: error.status ?? null, s3Code: error.s3Code ?? null }
      : {};
  console.error(
    JSON.stringify({ event, error: error instanceof Error ? error.name : "unknown", ...fields }),
  );
}

/**
 * Answer one graph request. `deps` is `undefined` when the database or the bucket isn't
 * configured: every request is then "temporarily unavailable". `acceptEncoding` is the
 * request's `Accept-Encoding` (`null` without one).
 */
export async function handleGraphRequest(
  params: { owner: string; repo: string; sha: string },
  deps: GraphRouteDeps | undefined,
  acceptEncoding: string | null = null,
): Promise<Response> {
  const ref = parseRepoPath(params.owner, params.repo);
  if (ref === null || !SHA.test(params.sha)) return json(404, NOT_FOUND);
  if (deps === undefined) return json(503, { error: "UNAVAILABLE", message: UNAVAILABLE_MESSAGE });

  try {
    const published = await findPublishedAnalysis(deps.db, {
      owner: ref.owner,
      name: ref.repo,
      sha: params.sha,
    });
    if (published === undefined) return json(404, NOT_FOUND);
    const { owner, name } = published.repo;
    if (owner !== ref.owner || name !== ref.repo) {
      return new Response(null, {
        status: 308,
        headers: {
          location: graphPath(owner, name, params.sha),
          "cache-control": SPELLING_REDIRECT_CACHE_CONTROL,
        },
      });
    }
    const object = await deps.store.get(published.analysis.snapshotKey);
    if (object === undefined) {
      // A `done` row always had its object; retention (M5.12) or a manual delete removed it.
      console.error(JSON.stringify({ event: "graph_object_missing" }));
      return json(404, NOT_FOUND);
    }
    const gzip = acceptsGzip(acceptEncoding);
    const body = gzip ? object.body.pipeThrough(new CompressionStream("gzip")) : object.body;
    return new Response(measured(body, gzip ? "gzip" : "identity"), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": GRAPH_CACHE_CONTROL,
        // The CDN keys on Accept-Encoding already; this tells browsers and other caches.
        vary: "accept-encoding",
        ...(gzip ? { "content-encoding": "gzip" } : {}),
      },
    });
  } catch (error) {
    if (error instanceof StorageError) {
      logFailure("graph_read_failed", error);
      return json(503, { error: "UNAVAILABLE", message: UNAVAILABLE_MESSAGE });
    }
    logFailure("graph_failed", error);
    return json(500, {
      error: "INTERNAL",
      message: "Something went wrong on our side. Try again.",
    });
  }
}

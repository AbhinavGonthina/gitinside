import {
  findStoredAnalysis,
  servedPrivately,
  type AnyDatabase,
  type StoredAnalysis,
} from "@gitinside/db";
import { StorageError, type ObjectStore } from "@gitinside/worker/storage";
import { readSession, type AuthDeps } from "./authRoute";
import { CACHE_TAG_HEADER, repoCacheTag } from "./cdnCache";
import { UNAVAILABLE_MESSAGE } from "./messages";
import { checkRepoAccess } from "./repoAccess";
import { parseRepoPath } from "./repoUrl";
import { graphPath } from "./repoView";

/**
 * `GET /api/graph/:owner/:repo/:sha` (docs/DESIGN.md §11, ADR-0068): one commit's
 * `architecture.json`, which the diagram page fetches. Apart from Next.js so tests call it
 * with plain values.
 *
 * - **The newest finished analysis of the commit** (`findStoredAnalysis`), so a re-analysis
 *   by a newer analyzer version replaces the old graph.
 * - **A private repo only to a signed-in user GitHub shows it to** (M8.4b, ADR-0232): the
 *   session is read from the cookie and `checkRepoAccess` asked (cached 60 s, ADR-0231) before
 *   anything else, the spelling redirect included. Signed out, sign-in not configured, refused,
 *   or the session ended: the very same `404` as a commit nobody analyzed, with no bucket
 *   read, so a response never confirms that a private repo exists. A check that can't decide
 *   is `503`. Served graphs and redirects are `private, no-store` with `Vary: Cookie`: never in
 *   the CDN or a shared cache. So is a commit analyzed privately whose repo is public now
 *   (`servedPrivately`: its snapshot is under `private/`, M8.4d2, ADR-0239), unless a public
 *   analysis of it exists, which comes first.
 * - **Streamed from the bucket** (Oracle Object Storage, ADR-0095) with the bucket's own credentials (no public bucket, ADR-0055).
 *   `fetch` decodes the stored gzip, so the route gzips it again ({@link acceptsGzip}).
 * - **Cached by the CDN** for a day (`s-maxage`) and by browsers for 5 minutes: a commit's
 *   graph only changes when a newer analyzer version re-analyzes it, and serving the older
 *   one for a while is harmless. Errors are `no-store`. Each public answer is tagged with
 *   the repo's GitHub ID (`repo-<id>`, lib/cdnCache.ts), and the repo page purges that tag
 *   when it finds the repo gone private, so the CDN's day ends there (M8.4d1, ADR-0238), and
 *   again once a request that read it as public can't still be running
 *   ({@link GRAPH_MAX_DURATION_SECONDS}, F14).
 * - **Versioned URLs** (M9.1b2c, ADR-0258): the pages and images fetch a graph by this
 *   analyzer version as `?v=<version>`, a URL the CDN never cached an older version's graph
 *   under, so a version bump reaches them at once rather than a day later. The unversioned URL
 *   still serves the newest graph. A `?v=` the newest analysis isn't by is a `307` to the
 *   unversioned URL, never stored, so that URL can't cache an older graph either.
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
  /** Sign-in, for private repos; without it every private repo is a `404`. */
  auth?: AuthDeps;
}

/**
 * How long one graph request may run, in seconds (the route's `maxDuration`; F14, ADR-0238
 * amendment). A request that read the repo as public has ended this long after it started, its
 * answer in the CDN or not, so the hide's second purge (`PURGE_AGAIN_MS`, lib/repoView.ts) waits
 * it out. documenso's 13.4 MB graph is read and gzipped in about a second.
 */
export const GRAPH_MAX_DURATION_SECONDS = 15;

/** Cache headers of a served public graph. */
export const GRAPH_CACHE_CONTROL = "public, max-age=300, s-maxage=86400";
/** Cache headers of everything served for a private repo: a graph or a spelling redirect. */
export const PRIVATE_CACHE_CONTROL = "private, no-store";
/**
 * Cache headers of the redirect to the stored spelling: an hour, not a day, since a repo
 * renamed in case only (`Shop` → `shop`) makes the old redirect point back at a path that
 * now redirects to it, until the cached one expires.
 */
export const SPELLING_REDIRECT_CACHE_CONTROL = "public, max-age=300, s-maxage=3600";
/**
 * Cache headers of the redirect from a `?v=` the commit's newest analysis isn't by (M9.1b2c,
 * ADR-0258) to the unversioned URL: never stored, so once that version's analysis finishes,
 * the versioned URL serves it at once instead of a cached redirect (or older graph).
 */
export const VERSION_REDIRECT_CACHE_CONTROL = "no-store";

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
 * Whether the request's session may see the private repo `stored` names: `true`, or the
 * response to give instead (the missing graph's `404`, or `503` when the check can't decide).
 */
async function privateAccess(
  stored: StoredAnalysis,
  auth: AuthDeps | undefined,
  cookie: string | null,
): Promise<true | Response> {
  const user = await readSession(cookie, auth);
  if (user === undefined || auth === undefined) return json(404, NOT_FOUND);
  const access = await checkRepoAccess(user, stored.repo, auth);
  if ("error" in access) {
    return json(503, { error: "UNAVAILABLE", message: UNAVAILABLE_MESSAGE });
  }
  return "allowed" in access && access.allowed ? true : json(404, NOT_FOUND);
}

/**
 * Answer one graph request. `deps` is `undefined` when the database or the bucket isn't
 * configured: every request is then "temporarily unavailable". `acceptEncoding` is the
 * request's `Accept-Encoding` and `cookie` its `Cookie` (`null` without one). `params.version`
 * is the URL's `?v=` (lib/canonical.ts keeps only this analyzer's version), see
 * {@link VERSION_REDIRECT_CACHE_CONTROL}.
 */
export async function handleGraphRequest(
  params: { owner: string; repo: string; sha: string; version?: string },
  deps: GraphRouteDeps | undefined,
  acceptEncoding: string | null = null,
  cookie: string | null = null,
): Promise<Response> {
  const ref = parseRepoPath(params.owner, params.repo);
  if (ref === null || !SHA.test(params.sha)) return json(404, NOT_FOUND);
  if (deps === undefined) return json(503, { error: "UNAVAILABLE", message: UNAVAILABLE_MESSAGE });

  try {
    const stored = await findStoredAnalysis(deps.db, {
      owner: ref.owner,
      name: ref.repo,
      sha: params.sha,
    });
    if (stored === undefined) return json(404, NOT_FOUND);
    const isPrivate = servedPrivately(stored);
    if (isPrivate) {
      const shown = await privateAccess(stored, deps.auth, cookie);
      if (shown !== true) return shown;
    }
    const { owner, name } = stored.repo;
    const { version } = params;
    if (version !== undefined && version !== stored.analysis.analyzerVersion) {
      return new Response(null, {
        status: 307,
        headers: {
          location: graphPath(owner, name, params.sha),
          "cache-control": VERSION_REDIRECT_CACHE_CONTROL,
        },
      });
    }
    if (owner !== ref.owner || name !== ref.repo) {
      return new Response(null, {
        status: 308,
        headers: {
          location: graphPath(owner, name, params.sha, version),
          ...(isPrivate
            ? { "cache-control": PRIVATE_CACHE_CONTROL, vary: "cookie" }
            : {
                "cache-control": SPELLING_REDIRECT_CACHE_CONTROL,
                [CACHE_TAG_HEADER]: repoCacheTag(stored.repo.providerRepoId),
              }),
        },
      });
    }
    const object = await deps.store.get(stored.analysis.snapshotKey);
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
        // The CDN keys on Accept-Encoding already; this tells browsers and other caches.
        ...(isPrivate
          ? { "cache-control": PRIVATE_CACHE_CONTROL, vary: "accept-encoding, cookie" }
          : {
              "cache-control": GRAPH_CACHE_CONTROL,
              vary: "accept-encoding",
              [CACHE_TAG_HEADER]: repoCacheTag(stored.repo.providerRepoId),
            }),
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

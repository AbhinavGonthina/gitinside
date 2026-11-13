import { request } from "node:https";
import { Readable } from "node:stream";
import { acceptsGzip } from "./graphRoute";
import { findPrototypeRepo, upstreamGraphUrl } from "./prototype";

/**
 * `GET /api/prototype/graph/:owner/:repo` (M10.3a): one of the prototype's five graphs
 * (`PROTOTYPE_REPOS`), read from production's `/api/graph` and passed on still gzipped, so a
 * 14 MB graph crosses as its ~0.8 MB of gzip. Any other repo is a 404 before anything is fetched:
 * the host and the list are fixed, so the route can't be used to reach anything else.
 */

/** What the proxy gets back from production. */
export interface UpstreamGraph {
  status: number;
  /** `"gzip"` when the body is gzipped. */
  encoding: string | undefined;
  body: ReadableStream<Uint8Array>;
}

/** Reads a production graph URL, asking for gzip. */
export type UpstreamGet = (url: string) => Promise<UpstreamGraph>;

/** Browsers may keep a graph 5 minutes and the CDN a day: each repo's commit is fixed. */
export const PROTOTYPE_GRAPH_CACHE_CONTROL = "public, max-age=300, s-maxage=86400";

/** How long the proxy waits for production before giving up. */
export const UPSTREAM_TIMEOUT_MS = 10_000;

/** Production's answer over HTTPS, gzipped where it can be (Node's `fetch` would decompress it). */
export const httpsGet: UpstreamGet = (url) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      { headers: { "accept-encoding": "gzip" }, timeout: UPSTREAM_TIMEOUT_MS },
      (res) => {
        const encoding = res.headers["content-encoding"];
        resolve({
          status: res.statusCode ?? 502,
          encoding: typeof encoding === "string" ? encoding : undefined,
          body: Readable.toWeb(res) as ReadableStream<Uint8Array>,
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end();
  });

const json = (status: number, body: { error: string; message: string }) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * The route's answer: the graph (gzipped to a client that takes it, else decompressed), a 404 for
 * a repo the prototype doesn't draw, or a 502 when production doesn't serve the graph.
 */
export async function handlePrototypeGraph(
  params: { owner: string; repo: string },
  acceptEncoding: string | null,
  get: UpstreamGet = httpsGet,
): Promise<Response> {
  const repo = findPrototypeRepo(params.owner, params.repo);
  if (repo === undefined) {
    return json(404, { error: "NOT_FOUND", message: "The prototype doesn't draw this repo." });
  }
  let upstream: UpstreamGraph;
  try {
    upstream = await get(upstreamGraphUrl(repo));
  } catch {
    return json(502, {
      error: "UPSTREAM_FAILED",
      message: "Couldn't reach the site's stored graph. Try again.",
    });
  }
  if (upstream.status !== 200) {
    await upstream.body.cancel();
    return json(502, {
      error: "UPSTREAM_FAILED",
      message: `The site's stored graph answered ${upstream.status}. Try again later.`,
    });
  }
  const gzipped = upstream.encoding === "gzip";
  const passGzip = gzipped && acceptsGzip(acceptEncoding);
  const body =
    gzipped && !passGzip
      ? upstream.body.pipeThrough(new DecompressionStream("gzip"))
      : upstream.body;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": PROTOTYPE_GRAPH_CACHE_CONTROL,
      vary: "accept-encoding",
      "x-robots-tag": "noindex",
      ...(passGzip ? { "content-encoding": "gzip" } : {}),
    },
  });
}

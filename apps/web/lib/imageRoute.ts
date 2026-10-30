import { parseGraph, type ArchitectureGraph } from "@gitinside/schema";
import { badgeMessage, renderBadge, renderDiagram, type ImageTheme } from "@gitinside/viewer/image";
import { IMAGE_CSP } from "./csp";
import { parseRepoPath } from "./repoUrl";
import { viewRepo, type RepoViewDeps } from "./repoView";

/**
 * The README images (SPEC §3 F1, docs/DESIGN.md §11, ADR-0072), apart from Next.js so tests
 * call them with plain values:
 *
 * - `GET /api/badge/:owner/:repo.svg`: the badge, "GitInside | 3 services · 2 datastores".
 * - `GET /api/diagram/:owner/:repo.svg[?theme=dark|light]`: the live image, the repo's top
 *   level (`auto` by default: it follows the reader's system).
 *
 * Both go through {@link viewRepo} with no SHA, so a view is also check-on-view: a new
 * commit on the default branch is enqueued, charged to the repo. The image shows the
 * newest finished analysis meanwhile.
 *
 * - **Link-only badge** when there's no diagram to show: a repo never analyzed, one GitHub
 *   no longer shows publicly, a private one (never in our public rows), or a name GitHub
 *   wouldn't allow. All of them say the same words, so the image never confirms that a
 *   private repo exists (SECURITY.md T6). The README's link still opens the repo page.
 * - **Cached 10 minutes** by browsers, GitHub's image proxy, and the CDN
 *   ({@link IMAGE_CACHE_CONTROL}), so a busy README costs one lookup per 10 minutes. When
 *   something failed on our side the link-only badge is cached for a minute only.
 * - **The graph comes through the CDN** ({@link cdnGraphReader}, ADR-0097): the image asks
 *   our own `/api/graph` URL, cached a day, instead of the bucket, so the bucket is read
 *   about once per commit per day per CDN region however often the image is drawn (Oracle's
 *   free tier allows 50,000 requests a month, ADR-0096).
 * - **Always an image:** an `<img>` can't show an error page, so failures are logged by
 *   name and answered with the link-only badge, never a 5xx. Only a path that isn't one of
 *   our image URLs (no `.svg`) is a 404.
 * - **A CSP of its own** ({@link IMAGE_CSP}): opened directly, the SVG is a document on our
 *   origin, so it may not run scripts or load anything.
 */

/** What the image routes read: everything {@link viewRepo} needs, and the graphs. */
export interface ImageRouteDeps {
  view: RepoViewDeps;
  /** The answer of `GET <path>`, `path` being a view's `graphUrl` ({@link cdnGraphReader}). */
  graph: (path: string) => Promise<Response>;
}

/** How long an image waits for its graph before it gives up (the link-only badge). */
export const GRAPH_READ_TIMEOUT_MS = 10_000;

/**
 * Read graphs from `origin`'s `/api/graph` (ADR-0097), through the CDN that caches it a day.
 * `origin` is the image request's own: on Vercel a request only reaches this function
 * through one of the project's hosts, so this never asks another site.
 */
export function cdnGraphReader(
  origin: string,
  fetchImpl: typeof fetch = fetch,
): ImageRouteDeps["graph"] {
  const base = new URL(origin);
  return async (path) => {
    const url = new URL(path, base);
    // `graphUrl` is always a path; a `//host/…` one would leave our origin.
    if (url.origin !== base.origin) throw new TypeError("graph path leaves the origin");
    return fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(GRAPH_READ_TIMEOUT_MS),
    });
  };
}

/** Which image a route serves. */
export type ImageKind = "badge" | "diagram";

/** Cache headers of an image that answers the question: a diagram, or "nothing to show". */
export const IMAGE_CACHE_CONTROL = "public, max-age=600, s-maxage=600";
/** Cache headers of the link-only badge served because something failed on our side. */
export const FAILED_IMAGE_CACHE_CONTROL = "public, max-age=60, s-maxage=60";

/** The link-only badge's words (the same for every repo without a diagram). */
export const LINK_ONLY_MESSAGE = "view architecture";

const THEMES: readonly ImageTheme[] = ["auto", "dark", "light"];

function svg(body: string, cacheControl: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": cacheControl,
      "content-security-policy": IMAGE_CSP,
    },
  });
}

function linkOnly(cacheControl = IMAGE_CACHE_CONTROL): Response {
  return svg(renderBadge({ message: LINK_ONLY_MESSAGE, tone: "muted" }), cacheControl);
}

/** `?theme=`: `dark`, `light`, or `auto` for anything else (GitHub's `<picture>` asks for one). */
export function imageTheme(value: string | null | undefined): ImageTheme {
  return THEMES.find((t) => t === value) ?? "auto";
}

/**
 * The graph `view` settled on, from its `graphUrl` (the stored spelling, so every case
 * variant of an image shares one cache entry), schema-checked. `undefined`, logged by
 * status, when `/api/graph` doesn't answer with one.
 */
async function loadGraph(
  graphUrl: string,
  deps: ImageRouteDeps,
): Promise<ArchitectureGraph | undefined> {
  const response = await deps.graph(graphUrl);
  if (response.status !== 200) {
    await response.body?.cancel();
    console.error(JSON.stringify({ event: "image_graph_unavailable", status: response.status }));
    return undefined;
  }
  return parseGraph(JSON.parse(await response.text()));
}

/**
 * Answer one image request. `params.repo` is the path's last segment, `.svg` included.
 * `deps` is `undefined` when the database isn't configured (without the bucket,
 * `/api/graph` answers 503 and the image is the link-only badge for a minute).
 */
export async function handleImageRequest(
  kind: ImageKind,
  params: { owner: string; repo: string },
  options: { theme?: string | null | undefined },
  deps: ImageRouteDeps | undefined,
): Promise<Response> {
  if (!params.repo.endsWith(".svg")) {
    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const ref = parseRepoPath(params.owner, params.repo.slice(0, -".svg".length));
  if (ref === null) return linkOnly();
  if (deps === undefined) return linkOnly(FAILED_IMAGE_CACHE_CONTROL);

  try {
    const view = await viewRepo(ref, deps.view);
    if (view.status !== "ready") return linkOnly();
    const graph = await loadGraph(view.graphUrl, deps);
    if (graph === undefined) return linkOnly(FAILED_IMAGE_CACHE_CONTROL);
    const body =
      kind === "badge"
        ? renderBadge({ message: badgeMessage(graph) })
        : renderDiagram(graph, { theme: imageTheme(options.theme) });
    return svg(body, IMAGE_CACHE_CONTROL);
  } catch (error) {
    // By name only: a message can carry connection details.
    console.error(
      JSON.stringify({
        event: "image_failed",
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
    return linkOnly(FAILED_IMAGE_CACHE_CONTROL);
  }
}

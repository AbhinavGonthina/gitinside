import { findPublishedAnalysis } from "@gitinside/db";
import { parseGraph, type ArchitectureGraph } from "@gitinside/schema";
import { badgeMessage, renderBadge, renderDiagram, type ImageTheme } from "@gitinside/viewer/image";
import { StorageError, type ObjectStore } from "@gitinside/worker/storage";
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
 * - **Always an image:** an `<img>` can't show an error page, so failures are logged by
 *   name and answered with the link-only badge, never a 5xx. Only a path that isn't one of
 *   our image URLs (no `.svg`) is a 404.
 * - **A CSP of its own** ({@link IMAGE_CSP}): opened directly, the SVG is a document on our
 *   origin, so it may not run scripts or load anything.
 */

/** What the image routes read: everything {@link viewRepo} needs, and the snapshot bucket. */
export interface ImageRouteDeps {
  view: RepoViewDeps;
  store: Pick<ObjectStore, "get">;
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

/** Log one failure by name (and S3 status/code) only: a message can carry connection details. */
function logFailure(event: string, error: unknown): void {
  const fields =
    error instanceof StorageError
      ? { status: error.status ?? null, s3Code: error.s3Code ?? null }
      : {};
  console.error(
    JSON.stringify({ event, error: error instanceof Error ? error.name : "unknown", ...fields }),
  );
}

/** `?theme=`: `dark`, `light`, or `auto` for anything else (GitHub's `<picture>` asks for one). */
export function imageTheme(value: string | null | undefined): ImageTheme {
  return THEMES.find((t) => t === value) ?? "auto";
}

/** The newest finished analysis of the commit `view` settled on, read and schema-checked. */
async function loadGraph(
  ref: { owner: string; repo: string; sha: string },
  deps: ImageRouteDeps,
): Promise<ArchitectureGraph | undefined> {
  const published = await findPublishedAnalysis(deps.view.db, {
    owner: ref.owner,
    name: ref.repo,
    sha: ref.sha,
  });
  if (published === undefined) return undefined;
  const object = await deps.store.get(published.analysis.snapshotKey);
  if (object === undefined) {
    console.error(JSON.stringify({ event: "image_object_missing" }));
    return undefined;
  }
  return parseGraph(JSON.parse(await new Response(object.body).text()));
}

/**
 * Answer one image request. `params.repo` is the path's last segment, `.svg` included.
 * `deps` is `undefined` when the database or the bucket isn't configured.
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
    const graph = await loadGraph(view, deps);
    if (graph === undefined) return linkOnly(FAILED_IMAGE_CACHE_CONTROL);
    const body =
      kind === "badge"
        ? renderBadge({ message: badgeMessage(graph) })
        : renderDiagram(graph, { theme: imageTheme(options.theme) });
    return svg(body, IMAGE_CACHE_CONTROL);
  } catch (error) {
    logFailure(error instanceof StorageError ? "image_read_failed" : "image_failed", error);
    return linkOnly(FAILED_IMAGE_CACHE_CONTROL);
  }
}

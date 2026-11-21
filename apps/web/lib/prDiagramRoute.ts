import {
  findPullRequestDiffKey,
  findStoredAnalysis,
  servedPrivately,
  type StoredAnalysis,
} from "@gitinside/db";
import { parseGraph, parseGraphDiff, type ArchitectureGraph } from "@gitinside/schema";
import { renderDiffDiagram } from "@gitinside/viewer/image";
import { verifyPrDiagram } from "@gitinside/worker/hmac";
import { StorageError } from "@gitinside/worker/storage";
import { CACHE_TAG_HEADER, repoCacheTag } from "./cdnCache";
import { IMAGE_CSP } from "./csp";
import { SPELLING_REDIRECT_CACHE_CONTROL, type GraphRouteDeps } from "./graphRoute";
import { imageTheme, type ImageRouteDeps } from "./imageRoute";
import { parseRepoPath } from "./repoUrl";
import { graphPath } from "./repoView";

/**
 * `GET /api/pr-diagram/:owner/:repo/:base/:head.svg[?theme=dark|light][&token=…]` (M15.2b,
 * ADR-0321): the image above the pull request bot's comment, what the PR changes
 * (`renderDiffDiagram`, M15.2a), drawn from the diff the bot stored and both commits' graphs.
 * Apart from Next.js so tests call it with plain values.
 *
 * - **Only a diff the bot stored,** found as `/api/diff` finds it: both commits have a stored
 *   analysis of the repo, the diff is by the head's analyzer version, and some pull request
 *   record still names it (`findPullRequestDiffKey`). Anything else is the one `404`.
 * - **Public repos: one URL per diff, cached a year** (ADR-0295): a diff of two commits never
 *   changes, so the answer is `immutable` and the CDN draws it once (one diff read; the graphs
 *   come through `/api/graph`'s day-cached URLs, {@link PrDiagramDeps.graph}). It's tagged with
 *   the repo's ID, so the purge that ends a repo's public answers when it turns private
 *   (ADR-0238) ends these too. A spelling other than the stored one, or a `token` the image
 *   doesn't need, is a `308` to the stored URL before the bucket is read, so made-up tokens
 *   can't each cost a render.
 * - **Private repos: only with a signed, expiring `token`** (`verifyPrDiagram`, under a key
 *   derived from `ENQUEUE_HMAC_SECRET` for this purpose), since GitHub's image proxy fetches
 *   the image without the viewer's session. The worker signs it for the repo's GitHub ID and
 *   both commits (M15.2c). Missing, wrong, or expired: the same `404` as no diff, before the
 *   bucket is read, so a response never confirms that a private repo exists. Served
 *   `private, no-store`: each fetch reads the bucket (the diff and both graphs), bounded by
 *   who views private pull requests. As for `/api/graph`, a commit analyzed privately counts
 *   as private (`servedPrivately`).
 * - **Untrusted text** is escaped by the renderer, and the SVG gets the images' own CSP.
 * - **Failures** are `503` (storage) or `500`, `no-store`, logged by name only.
 */

/** What the route reads: the analysis rows, the bucket, the graphs' CDN URLs, the token keys. */
export interface PrDiagramDeps extends Pick<GraphRouteDeps, "db" | "store"> {
  /** A public graph by its `/api/graph` path (`cdnGraphReader`), as the README image reads it. */
  graph: ImageRouteDeps["graph"];
  /**
   * The keys a private repo's token may be signed with (`derivedSecret(…, PR_DIAGRAM_PURPOSE)`
   * of the current and previous `ENQUEUE_HMAC_SECRET`); none, and every private image is a 404.
   */
  tokenKeys: readonly string[];
  /** The clock, in milliseconds; tests pass a fixed one. */
  now?: () => number;
}

/** Cache headers of a public repo's image: a diff of two commits never changes. */
export const PR_DIAGRAM_CACHE_CONTROL = "public, max-age=31536000, s-maxage=31536000, immutable";
/** Cache headers of a private repo's image (and of every failure but the canonical redirect). */
export const PR_DIAGRAM_PRIVATE_CACHE_CONTROL = "private, no-store";

const SHA = /^[0-9a-f]{40}$/;

function plain(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

const notFound = () => plain(404, "Not found");
const unavailable = () => plain(503, "Temporarily unavailable");

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

/** The image's path for the stored spelling, with `search` (`""` or `"?…"`). */
export function prDiagramPath(
  owner: string,
  repo: string,
  base: string,
  head: string,
  search = "",
): string {
  return `/api/pr-diagram/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${base}/${head}.svg${search}`;
}

/** A graph read straight from the bucket (a private repo's), `undefined` when the object is gone. */
async function bucketGraph(
  stored: StoredAnalysis,
  deps: PrDiagramDeps,
): Promise<ArchitectureGraph | undefined> {
  const object = await deps.store.get(stored.analysis.snapshotKey);
  if (object === undefined) return undefined;
  return parseGraph(JSON.parse(await new Response(object.body).text()));
}

/** A public graph through its versioned, day-cached `/api/graph` URL; `undefined` if not 200. */
async function cdnGraph(
  stored: StoredAnalysis,
  deps: PrDiagramDeps,
): Promise<ArchitectureGraph | undefined> {
  const { owner, name } = stored.repo;
  const response = await deps.graph(
    graphPath(owner, name, stored.analysis.sha, stored.analysis.analyzerVersion),
  );
  if (response.status !== 200) {
    await response.body?.cancel();
    console.error(
      JSON.stringify({ event: "pr_diagram_graph_unavailable", status: response.status }),
    );
    return undefined;
  }
  return parseGraph(JSON.parse(await response.text()));
}

/**
 * Answer one PR image request. `params.head` carries `.svg`; `options` are the URL's `theme`
 * and `token` (`null` when absent; lib/canonical.ts's `prDiagramSearch` keeps only well-formed
 * ones). `deps` is `undefined` when the database or the bucket isn't configured.
 */
export async function handlePrDiagramRequest(
  params: { owner: string; repo: string; base: string; head: string },
  options: { theme?: string | null | undefined; token?: string | null | undefined },
  deps: PrDiagramDeps | undefined,
): Promise<Response> {
  if (!params.head.endsWith(".svg")) return notFound();
  const headSha = params.head.slice(0, -".svg".length);
  const baseSha = params.base;
  const ref = parseRepoPath(params.owner, params.repo);
  if (ref === null || !SHA.test(baseSha) || !SHA.test(headSha)) return notFound();
  if (deps === undefined) return unavailable();

  try {
    const head = await findStoredAnalysis(deps.db, {
      owner: ref.owner,
      name: ref.repo,
      sha: headSha,
    });
    if (head === undefined) return notFound();
    const base = await findStoredAnalysis(deps.db, {
      providerRepoId: head.repo.providerRepoId,
      sha: baseSha,
    });
    if (base === undefined) return notFound();
    const isPrivate = servedPrivately(head) || servedPrivately(base);
    const { owner, name, providerRepoId } = head.repo;
    const theme = imageTheme(options.theme);
    if (isPrivate) {
      const claims = { providerRepoId, baseSha, headSha };
      const now = deps.now?.() ?? Date.now();
      if (!verifyPrDiagram(deps.tokenKeys, claims, options.token, now)) return notFound();
    } else if ((options.token ?? null) !== null || owner !== ref.owner || name !== ref.repo) {
      const search = theme === "auto" ? "" : `?theme=${theme}`;
      return new Response(null, {
        status: 308,
        headers: {
          location: prDiagramPath(owner, name, baseSha, headSha, search),
          "cache-control": SPELLING_REDIRECT_CACHE_CONTROL,
          [CACHE_TAG_HEADER]: repoCacheTag(providerRepoId),
        },
      });
    }
    const key = await findPullRequestDiffKey(deps.db, {
      repoId: head.repo.id,
      baseSha,
      headSha,
      analyzerVersion: head.analysis.analyzerVersion,
    });
    if (key === undefined) return notFound();
    const object = await deps.store.get(key);
    if (object === undefined) {
      // Retention sweeps a diff only once no record names it; the record moved on meanwhile.
      console.error(JSON.stringify({ event: "pr_diagram_diff_missing" }));
      return notFound();
    }
    const diff = parseGraphDiff(JSON.parse(await new Response(object.body).text()));
    const read = isPrivate ? bucketGraph : cdnGraph;
    const [baseGraph, headGraph] = await Promise.all([read(base, deps), read(head, deps)]);
    if (baseGraph === undefined || headGraph === undefined) {
      console.error(JSON.stringify({ event: "pr_diagram_graph_missing" }));
      return unavailable();
    }
    return new Response(renderDiffDiagram(diff, baseGraph, headGraph, { theme }), {
      status: 200,
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "content-security-policy": IMAGE_CSP,
        ...(isPrivate
          ? { "cache-control": PR_DIAGRAM_PRIVATE_CACHE_CONTROL }
          : {
              "cache-control": PR_DIAGRAM_CACHE_CONTROL,
              [CACHE_TAG_HEADER]: repoCacheTag(providerRepoId),
            }),
      },
    });
  } catch (error) {
    if (error instanceof StorageError) {
      logFailure("pr_diagram_read_failed", error);
      return unavailable();
    }
    logFailure("pr_diagram_failed", error);
    return plain(500, "Something went wrong on our side.");
  }
}

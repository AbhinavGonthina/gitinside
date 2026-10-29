import { findPublishedAnalysis, type AnyDatabase } from "@gitinside/db";
import { StorageError, type ObjectStore } from "@gitinside/worker/storage";
import { UNAVAILABLE_MESSAGE } from "./messages";
import { parseRepoPath } from "./repoUrl";

/**
 * `GET /api/graph/:owner/:repo/:sha` (docs/DESIGN.md §11, ADR-0068): one commit's
 * `architecture.json`, which the diagram page fetches. Apart from Next.js so tests call it
 * with plain values.
 *
 * - **Public repos only** (`findPublishedAnalysis`); the newest finished analysis of the
 *   commit, so a re-analysis by a newer analyzer version replaces the old graph.
 * - **Streamed from R2** with the bucket's own credentials (no public bucket, ADR-0055).
 *   `fetch` decodes the stored gzip, and the platform compresses the response for the
 *   browser again.
 * - **Cached by the CDN** for a day (`s-maxage`) and by browsers for 5 minutes: a commit's
 *   graph only changes when a newer analyzer version re-analyzes it, and serving the older
 *   one for a while is harmless. Errors are `no-store`.
 */

/** What the route reads: the analysis rows and the snapshot bucket. */
export interface GraphRouteDeps {
  db: AnyDatabase;
  store: Pick<ObjectStore, "get">;
}

/** Cache headers of a served graph. */
export const GRAPH_CACHE_CONTROL = "public, max-age=300, s-maxage=86400";

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
 * configured: every request is then "temporarily unavailable".
 */
export async function handleGraphRequest(
  params: { owner: string; repo: string; sha: string },
  deps: GraphRouteDeps | undefined,
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
    const object = await deps.store.get(published.analysis.snapshotKey);
    if (object === undefined) {
      // A `done` row always had its object; retention (M5.12) or a manual delete removed it.
      console.error(JSON.stringify({ event: "graph_object_missing" }));
      return json(404, NOT_FOUND);
    }
    return new Response(object.body, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": GRAPH_CACHE_CONTROL,
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

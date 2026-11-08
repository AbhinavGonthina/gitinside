import {
  findPullRequestDiffKey,
  findStoredAnalysis,
  servedPrivately,
  type StoredAnalysis,
} from "@gitinside/db";
import { StorageError } from "@gitinside/worker/storage";
import { readSession, type AuthDeps } from "./authRoute";
import { acceptsGzip, PRIVATE_CACHE_CONTROL, type GraphRouteDeps } from "./graphRoute";
import { UNAVAILABLE_MESSAGE } from "./messages";
import { checkRepoAccess } from "./repoAccess";
import { parseRepoPath } from "./repoUrl";

/**
 * `GET /api/diff/:owner/:repo/:base/:head` (M8.6f1, ADR-0245): the diff the pull request bot
 * stored for a comment's link (`/<owner>/<repo>/<head>?base=<merge base>`), so the diagram's
 * diff mode can show what the worker found with both trees' text (moved and edited files,
 * `renameLimit`, ADR-0086) instead of diffing the two graphs in the browser without it. Apart
 * from Next.js so tests call it with plain values.
 *
 * - **Only a diff of two commits the page can show:** both have a stored analysis of the repo
 *   (`findStoredAnalysis`, head by name, base by the head's GitHub ID), and the diff is by the
 *   head's analyzer version, the graph the page draws; some pull request record of the repo
 *   must still name it (`findPullRequestDiffKey`). Anything else is the one `404`.
 * - **Behind the graphs' own check:** when either commit's graph is served only after the
 *   access check (`servedPrivately`: a private repo, or an analysis stored under `private/`),
 *   the session is read and `checkRepoAccess` asked before the record or the bucket; a refusal
 *   in any form is the same `404` as a diff nobody stored, and an undecided check `503`. A
 *   public repo's diff is shown to anyone: both trees are public, as are its graphs.
 * - **Never cached** (`private, no-store`, `Vary: Cookie`), public repos' too: the object is
 *   under the installation's `private/` prefix, which an uninstall deletes at once (ADR-0240),
 *   and a CDN copy would outlive that. One link per pull request is read rarely.
 * - **Streamed from the bucket**, gzipped again when the client takes it, as `/api/graph` does
 *   (`fetch` decodes the stored gzip). No spelling redirect: the page builds the URL from the
 *   stored spelling, and an uncached answer has no cache entries to share.
 */

const SHA = /^[0-9a-f]{40}$/;
const NOT_FOUND = {
  error: "DIFF_NOT_FOUND",
  message: "There's no stored comparison of those commits.",
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
 * response to give instead (the missing diff's `404`, or `503` when the check can't decide).
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
 * Answer one stored-diff request. `deps` (the graph route's) is `undefined` when the database
 * or the bucket isn't configured: every request is then "temporarily unavailable".
 * `acceptEncoding` is the request's `Accept-Encoding` and `cookie` its `Cookie` (`null` without
 * one).
 */
export async function handleDiffRequest(
  params: { owner: string; repo: string; base: string; head: string },
  deps: GraphRouteDeps | undefined,
  acceptEncoding: string | null = null,
  cookie: string | null = null,
): Promise<Response> {
  const ref = parseRepoPath(params.owner, params.repo);
  if (ref === null || !SHA.test(params.base) || !SHA.test(params.head)) {
    return json(404, NOT_FOUND);
  }
  if (deps === undefined) return json(503, { error: "UNAVAILABLE", message: UNAVAILABLE_MESSAGE });

  try {
    const head = await findStoredAnalysis(deps.db, {
      owner: ref.owner,
      name: ref.repo,
      sha: params.head,
    });
    if (head === undefined) return json(404, NOT_FOUND);
    const base = await findStoredAnalysis(deps.db, {
      providerRepoId: head.repo.providerRepoId,
      sha: params.base,
    });
    if (base === undefined) return json(404, NOT_FOUND);
    if (servedPrivately(head) || servedPrivately(base)) {
      const shown = await privateAccess(head, deps.auth, cookie);
      if (shown !== true) return shown;
    }
    const key = await findPullRequestDiffKey(deps.db, {
      repoId: head.repo.id,
      baseSha: params.base,
      headSha: params.head,
      analyzerVersion: head.analysis.analyzerVersion,
    });
    if (key === undefined) return json(404, NOT_FOUND);
    const object = await deps.store.get(key);
    if (object === undefined) {
      // Retention sweeps a diff only once no record names it; the record moved on meanwhile.
      console.error(JSON.stringify({ event: "diff_object_missing" }));
      return json(404, NOT_FOUND);
    }
    const gzip = acceptsGzip(acceptEncoding);
    const body = gzip ? object.body.pipeThrough(new CompressionStream("gzip")) : object.body;
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": PRIVATE_CACHE_CONTROL,
        vary: "accept-encoding, cookie",
        ...(gzip ? { "content-encoding": "gzip" } : {}),
      },
    });
  } catch (error) {
    if (error instanceof StorageError) {
      logFailure("diff_read_failed", error);
      return json(503, { error: "UNAVAILABLE", message: UNAVAILABLE_MESSAGE });
    }
    logFailure("diff_failed", error);
    return json(500, {
      error: "INTERNAL",
      message: "Something went wrong on our side. Try again.",
    });
  }
}

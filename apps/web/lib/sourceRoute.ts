import { findStoredAnalysis, servedPrivately } from "@gitinside/db";
import { readSession, userAccessToken, type AuthDeps } from "./authRoute";
import { apiHeaders, githubUrl } from "./githubOAuth";
import { UNAVAILABLE_MESSAGE } from "./messages";
import { checkRepoAccess } from "./repoAccess";
import { parseRepoPath } from "./repoUrl";

/**
 * `GET /api/source/:owner/:repo/:sha/*path` (M8.4c3, ADR-0237): one file of a private repo at
 * an analyzed commit, for the diagram's code preview. A public repo's files come straight from
 * `raw.githubusercontent.com` in the viewer's browser (ADR-0115); a private one's can't, since
 * that host takes no credentials we'd hand a browser. So the page reads them here, and this
 * route reads GitHub with the viewer's own token. Apart from Next.js so tests call it with plain
 * values.
 *
 * - **Private repos only:** the commit must have a stored analysis of a private repo (or one
 *   analyzed privately before the repo turned public, which its page shows as private too,
 *   M8.4d2). A public
 *   repo, an unknown name, or a commit never analyzed is the same `404`, so this is never a
 *   free proxy for public files and never confirms that a private repo exists.
 * - **The same check as the graph** (ADR-0232): the session from the cookie, then
 *   `checkRepoAccess` (60 s cache). Signed out, sign-in not configured, refused, or the session
 *   ended ⇒ that `404`, GitHub never asked for the file; a check that can't decide ⇒ `503`.
 * - **Read by GitHub's repo ID** (`GET /repositories/{id}/contents/{path}?ref=<sha>`, raw), as
 *   the check asks, so a rename can't point the read at another repo. The token is the user's,
 *   so GitHub's own permissions apply a second time and the read counts against their quota.
 * - **Capped like the browser's loader:** a file over {@link MAX_FILE_BYTES} (by
 *   `content-length`, and while it streams) is `413`; nothing larger is in a graph (ADR-0020).
 * - **Never cached or shared:** `private, no-store`, `Vary: Cookie`. Served as `text/plain` with
 *   `nosniff` and a sandboxing CSP, so a file opened directly can't run as a page of this site.
 *
 * Not handled: directories (GitHub answers a listing; graphs only point at files), and files
 * GitHub stores in Git LFS (the pointer is shown).
 */

/** The analyzer skips files over 2 MB (ADR-0020), and the viewer's loader caps at the same. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** How long the read from GitHub may take. */
const TIMEOUT_MS = 10_000;

/** Headers of every answer: nothing here may be cached or shared between viewers. */
const PRIVATE_HEADERS = {
  "cache-control": "private, no-store",
  vary: "cookie",
  "x-content-type-options": "nosniff",
};

const SHA = /^[0-9a-f]{40}$/;
const NOT_FOUND = {
  error: "SOURCE_NOT_FOUND",
  message: "There's no such file in an analysis you can see.",
};

function json(status: number, body: { error: string; message: string }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...PRIVATE_HEADERS },
  });
}

const notFound = () => json(404, NOT_FOUND);
const unavailable = () => json(503, { error: "UNAVAILABLE", message: UNAVAILABLE_MESSAGE });
const tooLarge = () =>
  json(413, { error: "SOURCE_TOO_LARGE", message: "That file is too large to preview." });

/** Log a failure by name only: a message can carry a URL or connection details. */
function log(event: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ event, ...fields }));
}

/** Whether every segment of `path` names a file inside the repo (no `.`, `..`, empty, or `/`). */
function filePath(path: readonly string[]): boolean {
  return (
    path.length > 0 && path.every((s) => s !== "" && s !== "." && s !== ".." && !s.includes("/"))
  );
}

/** A response body's bytes, or `undefined` once more than `maxBytes` arrive (then cancelled). */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | undefined> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Answer one file request. `path` is the file's segments as the router decoded them; `auth` is
 * `undefined` when sign-in isn't configured (every request is then a `404`: nothing private can
 * be shown); `cookie` is the request's `Cookie` (`null` without one).
 */
export async function handleSourceRequest(
  params: { owner: string; repo: string; sha: string; path: readonly string[] },
  auth: AuthDeps | undefined,
  cookie: string | null,
  maxBytes = MAX_FILE_BYTES,
): Promise<Response> {
  const ref = parseRepoPath(params.owner, params.repo);
  if (ref === null || !SHA.test(params.sha) || !filePath(params.path) || auth === undefined) {
    return notFound();
  }
  try {
    const stored = await findStoredAnalysis(auth.db, {
      owner: ref.owner,
      name: ref.repo,
      sha: params.sha,
    });
    if (stored === undefined || !servedPrivately(stored)) return notFound();
    const user = await readSession(cookie, auth);
    if (user === undefined) return notFound();
    const access = await checkRepoAccess(user, stored.repo, auth);
    if ("error" in access) return unavailable();
    if (!("allowed" in access && access.allowed)) return notFound();
    const token = await userAccessToken(user, auth);
    if ("error" in token) return unavailable();
    if (!("token" in token)) return notFound();

    const path = params.path.map(encodeURIComponent).join("/");
    const url = githubUrl(
      auth.client,
      "api",
      `/repositories/${stored.repo.providerRepoId}/contents/${path}?ref=${params.sha}`,
    );
    const response = await (auth.client.fetch ?? fetch)(url, {
      headers: { ...apiHeaders(token.token), accept: "application/vnd.github.raw+json" },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => undefined);
      // Not at that commit, or GitHub refuses the token this very moment: nothing to show.
      if ([401, 403, 404].includes(response.status) && !response.headers.has("retry-after")) {
        return notFound();
      }
      log("source_read_failed", { status: response.status });
      return unavailable();
    }
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > maxBytes) {
      void response.body?.cancel().catch(() => undefined);
      return tooLarge();
    }
    const bytes = await readCapped(response, maxBytes);
    if (bytes === undefined) return tooLarge();
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-security-policy": "default-src 'none'; sandbox",
        ...PRIVATE_HEADERS,
      },
    });
  } catch (error) {
    log("source_failed", { error: error instanceof Error ? error.name : "unknown" });
    return unavailable();
  }
}

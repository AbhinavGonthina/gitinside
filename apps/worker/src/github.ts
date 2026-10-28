import { JobFailure } from "./failure.js";

/**
 * Opens a commit's tarball from GitHub (docs/DESIGN.md §5 step 1; SECURITY.md T4; ADR-0061).
 *
 * `GET {api}/repos/{owner}/{repo}/tarball/{sha}` answers with a redirect to a short-lived
 * `codeload.github.com` URL. Redirects are followed by hand, so each hop is checked:
 * - **Within the API** (a renamed repo's `301` to `/repositories/<id>/…`): followed with
 *   the token, at most {@link MAX_REDIRECTS} hops.
 * - **To a download origin** (`https://codeload.github.com` by default): followed
 *   **without** the token. The URL already carries its own grant, and the token must never
 *   leave GitHub's API host.
 * - **Anywhere else:** refused (`DOWNLOAD_FAILED`), never fetched.
 *
 * Failures (codes in failure.ts):
 * - `REPO_NOT_FOUND`: 404 (a missing repo or commit, or a private one we can't read).
 * - `REPO_UNAVAILABLE`: 451 (blocked for legal reasons).
 * - `GITHUB_RATE_LIMITED`: 403/429 with `x-ratelimit-remaining: 0` or `retry-after`.
 * - `DOWNLOAD_FAILED` (retried): a network error, 408, or 5xx.
 * - `DOWNLOAD_REFUSED` (permanent): any other status, or a redirect that is refused, has
 *   no location, or loops.
 * - When the signal fires, its reason is rethrown; the caller turns it into `CANCELLED` or
 *   `DOWNLOAD_TIMEOUT`.
 *
 * The returned body is the raw gzip stream; extract.ts limits what comes out of it.
 */

/** Where a tarball comes from. Names are checked by the enqueue API before a job exists. */
export interface TarballSource {
  owner: string;
  repo: string;
  /** 40 lowercase hex. */
  sha: string;
}

/** Options for {@link openTarball}. */
export interface DownloadOptions {
  /** GitHub's REST API. Default `https://api.github.com`. */
  apiBase?: string;
  /** Origins a redirect may send the download to. Default `https://codeload.github.com`. */
  downloadOrigins?: readonly string[];
  /** Sent to the API only (raises the public rate limit; M8 uses installation tokens). */
  token?: string;
  /** Aborts the request and the body. */
  signal?: AbortSignal;
  /** The fetch to use (tests). Default the global `fetch`. */
  fetch?: typeof fetch;
}

/** API redirects followed before giving up (a rename is one). */
export const MAX_REDIRECTS = 3;
const USER_AGENT = "gitinside-worker";
const REDIRECT = new Set([301, 302, 303, 307, 308]);

function failure(code: string, detail: string, cause?: unknown): JobFailure {
  return new JobFailure(code, detail, cause === undefined ? undefined : { cause });
}

/** Map a final non-200 response to its failure. */
export function failureForStatus(status: number, headers: Headers): JobFailure {
  if (status === 404) return failure("REPO_NOT_FOUND", "GitHub answered 404");
  if (status === 451) return failure("REPO_UNAVAILABLE", "GitHub answered 451");
  if (
    (status === 403 || status === 429) &&
    (headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after"))
  ) {
    return failure("GITHUB_RATE_LIMITED", `GitHub answered ${status} (rate limit)`);
  }
  if (status === 408 || status >= 500) {
    return failure("DOWNLOAD_FAILED", `GitHub answered ${status}`);
  }
  return failure("DOWNLOAD_REFUSED", `GitHub answered ${status}`);
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/**
 * Request the tarball of `source` and return its body once a `200` arrives. Throws
 * {@link JobFailure} for every failure, and rethrows the signal's reason if it fires.
 */
export async function openTarball(
  source: TarballSource,
  options: DownloadOptions = {},
): Promise<ReadableStream<Uint8Array>> {
  const doFetch = options.fetch ?? fetch;
  const api = new URL(options.apiBase ?? "https://api.github.com");
  const downloadOrigins = new Set(options.downloadOrigins ?? ["https://codeload.github.com"]);
  const path = ["repos", source.owner, source.repo, "tarball", source.sha]
    .map(encodeURIComponent)
    .join("/");
  let url = new URL(`${api.pathname.replace(/\/$/, "")}/${path}`, api);

  for (let hop = 0; ; hop++) {
    const toApi = url.origin === api.origin;
    const headers: Record<string, string> = { "user-agent": USER_AGENT };
    if (toApi) {
      headers.accept = "application/vnd.github+json";
      headers["x-github-api-version"] = "2022-11-28";
      if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    }
    let response: Response;
    try {
      response = await doFetch(url, {
        headers,
        redirect: "manual",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      throw failure("DOWNLOAD_FAILED", `request to ${url.host} failed`, error);
    }

    if (response.status === 200) {
      if (response.body === null) throw failure("DOWNLOAD_FAILED", "empty response body");
      return response.body;
    }
    if (!REDIRECT.has(response.status)) {
      await discard(response);
      throw failureForStatus(response.status, response.headers);
    }
    await discard(response);
    const location = response.headers.get("location");
    if (location === null) throw failure("DOWNLOAD_REFUSED", "redirect without a location");
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw failure("DOWNLOAD_REFUSED", "redirect without a valid location");
    }
    if (next.origin === api.origin) {
      if (!toApi || hop >= MAX_REDIRECTS) {
        throw failure("DOWNLOAD_REFUSED", "too many redirects");
      }
    } else if (!downloadOrigins.has(next.origin) || !toApi) {
      throw failure("DOWNLOAD_REFUSED", `redirect to ${next.origin} refused`);
    }
    url = next;
  }
}

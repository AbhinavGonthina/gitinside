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

function apiHeaders(token: string | undefined): Record<string, string> {
  return {
    "user-agent": USER_AGENT,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  };
}

/** What the worker records about a repo (`repos` row; ADR-0063). */
export interface RepoFacts {
  /** GitHub's numeric ID, which survives renames. */
  id: number;
  /** GitHub's current spelling, which may differ from the request's (a rename, a case change). */
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
}

/** A repo description is ~6 KB; anything far larger isn't one. */
const MAX_REPO_JSON_BYTES = 1024 * 1024;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the fields we keep from `GET /repos/{owner}/{repo}`, or `undefined` if they're malformed. */
function parseRepoFacts(value: unknown): RepoFacts | undefined {
  if (!isRecord(value) || !isRecord(value.owner)) return undefined;
  const { id, name, default_branch: defaultBranch } = value;
  const { login } = value.owner;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return undefined;
  if (typeof login !== "string" || !OWNER.test(login)) return undefined;
  if (typeof name !== "string" || !REPO.test(name)) return undefined;
  if (typeof value.private !== "boolean") return undefined;
  if (typeof defaultBranch !== "string" || defaultBranch === "" || defaultBranch.length > 255) {
    return undefined;
  }
  return { id, owner: login, name, private: value.private, defaultBranch };
}

/**
 * Ask GitHub's API about a repo: `GET {api}/repos/{owner}/{repo}`, following a renamed
 * repo's redirect inside the API only (with the token, at most {@link MAX_REDIRECTS} hops).
 * Statuses map to failures as for {@link openTarball}; a malformed answer is
 * `DOWNLOAD_REFUSED`. Rethrows the signal's reason if it fires.
 */
export async function fetchRepoFacts(
  source: Omit<TarballSource, "sha">,
  options: DownloadOptions = {},
): Promise<RepoFacts> {
  const doFetch = options.fetch ?? fetch;
  const api = new URL(options.apiBase ?? "https://api.github.com");
  const path = ["repos", source.owner, source.repo].map(encodeURIComponent).join("/");
  let url = new URL(`${api.pathname.replace(/\/$/, "")}/${path}`, api);

  for (let hop = 0; ; hop++) {
    let response: Response;
    try {
      response = await doFetch(url, {
        headers: apiHeaders(options.token),
        redirect: "manual",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      throw failure("DOWNLOAD_FAILED", `request to ${url.host} failed`, error);
    }
    if (response.status === 200) {
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        throw failure("DOWNLOAD_FAILED", "the repo description stopped", error);
      }
      let facts: RepoFacts | undefined;
      try {
        facts = text.length > MAX_REPO_JSON_BYTES ? undefined : parseRepoFacts(JSON.parse(text));
      } catch {
        facts = undefined;
      }
      if (facts === undefined) throw failure("DOWNLOAD_REFUSED", "malformed repo description");
      return facts;
    }
    await discard(response);
    if (!REDIRECT.has(response.status)) throw failureForStatus(response.status, response.headers);
    const location = response.headers.get("location");
    let next: URL | undefined;
    try {
      next = location === null ? undefined : new URL(location, url);
    } catch {
      next = undefined;
    }
    if (next?.origin !== api.origin || hop >= MAX_REDIRECTS) {
      throw failure("DOWNLOAD_REFUSED", "repo redirect refused");
    }
    url = next;
  }
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
    const headers = toApi ? apiHeaders(options.token) : { "user-agent": USER_AGENT };
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

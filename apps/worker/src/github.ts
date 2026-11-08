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
 * - `MERGE_BASE_NOT_FOUND` (permanent, {@link fetchMergeBase} only): a comparison's 404.
 * - When the signal fires, its reason is rethrown; the caller turns it into `CANCELLED` or
 *   `DOWNLOAD_TIMEOUT`.
 *
 * The returned body is the raw gzip stream; extract.ts limits what comes out of it.
 */

/** Where a tarball comes from. Names are checked by `parseJobRequest` before a job runs. */
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
  const value = await getApiJson(
    ["repos", source.owner, source.repo],
    options,
    MAX_REPO_JSON_BYTES,
    "the repo description",
  );
  const facts = parseRepoFacts(value);
  if (facts === undefined) throw failure("DOWNLOAD_REFUSED", "malformed repo description");
  return facts;
}

/** The two commits of a pull request, as its event names them (40 lowercase hex each). */
export interface ComparedPair {
  owner: string;
  repo: string;
  base: string;
  head: string;
}

/**
 * A comparison lists up to 300 files with their patches besides the merge base (GitHub caps
 * each patch), so it can run to megabytes; far past this it isn't one.
 */
const MAX_COMPARE_JSON_BYTES = 32 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;

/**
 * The merge base of a pull request's base and head (ADR-0245): `GET
 * {api}/repos/{owner}/{repo}/compare/{base}...{head}?per_page=1` (one commit listed; the
 * merge base comes whatever the page), read from `merge_base_commit.sha`. A fork's head is
 * reachable from the base repo, so one repo serves both. Redirects and statuses as for
 * {@link fetchRepoFacts}, except that a `404` (a commit GitHub doesn't have, or two commits
 * with no common ancestor) is the permanent `MERGE_BASE_NOT_FOUND`. A malformed answer is
 * `DOWNLOAD_REFUSED`.
 */
export async function fetchMergeBase(
  pair: ComparedPair,
  options: DownloadOptions = {},
): Promise<string> {
  if (!SHA.test(pair.base) || !SHA.test(pair.head)) throw new Error("compare full SHAs only");
  let value: unknown;
  try {
    value = await getApiJson(
      ["repos", pair.owner, pair.repo, "compare", `${pair.base}...${pair.head}`],
      options,
      MAX_COMPARE_JSON_BYTES,
      "the comparison",
      "per_page=1",
    );
  } catch (error) {
    if (error instanceof JobFailure && error.code === "REPO_NOT_FOUND") {
      throw failure("MERGE_BASE_NOT_FOUND", "GitHub answered 404 to the comparison");
    }
    throw error;
  }
  const sha =
    isRecord(value) && isRecord(value.merge_base_commit) ? value.merge_base_commit.sha : undefined;
  if (typeof sha !== "string" || !SHA.test(sha)) {
    throw failure("DOWNLOAD_REFUSED", "malformed comparison");
  }
  return sha;
}

/**
 * Read at most `maxBytes` of `response`'s body as text, or `undefined` past that (the rest is
 * cancelled unread). Rethrows the signal's reason if it fires; a body that stops is
 * `DOWNLOAD_FAILED`.
 */
async function readBounded(
  response: Response,
  maxBytes: number,
  what: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (response.body === null) return "";
    const reader = response.body.getReader();
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
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw failure("DOWNLOAD_FAILED", `${what} stopped`, error);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * `GET {api}/<path parts, each encoded>[?query]` as JSON, following redirects inside the API
 * only (with the token, at most {@link MAX_REDIRECTS} hops). A body over `maxBytes` or not
 * JSON is `DOWNLOAD_REFUSED`; statuses map through {@link failureForStatus}. Rethrows the
 * signal's reason if it fires.
 */
async function getApiJson(
  parts: readonly string[],
  options: DownloadOptions,
  maxBytes: number,
  what: string,
  query?: string,
): Promise<unknown> {
  const doFetch = options.fetch ?? fetch;
  const api = new URL(options.apiBase ?? "https://api.github.com");
  const path = parts.map(encodeURIComponent).join("/");
  let url = new URL(`${api.pathname.replace(/\/$/, "")}/${path}`, api);
  if (query !== undefined) url.search = query;

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
      const text = await readBounded(response, maxBytes, what, options.signal);
      try {
        if (text !== undefined) return JSON.parse(text) as unknown;
      } catch {
        // Falls through to the refusal below.
      }
      throw failure("DOWNLOAD_REFUSED", `malformed answer: ${what}`);
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

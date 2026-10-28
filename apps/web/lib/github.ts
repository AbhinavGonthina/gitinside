import type { RepoRef } from "./repoUrl";

/**
 * Asking GitHub which commit to analyze (docs/DESIGN.md §11, ADR-0066): the repo's facts
 * (`GET /repos/{owner}/{repo}`), then its default branch's latest commit
 * (`GET /repos/{owner}/{repo}/commits/HEAD` with the `sha` media type, which answers with
 * the 40 hex characters alone).
 *
 * - **Public repos only** until M8: a private repo is reported exactly like a missing one,
 *   so a configured token that can see private repos never reveals that one exists.
 * - **Only `api.github.com` is contacted.** A renamed repo's `301` to
 *   `/repositories/<id>` is followed (at most 3 hops, same origin only); a redirect anywhere
 *   else counts as not found. The token, if any, goes nowhere else.
 * - Owner and repo were checked by `parseRepoUrl`; they're still URL-encoded into the path.
 */

/** What GitHub says about the repo, as `@gitinside/db`'s `upsertRepo` stores it. */
export interface ResolvedRepo {
  providerRepoId: number;
  /** GitHub's spelling, which may differ in case from what was pasted. */
  owner: string;
  name: string;
  visibility: "public";
  defaultBranch: string;
  /** The default branch's latest commit, 40 lowercase hex. */
  sha: string;
}

/** Why a repo couldn't be resolved. */
export type ResolveFailure =
  /** 404, a private repo, or a redirect off GitHub's API. */
  | "REPO_NOT_FOUND"
  /** The repo has no commits. */
  | "REPO_EMPTY"
  /** 451: GitHub blocks it. */
  | "REPO_UNAVAILABLE"
  /** GitHub's API rate limit for our token or IP is used up. */
  | "GITHUB_RATE_LIMITED"
  /** Network error, timeout, 5xx, or an answer we don't understand. */
  | "GITHUB_UNAVAILABLE";

export type ResolveResult = { ok: true; repo: ResolvedRepo } | { ok: false; code: ResolveFailure };

/** Options for {@link resolveRepo}. */
export interface GitHubOptions {
  /** Raises the API rate limit from 60 to 5,000 per hour. Sent to api.github.com only. */
  token?: string;
  /** Default `https://api.github.com` (tests point it at a fake). */
  apiBase?: string;
  /** Each GitHub request gives up after this long. Default 5 s. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const REDIRECT = new Set([301, 302, 307, 308]);
/** API redirects followed (a rename is one). */
const MAX_REDIRECTS = 3;
/** A repo description is ~6 KB; anything far larger isn't one. */
const MAX_JSON_BYTES = 1024 * 1024;

class Failure extends Error {
  constructor(readonly code: ResolveFailure) {
    super(code);
  }
}

function failureFor(response: Response): ResolveFailure {
  const { status, headers } = response;
  if (status === 404 || (status >= 300 && status < 400)) return "REPO_NOT_FOUND";
  if (status === 409) return "REPO_EMPTY";
  if (status === 451) return "REPO_UNAVAILABLE";
  if (
    (status === 403 || status === 429) &&
    (headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after"))
  ) {
    return "GITHUB_RATE_LIMITED";
  }
  return "GITHUB_UNAVAILABLE";
}

/** A redirect's target if it stays on the API's origin (a renamed repo), else `undefined`. */
function sameOrigin(response: Response, from: URL, api: URL): URL | undefined {
  const location = response.headers.get("location");
  if (location === null) return undefined;
  try {
    const next = new URL(location, from);
    return next.origin === api.origin ? next : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve a pasted repo to GitHub's facts and the latest commit on its default branch.
 * Never throws: every failure is a {@link ResolveFailure}.
 */
export async function resolveRepo(
  ref: RepoRef,
  options: GitHubOptions = {},
): Promise<ResolveResult> {
  const doFetch = options.fetch ?? fetch;
  const api = new URL(options.apiBase ?? "https://api.github.com");
  const repoPath = (owner: string, repo: string) =>
    `${api.pathname.replace(/\/$/, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  async function get(path: string, accept: string): Promise<string> {
    let url = new URL(path, api);
    for (let hop = 0; ; hop++) {
      let response: Response;
      try {
        response = await doFetch(url, {
          headers: {
            "user-agent": "gitinside-web",
            accept,
            "x-github-api-version": "2022-11-28",
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          },
          redirect: "manual",
          signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
        });
      } catch {
        throw new Failure("GITHUB_UNAVAILABLE");
      }
      if (response.status === 200) {
        try {
          return await response.text();
        } catch {
          throw new Failure("GITHUB_UNAVAILABLE");
        }
      }
      await response.body?.cancel().catch(() => undefined);
      const next = REDIRECT.has(response.status) ? sameOrigin(response, url, api) : undefined;
      if (next === undefined || hop >= MAX_REDIRECTS) throw new Failure(failureFor(response));
      url = next;
    }
  }

  try {
    const text = await get(repoPath(ref.owner, ref.repo), "application/vnd.github+json");
    const facts = text.length > MAX_JSON_BYTES ? undefined : parseFacts(text);
    if (facts === undefined) return { ok: false, code: "GITHUB_UNAVAILABLE" };
    if (facts.private) return { ok: false, code: "REPO_NOT_FOUND" };
    // GitHub's own spelling, so a renamed repo's commit is asked for under its new name.
    const commit = `${repoPath(facts.owner, facts.name)}/commits/HEAD`;
    const sha = (await get(commit, "application/vnd.github.sha")).trim();
    if (!SHA.test(sha)) return { ok: false, code: "GITHUB_UNAVAILABLE" };
    const { id, owner, name, defaultBranch } = facts;
    return {
      ok: true,
      repo: { providerRepoId: id, owner, name, visibility: "public", defaultBranch, sha },
    };
  } catch (error) {
    if (error instanceof Failure) return { ok: false, code: error.code };
    throw error;
  }
}

/** The fields we keep from a repo description, or `undefined` if any is missing or malformed. */
function parseFacts(
  text: string,
):
  | { id: number; owner: string; name: string; private: boolean; defaultBranch: string }
  | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
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

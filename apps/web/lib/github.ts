import type { RepoRef } from "./repoUrl";

/**
 * Asking GitHub which commit to analyze (docs/DESIGN.md §11, ADR-0066): the repo's facts
 * (`GET /repos/{owner}/{repo}`), then its default branch's latest commit
 * (`GET /repos/{owner}/{repo}/commits/HEAD` with the `sha` media type, which answers with
 * the 40 hex characters alone). Before new work, its languages (`fetchCodeBytes`, ADR-0154).
 *
 * - **Public repos only** by name: a private repo is reported exactly like a missing one,
 *   so a configured token that can see private repos never reveals that one exists. A private
 *   repo's page asks by ID with the viewer's token instead ({@link resolveRepoById}, M8.4c2),
 *   and a signed-in "Analyze" by name with the user's token ({@link resolveSeenRepo}, M8.4c2b).
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
  /**
   * GitHub's `size` in KiB (roughly the repository's packed git data, history included);
   * left out if GitHub's answer has none we can read, so no size rule acts on a guess.
   */
  sizeKb?: number;
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

/** GitHub's REST API on `options.apiBase`, read with `options`. */
class GitHubApi {
  readonly #api: URL;

  constructor(private readonly options: GitHubOptions) {
    this.#api = new URL(options.apiBase ?? "https://api.github.com");
  }

  /** `/repos/{owner}/{repo}` under the API's base path. */
  repoPath(owner: string, repo: string): string {
    return `${this.#api.pathname.replace(/\/$/, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  /** `/repositories/{id}` under the API's base path: the repo whatever it's called now. */
  idPath(providerRepoId: number): string {
    return `${this.#api.pathname.replace(/\/$/, "")}/repositories/${providerRepoId}`;
  }

  /** The body of a `200` for `path`, following same-origin redirects; else a {@link Failure}. */
  async get(path: string, accept: string): Promise<string> {
    const { options } = this;
    const doFetch = options.fetch ?? fetch;
    let url = new URL(path, this.#api);
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
      const next = REDIRECT.has(response.status) ? sameOrigin(response, url, this.#api) : undefined;
      if (next === undefined || hop >= MAX_REDIRECTS) throw new Failure(failureFor(response));
      url = next;
    }
  }
}

/** A repo as GitHub showed it to a token that may read private repos (a user's, M8.4c2). */
export type SeenRepo = Omit<ResolvedRepo, "visibility"> & { visibility: "public" | "private" };

/** What {@link resolveRepoById} and {@link resolveSeenRepo} found. */
export type SeenResult = { ok: true; repo: SeenRepo } | { ok: false; code: ResolveFailure };

type Facts = NonNullable<ReturnType<typeof parseFacts>>;

/**
 * The repo described at `factsPath`, then its latest commit at `commitPath(facts)`, unless
 * `refuse(facts)` names a failure first (asked before the commit, so a refused repo costs one
 * call). Never throws.
 */
async function seeRepo(
  options: GitHubOptions,
  factsPath: (api: GitHubApi) => string,
  commitPath: (api: GitHubApi, facts: Facts) => string,
  refuse: (facts: Facts) => ResolveFailure | undefined,
): Promise<SeenResult> {
  const api = new GitHubApi(options);
  try {
    const text = await api.get(factsPath(api), "application/vnd.github+json");
    const facts = text.length > MAX_JSON_BYTES ? undefined : parseFacts(text);
    if (facts === undefined) return { ok: false, code: "GITHUB_UNAVAILABLE" };
    const refused = refuse(facts);
    if (refused !== undefined) return { ok: false, code: refused };
    const sha = (await api.get(commitPath(api, facts), "application/vnd.github.sha")).trim();
    if (!SHA.test(sha)) return { ok: false, code: "GITHUB_UNAVAILABLE" };
    const { id, owner, name, defaultBranch, sizeKb } = facts;
    return {
      ok: true,
      repo: {
        providerRepoId: id,
        owner,
        name,
        visibility: facts.private ? "private" : "public",
        defaultBranch,
        sha,
        ...(sizeKb === undefined ? {} : { sizeKb }),
      },
    };
  } catch (error) {
    if (error instanceof Failure) return { ok: false, code: error.code };
    throw error;
  }
}

/** `/repos/{owner}/{repo}/commits/HEAD` in GitHub's own spelling, so a renamed repo's commit is asked for under its new name. */
const headByName = (api: GitHubApi, facts: Facts) =>
  `${api.repoPath(facts.owner, facts.name)}/commits/HEAD`;

/**
 * Resolve a pasted repo to GitHub's facts and the latest commit on its default branch.
 * Never throws: every failure is a {@link ResolveFailure}.
 */
export async function resolveRepo(
  ref: RepoRef,
  options: GitHubOptions = {},
): Promise<ResolveResult> {
  const seen = await seeRepo(
    options,
    (api) => api.repoPath(ref.owner, ref.repo),
    headByName,
    (facts) => (facts.private ? "REPO_NOT_FOUND" : undefined),
  );
  return seen.ok ? { ok: true, repo: { ...seen.repo, visibility: "public" } } : seen;
}

/**
 * Like {@link resolveRepo}, but a private repo is answered as one rather than as missing: for
 * "Analyze" by a signed-in user (M8.4c2b), asked with their own token, which GitHub shows a
 * private repo only where the app is installed and the user can read it. Never throws.
 */
export async function resolveSeenRepo(
  ref: RepoRef,
  options: GitHubOptions = {},
): Promise<SeenResult> {
  return seeRepo(
    options,
    (api) => api.repoPath(ref.owner, ref.repo),
    headByName,
    () => undefined,
  );
}

/**
 * Like {@link resolveSeenRepo}, but by GitHub's repo ID (`GET /repositories/{id}`, then
 * `…/commits/HEAD`): for a private repo page checking for newer commits with the viewer's own
 * token (M8.4c2), which GitHub shows the repo to only after the access check did. An answer
 * naming another ID is `GITHUB_UNAVAILABLE`, so a stored repo is never matched with a
 * different one. Never throws.
 */
export async function resolveRepoById(
  providerRepoId: number,
  options: GitHubOptions = {},
): Promise<SeenResult> {
  return seeRepo(
    options,
    (api) => api.idPath(providerRepoId),
    (api) => `${api.idPath(providerRepoId)}/commits/HEAD`,
    (facts) => (facts.id !== providerRepoId ? "GITHUB_UNAVAILABLE" : undefined),
  );
}

/**
 * The languages GitHub reports (Linguist's names) that the analyzer parses. `.tsx` is counted
 * under TypeScript and `.jsx` under JavaScript; `TSX` and `JSX` are summed in case an answer
 * names them on their own. `.prisma` files are left out: they're small.
 */
export const ANALYZED_LANGUAGES: readonly string[] = ["JavaScript", "JSX", "TSX", "TypeScript"];

/**
 * GitHub's count of TypeScript and JavaScript bytes on the repo's default branch
 * (`GET /repos/{owner}/{repo}/languages`, Linguist: vendored, generated, and documentation
 * files left out), or `undefined` if GitHub can't be asked or its answer can't be read, so no
 * rule acts on a guess. Never throws.
 *
 * Not exact: Linguist's exclusions aren't the analyzer's (`IGNORED_DIRS`, files over 2 MB),
 * and GitHub recounts a little after a push, so the count can be the previous commit's.
 * Measured against the analyzer's source size: VS Code 211 vs 201 MiB, cal.com 17.2 vs
 * 18.0 MiB (ADR-0154).
 */
export async function fetchCodeBytes(
  repo: Pick<ResolvedRepo, "owner" | "name">,
  options: GitHubOptions = {},
): Promise<number | undefined> {
  const api = new GitHubApi(options);
  try {
    const path = `${api.repoPath(repo.owner, repo.name)}/languages`;
    const text = await api.get(path, "application/vnd.github+json");
    return text.length > MAX_JSON_BYTES ? undefined : parseCodeBytes(text);
  } catch (error) {
    if (error instanceof Failure) return undefined;
    throw error;
  }
}

/** The {@link ANALYZED_LANGUAGES}' bytes in a languages answer, or `undefined` if malformed. */
function parseCodeBytes(text: string): number | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  let total = 0;
  for (const language of ANALYZED_LANGUAGES) {
    if (!Object.hasOwn(value, language)) continue;
    const bytes = value[language];
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) return undefined;
    total += bytes;
  }
  return total;
}

/**
 * The fields we keep from a repo description, or `undefined` if any required one is missing
 * or malformed (`size` is optional: without it, only the size rules are skipped).
 */
function parseFacts(text: string):
  | {
      id: number;
      owner: string;
      name: string;
      private: boolean;
      defaultBranch: string;
      sizeKb?: number;
    }
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
  const { size } = value;
  // The database column is a 32-bit integer; a real repo is far below its 2 TiB.
  const sizeKb =
    typeof size === "number" && Number.isInteger(size) && size >= 0 && size <= 2 ** 31 - 1
      ? size
      : undefined;
  return {
    id,
    owner: login,
    name,
    private: value.private,
    defaultBranch,
    ...(sizeKb === undefined ? {} : { sizeKb }),
  };
}

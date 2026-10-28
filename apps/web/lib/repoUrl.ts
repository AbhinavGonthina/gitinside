/**
 * Turning what a visitor pastes into a GitHub `owner/repo` pair. The result
 * goes into our own URLs (`/<owner>/<repo>`) and, from M5.6, into GitHub API
 * paths, so both parts are checked against GitHub's own name rules and
 * nothing else gets through.
 */

/** A GitHub repository named by its owner and name, as typed (GitHub ignores case). */
export interface RepoRef {
  owner: string;
  repo: string;
}

/** The outcome of {@link parseRepoUrl}: the repo, or a message to show under the field. */
export type RepoUrlResult = ({ ok: true } & RepoRef) | { ok: false; error: string };

/**
 * Owner names: letters, digits, and single hyphens, not at either end, up to
 * 39 characters (GitHub's username and organization rule).
 */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** Repo names: letters, digits, `.`, `_`, and `-`, up to 100 characters; `.` and `..` aren't names. */
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * First path segments of github.com that are GitHub's own pages, not owners
 * (`github.com/settings/profile`, `github.com/orgs/acme`). GitHub reserves
 * these, so no account has them as its name.
 */
const RESERVED_OWNERS = new Set([
  "about",
  "apps",
  "codespaces",
  "collections",
  "enterprise",
  "events",
  "explore",
  "features",
  "issues",
  "login",
  "marketplace",
  "new",
  "notifications",
  "organizations",
  "orgs",
  "pricing",
  "pulls",
  "search",
  "settings",
  "sponsors",
  "topics",
  "trending",
]);

const HOSTS = new Set(["github.com", "www.github.com"]);

/** Shown when the text isn't a GitHub repo address at all. */
export const NOT_A_REPO_URL = "That isn't a GitHub repo URL. Try https://github.com/owner/repo.";

/**
 * Parses a GitHub repo URL in any form a visitor is likely to paste:
 * `https://github.com/owner/repo` (with or without the scheme or `www.`),
 * deeper links into the repo (`/tree/main/src`, `/pull/12`, `?tab=readme`,
 * `#readme`), clone URLs (`.git`, `git@github.com:owner/repo.git`), and the
 * `owner/repo` shorthand. Surrounding whitespace is ignored.
 *
 * Not accepted: other hosts (GitLab, Bitbucket, and GitHub Enterprise are not
 * in v1), gists, GitHub's own pages (`/settings`, `/orgs/…`), a bare owner,
 * and names GitHub itself wouldn't allow. Never throws.
 */
export function parseRepoUrl(input: string): RepoUrlResult {
  const text = input.trim();
  if (text === "") return { ok: false, error: "Paste a GitHub repo URL first." };

  const ssh = /^git@github\.com:(?<owner>[^/]+)\/(?<repo>[^/]+?)\/?$/i.exec(text)?.groups;
  if (ssh?.owner !== undefined && ssh.repo !== undefined) return checkNames(ssh.owner, ssh.repo);

  // `owner/repo` with no host: exactly two segments and no dot in the owner,
  // so `gitlab.com/a` isn't read as an owner named `gitlab.com`.
  const short = /[:\\]/.test(text)
    ? undefined
    : /^(?<owner>[^/.]+)\/(?<repo>[^/]+?)\/?$/.exec(text)?.groups;
  if (short?.owner !== undefined && short.repo !== undefined) {
    return checkNames(short.owner, short.repo);
  }

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { ok: false, error: NOT_A_REPO_URL };
  }
  if (!["http:", "https:"].includes(url.protocol) || !HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: false, error: NOT_A_REPO_URL };
  }
  if (url.username !== "" || url.password !== "" || url.port !== "") {
    return { ok: false, error: NOT_A_REPO_URL };
  }
  const [owner, repo] = url.pathname.split("/").filter((s) => s !== "");
  if (owner === undefined) return { ok: false, error: NOT_A_REPO_URL };
  if (repo === undefined) {
    return {
      ok: false,
      error: "That's an account, not a repo. Add the repo name: github.com/owner/repo.",
    };
  }
  return checkNames(owner, repo);
}

/**
 * Checks a route's `[owner]` and `[repo]` segments (already URL-decoded by
 * Next.js) with the same rules as {@link parseRepoUrl}. `null` means the page
 * should 404.
 */
export function parseRepoPath(owner: string, repo: string): RepoRef | null {
  const result = checkNames(owner, repo, false);
  return result.ok ? { owner: result.owner, repo: result.repo } : null;
}

function checkNames(owner: string, rawRepo: string, stripGit = true): RepoUrlResult {
  const repo = stripGit ? rawRepo.replace(/\.git$/i, "") : rawRepo;
  if (!OWNER.test(owner) || RESERVED_OWNERS.has(owner.toLowerCase())) {
    return { ok: false, error: NOT_A_REPO_URL };
  }
  if (!REPO.test(repo) || repo === "." || repo === "..") {
    return { ok: false, error: NOT_A_REPO_URL };
  }
  return { ok: true, owner, repo };
}

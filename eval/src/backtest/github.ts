/**
 * What the PR list reads from GitHub's REST API: the merged PRs of a repo's branch in the
 * window (issue search), each kept PR's merge commit (pulls API), and, for a possible rebase,
 * its commit messages. Every call goes through `api`, so tests answer them from fixtures and
 * the CLI through `gh api`.
 */
import { addDays, type BacktestRepo, type BacktestReposFile } from "./format.js";
import { MAX_PR_COMMITS, type ListedPr } from "./prs.js";

/** GET `path` (with its query string) from GitHub's REST API and parse the JSON answer. */
export type GitHubApi = (path: string) => unknown;

/** GitHub's search returns at most this many results for one query. */
const SEARCH_CAP = 1000;
const PAGE_SIZE = 100;

interface SearchPage {
  total_count: number;
  incomplete_results: boolean;
  items: { number: number; pull_request?: { merged_at: string | null } }[];
}

interface PullResponse {
  number: number;
  title: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  commits: number;
  base: { ref: string };
}

/**
 * The search query for `repo`'s PRs merged in `window`. Its dates are a day wider on each
 * side, since the search's day boundaries aren't documented as UTC; `inWindow` then keeps
 * exactly the window's UTC days.
 */
export function searchQuery(
  repo: Pick<BacktestRepo, "owner" | "name" | "branch">,
  window: BacktestReposFile["window"],
): string {
  const range = `${addDays(window.from, -1)}..${addDays(window.to, 1)}`;
  return `repo:${repo.owner}/${repo.name} is:pr is:merged base:${repo.branch} merged:${range}`;
}

/**
 * Every result of `query`, as `{ number, mergedAt }`. Throws when GitHub says the results are
 * incomplete, there are more than its search can return, or a PR shows up twice, rather than
 * listing a part.
 */
export function searchMerged(
  api: GitHubApi,
  query: string,
): { number: number; mergedAt: string }[] {
  const found: { number: number; mergedAt: string }[] = [];
  for (let page = 1; ; page++) {
    const q = new URLSearchParams({
      q: query,
      per_page: String(PAGE_SIZE),
      page: String(page),
      sort: "created",
      order: "asc",
    });
    const result = api(`search/issues?${q.toString()}`) as SearchPage;
    if (result.incomplete_results)
      throw new Error(`GitHub's search for ${query} timed out (incomplete results)`);
    if (result.total_count > SEARCH_CAP) {
      throw new Error(
        `${result.total_count} results for ${query}, more than search returns (${SEARCH_CAP})`,
      );
    }
    for (const item of result.items) {
      const mergedAt = item.pull_request?.merged_at;
      if (!mergedAt) throw new Error(`search result #${item.number} is not a merged PR`);
      // Results that shift between pages would show up twice (and push others out).
      if (found.some((f) => f.number === item.number)) {
        throw new Error(`PR #${item.number} came back on two search pages; list again`);
      }
      found.push({ number: item.number, mergedAt });
    }
    if (result.items.length < PAGE_SIZE || found.length >= result.total_count) break;
  }
  return found;
}

/** One PR's facts from the pulls API, checked against what the search said. */
export function pullFacts(
  api: GitHubApi,
  repo: Pick<BacktestRepo, "owner" | "name">,
  searched: { number: number; mergedAt: string },
): ListedPr {
  const pr = api(`repos/${repo.owner}/${repo.name}/pulls/${searched.number}`) as PullResponse;
  if (pr.merged_at !== searched.mergedAt) {
    throw new Error(
      `PR #${searched.number}: merged_at ${String(pr.merged_at)}, search said ${searched.mergedAt}`,
    );
  }
  if (!pr.merge_commit_sha) throw new Error(`PR #${searched.number} has no merge_commit_sha`);
  return {
    number: pr.number,
    title: pr.title,
    mergedAt: pr.merged_at,
    baseRef: pr.base.ref,
    mergeSha: pr.merge_commit_sha,
    commits: pr.commits,
  };
}

/** The full commit messages of a PR's commits, oldest first (at most 250, the API's limit). */
export function pullMessages(
  api: GitHubApi,
  repo: Pick<BacktestRepo, "owner" | "name">,
  number: number,
): string[] {
  const messages: string[] = [];
  for (let page = 1; messages.length < MAX_PR_COMMITS; page++) {
    const commits = api(
      `repos/${repo.owner}/${repo.name}/pulls/${number}/commits?per_page=${PAGE_SIZE}&page=${page}`,
    ) as { commit: { message: string } }[];
    messages.push(...commits.map((c) => c.commit.message));
    if (commits.length < PAGE_SIZE) break;
  }
  return messages;
}

import { describe, expect, it } from "vitest";
import { pullFacts, pullMessages, searchMerged, searchQuery, type GitHubApi } from "./github.js";

const repo = { owner: "acme", name: "shop", branch: "main" };

/** An API answering from `pages` by path, recording every call. */
function fake(answer: (path: string) => unknown): GitHubApi & { calls: string[] } {
  const calls: string[] = [];
  const api = (path: string): unknown => {
    calls.push(path);
    return answer(path);
  };
  return Object.assign(api, { calls });
}

const item = (
  number: number,
  mergedAt: string | null = `2026-07-01T00:00:${String(number % 60).padStart(2, "0")}Z`,
) => ({
  number,
  pull_request: { merged_at: mergedAt },
});

describe("searchQuery", () => {
  it("asks for a day more on each side of the window", () => {
    expect(searchQuery(repo, { from: "2026-07-01", to: "2026-09-30" })).toBe(
      "repo:acme/shop is:pr is:merged base:main merged:2026-06-30..2026-10-01",
    );
  });
});

describe("searchMerged", () => {
  it("reads every page until the total is reached", () => {
    const api = fake((path) => {
      const page = Number(new URL(`https://x/${path}`).searchParams.get("page"));
      const numbers = page === 1 ? Array.from({ length: 100 }, (_, i) => i + 1) : [101, 102];
      return { total_count: 102, incomplete_results: false, items: numbers.map((n) => item(n)) };
    });
    const found = searchMerged(api, "q");
    expect(found).toHaveLength(102);
    expect(found[101]).toEqual({ number: 102, mergedAt: "2026-07-01T00:00:42Z" });
    expect(api.calls).toHaveLength(2);
    expect(new URL(`https://x/${api.calls[0]}`).searchParams.get("q")).toBe("q");
  });

  it("stops after a full last page once the total is reached", () => {
    const api = fake(() => ({
      total_count: 100,
      incomplete_results: false,
      items: Array.from({ length: 100 }, (_, i) => item(i + 1)),
    }));
    expect(searchMerged(api, "q")).toHaveLength(100);
    expect(api.calls).toHaveLength(1);
  });

  it("refuses incomplete results, more than search returns, unmerged items, and repeats", () => {
    const one = (answer: object) => () =>
      searchMerged(
        fake(() => answer),
        "q",
      );
    expect(one({ total_count: 1, incomplete_results: true, items: [item(1)] })).toThrow(
      "timed out",
    );
    expect(one({ total_count: 1001, incomplete_results: false, items: [] })).toThrow(
      "1001 results for q, more than search returns (1000)",
    );
    expect(one({ total_count: 1, incomplete_results: false, items: [item(7, null)] })).toThrow(
      "search result #7 is not a merged PR",
    );
    expect(one({ total_count: 2, incomplete_results: false, items: [item(7), item(7)] })).toThrow(
      "PR #7 came back on two search pages",
    );
  });
});

const pull = {
  number: 5,
  title: "feat: x",
  merged_at: "2026-07-02T10:00:00Z",
  merge_commit_sha: "a".repeat(40),
  commits: 3,
  base: { ref: "main" },
  head: { sha: "b".repeat(40) },
};

describe("pullFacts", () => {
  it("reads a PR's merge commit, head, base branch, and commit count", () => {
    const api = fake(() => pull);
    expect(pullFacts(api, repo, { number: 5, mergedAt: "2026-07-02T10:00:00Z" })).toEqual({
      number: 5,
      title: "feat: x",
      mergedAt: "2026-07-02T10:00:00Z",
      baseRef: "main",
      mergeSha: "a".repeat(40),
      headSha: "b".repeat(40),
      commits: 3,
    });
    expect(api.calls).toEqual(["repos/acme/shop/pulls/5"]);
  });

  it("refuses a merge time the search didn't report, and a PR without a merge commit", () => {
    expect(() =>
      pullFacts(
        fake(() => pull),
        repo,
        { number: 5, mergedAt: "2026-07-02T10:00:01Z" },
      ),
    ).toThrow("PR #5: merged_at 2026-07-02T10:00:00Z, search said 2026-07-02T10:00:01Z");
    expect(() =>
      pullFacts(
        fake(() => ({ ...pull, merge_commit_sha: null })),
        repo,
        {
          number: 5,
          mergedAt: "2026-07-02T10:00:00Z",
        },
      ),
    ).toThrow("PR #5 has no merge_commit_sha");
  });
});

describe("pullMessages", () => {
  it("reads every page of a PR's commits, oldest first", () => {
    const api = fake((path) => {
      const page = Number(new URL(`https://x/${path}`).searchParams.get("page"));
      const count = page === 1 ? 100 : 2;
      return Array.from({ length: count }, (_, i) => ({ commit: { message: `p${page}c${i}` } }));
    });
    const messages = pullMessages(api, repo, 5);
    expect(messages).toHaveLength(102);
    expect(messages.slice(-2)).toEqual(["p2c0", "p2c1"]);
    expect(api.calls[0]).toBe("repos/acme/shop/pulls/5/commits?per_page=100&page=1");
  });

  it("stops asking once the API's 250 commits are read", () => {
    const api = fake(() => Array.from({ length: 100 }, () => ({ commit: { message: "m" } })));
    expect(pullMessages(api, repo, 5)).toHaveLength(300);
    expect(api.calls).toHaveLength(3);
  });
});

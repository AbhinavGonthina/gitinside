import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EvalInputError } from "../format.js";
import { addDays, parseBacktestReposFile } from "./format.js";

const SHA_A = "0123456789abcdef0123456789abcdef01234567";
const SHA_B = "89abcdef0123456789abcdef0123456789abcdef";

const repo = (owner: string, name: string): Record<string, unknown> => ({
  owner,
  name,
  url: `https://github.com/${owner}/${name}`,
  license: "MIT",
  branch: "main",
  startSha: SHA_A,
  endSha: SHA_B,
  why: "React client calling an Express API",
  measured: { mergedPrs: 97, files: 609, httpToRoute: 300, appHttpToRoute: 300 },
});

const example = {
  pinned: "2026-11-06",
  window: { from: "2026-07-01", to: "2026-09-30" },
  maxPrsPerRepo: 300,
  followUpDays: 30,
  rules: ["an app, not archived", "at least 20 merged PRs in the window"],
  candidates: "a hand-made list",
  repos: [repo("acme", "shop"), repo("Zeta", "app")],
  rejected: [{ repo: "acme/legacy", rule: 1, reason: "archived" }],
};

const text = (overrides: Record<string, unknown>): string =>
  JSON.stringify({ ...example, ...overrides });

/** The issue lines of the error `fn` throws. */
function issues(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EvalInputError);
    return (error as Error).message;
  }
  throw new Error("expected an EvalInputError");
}

describe("parseBacktestReposFile", () => {
  it("accepts the example", () => {
    const file = parseBacktestReposFile("repos.json", text({}));
    expect(file.repos.map((r) => r.name)).toEqual(["shop", "app"]);
    expect(file.window).toEqual({ from: "2026-07-01", to: "2026-09-30" });
  });

  it("requires repos sorted case-insensitively and named once, pinned or rejected", () => {
    expect(
      issues(() =>
        parseBacktestReposFile(
          "repos.json",
          text({ repos: [repo("Zeta", "app"), repo("acme", "shop")] }),
        ),
      ),
    ).toContain("repos.1: repo out of order");
    expect(
      issues(() =>
        parseBacktestReposFile(
          "repos.json",
          text({ rejected: [{ repo: "ACME/shop", rule: 1, reason: "dup" }] }),
        ),
      ),
    ).toContain("rejected.0.repo: acme/shop is both pinned and rejected");
    expect(
      issues(() =>
        parseBacktestReposFile(
          "repos.json",
          text({
            rejected: [
              { repo: "b/b", rule: 1, reason: "x" },
              { repo: "a/a", rule: 2, reason: "y" },
            ],
          }),
        ),
      ),
    ).toContain("rejected.1: rejected repo out of order");
  });

  it("requires each rejection to name an existing rule", () => {
    const reject = (rule: number): string =>
      issues(() =>
        parseBacktestReposFile(
          "repos.json",
          text({ rejected: [{ repo: "acme/legacy", rule, reason: "x" }] }),
        ),
      );
    expect(reject(3)).toContain("rejected.0.rule: there is no rule 3 (2 rules)");
    expect(reject(0)).toContain("rejected.0.rule");
    expect(
      issues(() =>
        parseBacktestReposFile(
          "repos.json",
          text({ rejected: [{ repo: "acme/legacy", reason: "x" }] }),
        ),
      ),
    ).toContain("rejected.0.rule");
    expect(issues(() => parseBacktestReposFile("repos.json", text({ candidates: "" })))).toContain(
      "candidates",
    );
  });

  it("checks the url, SHAs, and that the start and end differ", () => {
    const bad = { ...repo("acme", "shop"), url: "https://github.com/other/shop", endSha: SHA_A };
    const message = issues(() =>
      parseBacktestReposFile("repos.json", text({ repos: [bad, repo("Zeta", "app")] })),
    );
    expect(message).toContain("repos.0.url: url must be https://github.com/<owner>/<name>");
    expect(message).toContain("repos.0.endSha: the window's end must be a later commit");
    expect(
      issues(() =>
        parseBacktestReposFile(
          "repos.json",
          text({ repos: [{ ...repo("acme", "shop"), startSha: "abc" }] }),
        ),
      ),
    ).toContain("repos.0.startSha: must be a 40-character lowercase hex SHA");
  });

  it("requires a window that opens before it closes, followed up before the pin", () => {
    expect(
      issues(() =>
        parseBacktestReposFile(
          "repos.json",
          text({ window: { from: "2026-09-30", to: "2026-07-01" } }),
        ),
      ),
    ).toContain("window.to: must not be before window.from");
    expect(
      issues(() => parseBacktestReposFile("repos.json", text({ pinned: "2026-10-30" }))),
    ).toContain("pinned: the follow-up (window.to + 30 days = 2026-10-30) must have ended");
    expect(
      issues(() =>
        parseBacktestReposFile(
          "repos.json",
          text({ window: { from: "2026-7-1", to: "2026-09-30" } }),
        ),
      ),
    ).toContain("window.from: must be YYYY-MM-DD");
    expect(
      issues(() =>
        parseBacktestReposFile(
          "repos.json",
          text({ window: { from: "2026-02-30", to: "2026-09-30" } }),
        ),
      ),
    ).toContain("window.from: not a calendar date");
    expect(
      issues(() => parseBacktestReposFile("repos.json", text({ pinned: "2026-13-01" }))),
    ).toContain("pinned: not a calendar date");
  });

  it("rejects unknown keys and negative measurements", () => {
    expect(issues(() => parseBacktestReposFile("repos.json", text({ extra: 1 })))).toContain(
      "Unrecognized key(s) in object: 'extra'",
    );
    const measured = { mergedPrs: -1, files: 1, httpToRoute: 2, appHttpToRoute: 3 };
    const message = issues(() =>
      parseBacktestReposFile(
        "repos.json",
        text({ repos: [{ ...repo("acme", "shop"), measured }, repo("Zeta", "app")] }),
      ),
    );
    expect(message).toContain("repos.0.measured.mergedPrs");
    expect(message).toContain(
      "repos.0.measured.appHttpToRoute: app-code edges can't outnumber all edges",
    );
    expect(
      issues(() => parseBacktestReposFile("repos.json", text({ maxPrsPerRepo: 0 }))),
    ).toContain("maxPrsPerRepo");
  });
});

describe("eval/backtest/repos.json", () => {
  it("is valid, and every pinned repo meets the measured rules (3 and 5)", () => {
    const path = fileURLToPath(new URL("../../backtest/repos.json", import.meta.url));
    const file = parseBacktestReposFile("backtest/repos.json", readFileSync(path, "utf8"));
    for (const repo of file.repos) {
      expect(repo.measured.mergedPrs).toBeGreaterThanOrEqual(20);
      expect(repo.measured.appHttpToRoute).toBeGreaterThanOrEqual(20);
    }
  });
});

describe("addDays", () => {
  it("adds calendar days across month and year ends", () => {
    expect(addDays("2026-09-30", 30)).toBe("2026-10-30");
    expect(addDays("2026-12-15", 30)).toBe("2027-01-14");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });
});

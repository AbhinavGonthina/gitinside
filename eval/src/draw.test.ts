import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  collectPool,
  drawCrossCheck,
  drawOrder,
  drawProblems,
  loadDrawFiles,
  parseDrawFile,
  walkState,
  type DrawFile,
  type SearchPage,
} from "./draw.js";
import { EvalInputError, parseReposFile, type EvalRepo } from "./format.js";
import { seededShuffle } from "./sample.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const SHA = "a".repeat(40);
const POOL = ["a/one", "b/two", "C/three", "d/four", "e/five"];

function draw(examined: DrawFile["strata"][number]["examined"] = [], perStratum = 2): DrawFile {
  return {
    batch: 4,
    seed: "2026-11-04",
    perStratum,
    strata: [
      {
        name: "react-express",
        query: "topic:react",
        pool: { fetched: "2026-11-04", total: POOL.length, repos: POOL },
        examined,
      },
    ],
  };
}

function order(): string[] {
  const file = draw();
  const [stratum] = file.strata;
  if (!stratum?.pool) throw new Error("no pool");
  return drawOrder(file, stratum, stratum.pool);
}

/** {@link draw} with an exclusion list. */
function excluding(
  repos: string[],
  examined: DrawFile["strata"][number]["examined"] = [],
): DrawFile {
  return { ...draw(examined), exclude: repos.map((repo) => ({ repo, why: "batch 4" })) };
}

const pin = (repo: string): DrawFile["strata"][number]["examined"][number] => ({
  repo,
  verdict: "pinned",
  sha: SHA,
  reason: "in scope",
});
const reject = (repo: string): DrawFile["strata"][number]["examined"][number] => ({
  repo,
  verdict: "rejected",
  reason: "no requests to its own routes",
});

describe("drawOrder", () => {
  it("is a permutation of the pool that depends on the seed and stratum name", () => {
    const a = order();
    expect([...a].sort()).toEqual([...POOL].sort());
    const file = draw();
    const pool = { fetched: "2026-11-04", total: POOL.length, repos: POOL };
    expect(drawOrder(file, { name: "react-express" }, pool)).toEqual(a);
    const others = [
      drawOrder({ seed: "2026-11-05" }, { name: "react-express" }, pool),
      drawOrder(file, { name: "nextjs-prisma" }, pool),
    ];
    expect(others.some((o) => o.join() !== a.join())).toBe(true);
  });

  it("leaves out excluded repos, matching names case-insensitively", () => {
    const file = excluding(["B/TWO", "c/three"]);
    const [stratum] = file.strata;
    if (!stratum?.pool) throw new Error("no pool");
    const left = drawOrder(file, stratum, stratum.pool);
    expect([...left].sort()).toEqual(["a/one", "d/four", "e/five"]);
    expect(left).toEqual(seededShuffle(["a/one", "d/four", "e/five"], "2026-11-04/react-express"));
  });

  it("keeps an unexcluded draw's order (batch 4's) when the list is empty", () => {
    const file = excluding([]);
    const [stratum] = file.strata;
    if (!stratum?.pool) throw new Error("no pool");
    expect(drawOrder(file, stratum, stratum.pool)).toEqual(order());
  });
});

describe("drawProblems", () => {
  it("accepts a walk that follows the seeded order and stops at its quota", () => {
    const [first = "", second = "", third = ""] = order();
    expect(drawProblems(draw([reject(first), pin(second), pin(third)]))).toEqual([]);
  });

  it("rejects a skipped candidate", () => {
    const [, second = ""] = order();
    expect(drawProblems(draw([pin(second)])).map((p) => p.message)).toEqual([
      `the seeded order's next repo is ${order()[0] ?? ""}, not ${second}`,
    ]);
  });

  it("rejects reading on past the quota", () => {
    const [first = "", second = "", third = ""] = order();
    const problems = drawProblems(draw([pin(first), pin(second), reject(third)]));
    expect(problems).toEqual([
      { path: ["strata", 0, "examined", 2], message: "the walk stops once 2 repos are pinned" },
    ]);
  });

  it("rejects a walk longer than the pool", () => {
    const all = order().map(reject);
    const problems = drawProblems(draw([...all, reject("z/extra")], 9));
    expect(problems.map((p) => p.message)).toEqual(["the pool has no more repos"]);
  });

  it("rejects a pool that isn't the whole, sorted, distinct result set", () => {
    const file = draw();
    const [stratum] = file.strata;
    if (!stratum) throw new Error("no stratum");
    stratum.pool = { fetched: "2026-11-04", total: 4, repos: ["b/x", "a/y", "a/y"] };
    expect(drawProblems(file).map((p) => p.message)).toEqual([
      "lists 3 repos, but the search found 4",
      "repos must be sorted by owner/name",
      "duplicate repo",
    ]);
  });

  it("rejects a repeated stratum and a walk before its pool", () => {
    const file = draw();
    file.strata.push({ name: "react-express", query: "q", pool: null, examined: [reject("a/b")] });
    expect(drawProblems(file)).toEqual([
      { path: ["strata", 1, "name"], message: "stratum react-express appears twice" },
      { path: ["strata", 1, "examined"], message: "walked before its pool was recorded" },
    ]);
  });

  it("reports a repo pinned in two strata", () => {
    const [first = ""] = order();
    const file = draw([pin(first)], 1);
    const pool = { fetched: "2026-11-04", total: 1, repos: [first] };
    file.strata.push({ name: "other", query: "q", pool, examined: [pin(first)] });
    expect(drawProblems(file).map((p) => p.message)).toEqual([
      `${first} is already pinned in stratum react-express`,
    ]);
  });

  it("rejects an exclusion list that isn't sorted and distinct", () => {
    expect(drawProblems(excluding(["b/two", "A/one", "a/ONE"]))).toEqual([
      { path: ["exclude", 1, "repo"], message: "exclusions must be sorted by owner/name" },
      { path: ["exclude", 2, "repo"], message: "excluded twice" },
    ]);
  });

  it("rejects reading an excluded repo and accepts the walk around it", () => {
    const file = excluding(["b/two"]);
    const [stratum] = file.strata;
    if (!stratum?.pool) throw new Error("no pool");
    const [first = "", second = ""] = drawOrder(file, stratum, stratum.pool);
    expect(drawProblems(excluding(["b/two"], [reject(first), pin(second)]))).toEqual([]);
    expect(drawProblems(excluding(["b/two"], [pin("b/two")]))[0]).toEqual({
      path: ["strata", 0, "examined", 0, "repo"],
      message: "b/two is excluded",
    });
  });
});

describe("parseDrawFile", () => {
  it("requires a sha exactly on pins", () => {
    const [first = ""] = order();
    const bad = draw([{ repo: first, verdict: "rejected", sha: SHA, reason: "x" }]);
    expect(() => parseDrawFile("draws/x.json", JSON.stringify(bad))).toThrow(
      /a pinned candidate needs its sha/,
    );
  });

  it("reports the walk's problems as validation errors", () => {
    const [, second = ""] = order();
    expect(() => parseDrawFile("draws/x.json", JSON.stringify(draw([pin(second)])))).toThrow(
      EvalInputError,
    );
  });
});

describe("walkState", () => {
  it("says what to read next, then when the quota is met or the pool runs out", () => {
    const [first = "", second = "", third = ""] = order();
    const file = draw([reject(first)]);
    const [stratum] = file.strata;
    if (!stratum) throw new Error("no stratum");
    expect(walkState(file, stratum)).toEqual({
      state: "next",
      repo: second,
      pinned: 0,
      examined: 1,
    });
    stratum.examined.push(pin(second), pin(third));
    expect(walkState(file, stratum)).toEqual({
      state: "done",
      pinned: 2,
      examined: 3,
      exhausted: false,
    });
    const all = draw(order().map(reject), 2);
    const [walked] = all.strata;
    if (!walked) throw new Error("no stratum");
    expect(walkState(all, walked)).toEqual({
      state: "done",
      pinned: 0,
      examined: 5,
      exhausted: true,
    });
    expect(walkState(all, { ...walked, pool: null })).toEqual({ state: "no-pool" });
  });
});

describe("collectPool", () => {
  const page = (total: number, names: string[], incomplete = false): SearchPage => ({
    total_count: total,
    incomplete_results: incomplete,
    items: names.map((full_name) => ({ full_name })),
  });

  it("reads every page and returns the pool sorted case-insensitively", async () => {
    const first = Array.from({ length: 100 }, (_, i) => `o/r${String(i).padStart(3, "0")}`);
    const pages = [page(102, first), page(102, ["Z/last", "a/first"])];
    const asked: number[] = [];
    const pool = await collectPool(async (n) => {
      asked.push(n);
      return pages[n - 1] ?? page(102, []);
    }, "2026-11-05");
    expect(asked).toEqual([1, 2]);
    expect(pool.total).toBe(102);
    expect(pool.fetched).toBe("2026-11-05");
    expect(pool.repos[0]).toBe("a/first");
    expect(pool.repos.at(-1)).toBe("Z/last");
  });

  it("fails past the search cap, on incomplete results, and on shifted pages", async () => {
    await expect(collectPool(async () => page(1001, []), "d")).rejects.toThrow(/search cap/);
    await expect(collectPool(async () => page(1, ["a/b"], true), "d")).rejects.toThrow(
      /incomplete/,
    );
    await expect(collectPool(async () => page(2, ["a/b", "A/B"]), "d")).rejects.toThrow(
      /read 1 distinct repos of 2/,
    );
    const shifting = [
      page(
        101,
        Array.from({ length: 100 }, (_, i) => `o/${i}`),
      ),
      page(102, []),
    ];
    await expect(collectPool(async (n) => shifting[n - 1] ?? page(0, []), "d")).rejects.toThrow(
      /total changed from 101 to 102/,
    );
  });
});

describe("drawCrossCheck", () => {
  const repo = (owner: string, name: string, sha: string, heldOut?: number): EvalRepo => ({
    owner,
    name,
    url: `https://github.com/${owner}/${name}`,
    sha,
    license: "MIT",
    shape: "spa-plus-express",
    why: "test",
    ...(heldOut === undefined ? {} : { heldOut }),
  });

  it("requires every repo of the batch to be a pin at the same sha", () => {
    const [first = ""] = order();
    const [owner = "", name = ""] = first.split("/");
    const file = draw([pin(first)]);
    expect(drawCrossCheck(file, [repo(owner, name, SHA, 4), repo("x", "old", SHA, 3)])).toEqual([]);
    expect(drawCrossCheck(file, [repo(owner, name, "b".repeat(40), 4)])).toEqual([
      `${first}: the draw pinned ${SHA}, repos.json ${"b".repeat(40)}`,
    ]);
    expect(drawCrossCheck(file, [repo("x", "y", SHA, 4)])).toEqual([
      "x/y is in batch 4, but its draw didn't pin it",
    ]);
  });

  it("requires an exclusion list to name every earlier repo and earlier draw's candidate", () => {
    const earlier = { ...draw([reject("p/read"), pin("q/pinned")]), batch: 3 };
    const later = { ...excluding(["O/Orig"]), batch: 5 };
    const repos = [repo("o", "orig", SHA), repo("x", "b3", SHA, 3), repo("y", "b5", SHA, 5)];
    expect(drawCrossCheck(later, repos, [earlier, later])).toEqual([
      "p/read is read for batch 3, but not excluded",
      "q/pinned is read for batch 3, but not excluded",
      "x/b3 is in batch 3, but not excluded",
      "y/b5 is in batch 5, but its draw didn't pin it",
    ]);
    const all = ["o/orig", "p/read", "q/pinned", "x/b3"];
    expect(
      drawCrossCheck({ ...later, exclude: excluding(all).exclude }, repos.slice(0, 2), [earlier]),
    ).toEqual([]);
    // Without a list (batch 4), rule 1 was checked by reading, so nothing is required.
    expect(drawCrossCheck({ ...draw(), batch: 5 }, repos.slice(0, 2), [earlier])).toEqual([]);
  });
});

describe("the committed draw records", () => {
  it("are valid and agree with repos.json and each other", () => {
    const { repos } = parseReposFile("repos.json", readFileSync(`${root}/repos.json`, "utf8"));
    const draws = loadDrawFiles(root);
    expect(draws.map((d) => d.file)).toEqual(
      expect.arrayContaining(["batch-4.json", "batch-5.json"]),
    );
    const all = draws.map((d) => d.draw);
    for (const file of all) expect(drawCrossCheck(file, repos, all)).toEqual([]);
  });
});

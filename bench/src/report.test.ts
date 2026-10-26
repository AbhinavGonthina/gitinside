import { describe, expect, it } from "vitest";
import {
  countGraph,
  median,
  renderReport,
  stat,
  summarize,
  type ReportMeta,
  type RunResult,
} from "./report.js";

function run(totalMs: number, sha = "a", rssMiB = 100): RunResult {
  return {
    totalMs,
    stages: { inventory: totalMs / 4, programs: totalMs / 2 },
    maxRssBytes: rssMiB * 1024 * 1024,
    graphSha256: sha,
    counts: { "nodes.file": 3, edges: 2 },
  };
}

const META: ReportMeta = {
  date: "2026-10-26",
  repo: { name: "demo", url: "https://github.com/x/demo", sha: "abc" },
  gitinsideSha: "def",
  analyzerVersion: "0.1.0",
  warmupRuns: 1,
  machine: { label: "dev", cpu: "CPU", cores: 8, ramGiB: 16, os: "linux 6", node: "v22" },
};

describe("median and stat", () => {
  it("takes the middle value, or the mean of the two middle values", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(stat([2, 9, 4])).toEqual({ median: 4, min: 2, max: 9 });
  });

  it("rejects an empty list", () => {
    expect(() => median([])).toThrow(/empty/);
  });
});

describe("summarize", () => {
  it("aggregates totals, RSS, and stages in pipeline order", () => {
    const s = summarize([run(100), run(300), run(200)]);
    expect(s.runs).toBe(3);
    expect(s.totalMs).toEqual({ median: 200, min: 100, max: 300 });
    expect(s.stages.map(([name]) => name)).toEqual(["inventory", "programs"]);
    expect(s.stages[1]![1].median).toBe(100);
    expect(s.identicalGraphs).toBe(true);
  });

  it("flags runs whose graphs differ", () => {
    expect(summarize([run(1, "a"), run(1, "b")]).identicalGraphs).toBe(false);
  });

  it("rejects no runs", () => {
    expect(() => summarize([])).toThrow(/no runs/);
  });
});

describe("renderReport", () => {
  it("prints the pinned repo, machine, and measured numbers", () => {
    const md = renderReport(META, summarize([run(1234.4, "a", 512), run(1500, "a", 600)]));
    expect(md).toContain("https://github.com/x/demo at `abc`");
    expect(md).toContain("CPU (8 logical cores), 16 GiB RAM, linux 6, Node v22");
    expect(md).toContain("| Wall-clock `analyze` | 1,367 ms | 1,234 ms | 1,500 ms |");
    expect(md).toContain("| Peak RSS | 556 MiB | 512 MiB | 600 MiB |");
    expect(md).toContain("| programs | 684 ms |");
    expect(md).toContain("**Graphs identical across runs:** yes");
    // Counts are sorted by key for a stable report.
    expect(md.indexOf("| edges |")).toBeLessThan(md.indexOf("| nodes.file |"));
  });

  it("calls out differing graphs loudly", () => {
    expect(renderReport(META, summarize([run(1, "a"), run(1, "b")]))).toContain("**NO**");
  });
});

describe("countGraph", () => {
  it("counts nodes and edges by kind plus warnings", () => {
    expect(
      countGraph({
        nodes: [{ kind: "file" }, { kind: "file" }, { kind: "route" }],
        edges: [{ kind: "imports" }],
        warnings: [{}, {}],
      }),
    ).toEqual({ "nodes.file": 2, "nodes.route": 1, "edges.imports": 1, warnings: 2 });
  });
});

import { describe, expect, it } from "vitest";
import {
  IMPACT_BUDGET_MS,
  percentile,
  renderImpactReport,
  summarize,
  type ImpactRun,
} from "./impactReport.js";

const run = (indexMs: number[], times: number[]): ImpactRun => ({
  date: "2026-11-15",
  repo: { name: "calcom", url: "https://github.com/calcom/cal.com", sha: "0f19cc4" },
  gitinsideSha: "abc",
  analyzerVersion: "0.3.0",
  machine: { label: "dev machine", cpu: "CPU", cores: 8, ramGiB: 16, os: "win32", node: "v22" },
  graph: { nodes: 10, edges: 20 },
  indexMs,
  runsPerTarget: 3,
  cases: times.map((ms, i) => ({
    target: `symbol:t${i}`,
    kind: i % 2 ? "route" : "symbol",
    ms,
    dependents: i,
    maybe: 0,
  })),
});

describe("impact benchmark report", () => {
  it("takes nearest-rank percentiles", () => {
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(
      percentile(
        Array.from({ length: 100 }, (_, i) => i + 1),
        95,
      ),
    ).toBe(95);
    expect(percentile([], 95)).toBe(0);
  });

  it("judges the budget by the median build plus the slowest query", () => {
    expect(summarize(run([10, 30, 20], [1, 2, IMPACT_BUDGET_MS - 20]))).toMatchObject({
      indexMedianMs: 20,
      queryMaxMs: 80,
      worstFirstMs: 100,
      withinBudget: true,
    });
    expect(summarize(run([10, 30, 20], [1, 2, IMPACT_BUDGET_MS - 19])).withinBudget).toBe(false);
  });

  it("says over budget in the report, and lists the slowest target first", () => {
    const md = renderImpactReport(run([50], [1, 70, 3]));
    expect(md).toContain("**over budget**");
    expect(md.indexOf("`symbol:t1`")).toBeLessThan(md.indexOf("`symbol:t2`"));
    expect(md).toContain("| route | 1 | 70.00 ms | 70.00 ms | 1 |");
  });
});

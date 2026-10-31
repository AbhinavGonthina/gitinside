import { describe, expect, it } from "vitest";
import type { FrameStats } from "./fps.js";
import {
  meetsTarget,
  renderRenderReport,
  type RenderMeta,
  type RenderRun,
} from "./renderReport.js";

const stats = (medianFps: number, p5Fps = medianFps): FrameStats => ({
  frames: 600,
  seconds: 10,
  medianFps,
  p5Fps,
  meanFps: medianFps,
  longFrames: 3,
  worstMs: 120,
});

const run = (graph: string, target: number, medianFps: number): RenderRun => ({
  graph,
  target,
  nodes: target - 7,
  lines: 1234,
  layoutMs: 4321.4,
  frames: {
    drawn: { min: 180, max: 1993 },
    idle: stats(60),
    moving: stats(medianFps, medianFps / 2),
  },
});

/** A case whose first layout was still running after 10 minutes. */
const unfinished = (graph: string, target: number): RenderRun => ({
  graph,
  target,
  nodes: target - 3,
  lines: 4000,
  layoutMs: 600_000,
  frames: null,
});

const meta: RenderMeta = {
  date: "2026-10-31",
  gitinsideSha: "abc123",
  machine: { label: "dev", cpu: "CPU", cores: 8, ramGiB: 16, os: "win32 10", node: "v22.0.0" },
  browser: "Chromium 140 (headless)",
  viewport: { width: 1440, height: 900 },
  seconds: 10,
  idleSeconds: 2,
  real: { name: "calcom", url: "https://github.com/calcom/cal.com", sha: "0f19cc4" },
};

describe("meetsTarget", () => {
  it("rounds the median to a whole frame per second", () => {
    expect(meetsTarget(run("synthetic", 2000, 59.9))).toBe(true);
    expect(meetsTarget(run("synthetic", 2000, 59.4))).toBe(false);
    expect(meetsTarget(run("synthetic", 2000, 120))).toBe(true);
  });

  it("fails a run whose first layout never finished", () => {
    expect(meetsTarget(unfinished("calcom", 2000))).toBe(false);
  });
});

describe("renderRenderReport", () => {
  const report = renderRenderReport(meta, [
    run("synthetic", 500, 60),
    run("synthetic", 2000, 41.26),
    run("calcom", 2000, 59.8),
    run("calcom", 1000, 30),
  ]);

  it("gives each graph's largest case a verdict, exactly as measured", () => {
    expect(report).toContain(
      "- **synthetic, 1,993 visible nodes:** 41.3 fps median, 20.6 fps p5: **misses** the 60fps median target.",
    );
    expect(report).toContain(
      "- **calcom, 1,993 visible nodes:** 59.8 fps median, 29.9 fps p5: meets the 60fps median target.",
    );
    expect(report).not.toContain("493 visible nodes:**");
  });

  it("lists every run with its numbers", () => {
    expect(report).toContain(
      "| synthetic | 500 | 493 | 1,234 | 180–1,993 | 4,321 ms | 60.0 | 60.0 | 30.0 | 3 of 600 | 120 ms |",
    );
    expect(report.match(/^\| (synthetic|calcom) \|/gm)).toHaveLength(4);
  });

  it("says where it ran and how", () => {
    expect(report).toContain("# Render benchmark (2026-10-31)");
    expect(report).toContain("`abc123`");
    expect(report).toContain("Chromium 140 (headless), 1440×900");
    expect(report).toContain("https://github.com/calcom/cal.com at `0f19cc4`");
    expect(report).toContain("dev: CPU (8 logical cores), 16 GiB RAM, win32 10, Node v22.0.0");
  });

  it("says when a first layout didn't finish, instead of inventing frames", () => {
    const stuck = renderRenderReport(meta, [run("calcom", 1000, 60), unfinished("calcom", 2000)]);
    expect(stuck).toContain(
      "- **calcom, 1,997 visible nodes:** **not measured**: the first layout didn't finish within 10 min, so there was nothing to pan.",
    );
    expect(stuck).toContain(
      "| calcom | 2,000 | 1,997 | 4,000 | – | not done after 10 min | – | – | – | – | – |",
    );
  });
});

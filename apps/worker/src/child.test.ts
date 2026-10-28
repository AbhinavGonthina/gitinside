import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ANALYSIS_STAGES, AnalysisError, analyze } from "@gitinside/analyzer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runChildJob } from "./child.js";
import type { StepProgress } from "./progress.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/no-tsconfig/", import.meta.url));

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitinside-child-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("runChildJob", () => {
  it("writes the golden graph and reports counts and per-stage times", async () => {
    const out = join(dir, "architecture.json");
    const report = await runChildJob({ src: FIXTURE, out, owner: "fixtures", name: "no-tsconfig" });
    const text = await readFile(out, "utf8");
    expect(text).toBe(await readFile(join(FIXTURE, "expected.json"), "utf8"));
    const graph = JSON.parse(text) as {
      nodes: { kind: string }[];
      edges: unknown[];
      warnings: unknown[];
    };
    expect(report).toMatchObject({
      ok: true,
      stats: {
        files: graph.nodes.filter((node) => node.kind === "file").length,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        warnings: graph.warnings.length,
        graphBytes: Buffer.byteLength(text),
      },
    });
    if (report.ok) {
      expect(Object.keys(report.stats.stageMs)[0]).toBe("inventory");
      expect(Object.values(report.stats.stageMs).every(Number.isInteger)).toBe(true);
    }
  });

  it("passes each analyzer stage on as a step, with the counts the analyzer gives", async () => {
    const steps: StepProgress[] = [];
    await runChildJob(
      { src: FIXTURE, out: join(dir, "g.json"), owner: "a", name: "b" },
      undefined,
      (progress) => steps.push(progress),
    );
    expect(steps.map(({ step }) => step).filter((step, i, all) => all.indexOf(step) === i)).toEqual(
      [...ANALYSIS_STAGES],
    );
    const programs = steps.find(({ step }) => step === "programs");
    expect(programs?.count).toBeGreaterThan(0);
    expect(steps.filter(({ step }) => step === "http").at(-1)).toHaveProperty("count");
  });

  it("passes the SHA to the analyzer only when given", async () => {
    const seen: unknown[] = [];
    const spy: typeof analyze = (src, options) => {
      seen.push(options?.sha);
      return analyze(src, options);
    };
    const out = join(dir, "g.json");
    await runChildJob({ src: FIXTURE, out, owner: "a", name: "b" }, { analyze: spy });
    await runChildJob(
      { src: FIXTURE, out, owner: "a", name: "b", sha: "abcdef0" },
      { analyze: spy },
    );
    expect(seen).toEqual([undefined, "abcdef0"]);
  });

  it("turns an AnalysisError into a report with its code, writing nothing", async () => {
    const out = join(dir, "g.json");
    const report = await runChildJob(
      { src: FIXTURE, out, owner: "a", name: "b" },
      {
        analyze: () => Promise.reject(new AnalysisError("LIMIT_FILES", "too many")),
      },
    );
    expect(report).toEqual({ ok: false, code: "LIMIT_FILES", message: "LIMIT_FILES: too many" });
    await expect(readFile(out)).rejects.toThrow();
  });

  it("lets any other error propagate (the runner reports a crash)", async () => {
    await expect(
      runChildJob(
        { src: FIXTURE, out: join(dir, "g.json"), owner: "a", name: "b" },
        { analyze: () => Promise.reject(new TypeError("bug")) },
      ),
    ).rejects.toThrow("bug");
  });
});

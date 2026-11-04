import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ANALYSIS_STAGES, AnalysisError, analyze, openDiskCache } from "@gitinside/analyzer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runChildJob } from "./child.js";
import type { FoundFacts, StepProgress } from "./progress.js";

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
      // This process's own readings, in whole bytes. (On Windows the peak RSS is the peak
      // working set, which can read below the heap once memory is paged out, so they aren't
      // compared.)
      const { peakRssBytes = 0, heapBytes = 0 } = report.stats;
      expect(Number.isSafeInteger(peakRssBytes) && Number.isSafeInteger(heapBytes)).toBe(true);
      expect(heapBytes).toBeGreaterThan(1024 * 1024);
      expect(peakRssBytes).toBeGreaterThan(1024 * 1024);
      // Collector pauses by kind, in whole ms (a small fixture may need no collection).
      const { gcMs } = report.stats;
      expect(gcMs).toBeTypeOf("object");
      for (const [kind, ms] of Object.entries(gcMs ?? {})) {
        expect(["minor", "major", "incremental", "weakcb"]).toContain(kind);
        expect(Number.isInteger(ms) && ms >= 0).toBe(true);
      }
    }
  });

  it("sums the collector's pauses during the analysis by kind (M5.13a5)", async () => {
    // A fake analyzer that allocates enough to collect, so pauses are certain.
    const report = await runChildJob(
      { src: FIXTURE, out: join(dir, "g.json"), owner: "a", name: "b" },
      {
        analyze: async (...args) => {
          let keep: object[] = [];
          for (let i = 0; i < 2_000_000; i++) {
            keep.push({ i });
            if (keep.length > 100_000) keep = [];
          }
          return analyze(...args);
        },
      },
    );
    expect(report.ok && report.stats.gcMs?.minor).toBeGreaterThan(0);
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

  it("passes what the analyzer found on, capped for storage (#8)", async () => {
    const found: FoundFacts[] = [];
    const names = Array.from({ length: 12 }, (_, i) => `svc-${String(i).padStart(2, "0")}`);
    await runChildJob(
      { src: FIXTURE, out: join(dir, "g.json"), owner: "a", name: "b" },
      {
        analyze: async (src, options) => {
          options?.onFound?.({ services: names });
          options?.onFound?.({ services: names, routes: 2 });
          return analyze(src);
        },
      },
      undefined,
      (facts) => found.push(facts),
    );
    const services = { count: 12, names: names.slice(0, 8) };
    expect(found).toEqual([{ services }, { services, routes: 2 }]);
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

  it("opens the job's cache with its cap in whole pages, and reports the cache's counters", async () => {
    const opened: unknown[] = [];
    const out = join(dir, "g.json");
    const job = {
      src: FIXTURE,
      out,
      owner: "fixtures",
      name: "no-tsconfig",
      cache: { dir: join(dir, "cache"), maxBytes: 1 << 20 },
    };
    const openCache: typeof openDiskCache = (folder, options) => {
      opened.push([folder, options]);
      return openDiskCache(folder, options);
    };
    const cold = await runChildJob(job, { analyze, openCache });
    const warm = await runChildJob(job, { analyze, openCache });
    expect(opened).toEqual([
      [job.cache.dir, { maxBytes: 1 << 20, blockBytes: 4096 }],
      [job.cache.dir, { maxBytes: 1 << 20, blockBytes: 4096 }],
    ]);
    expect(cold).toMatchObject({ ok: true, stats: { cache: { misses: 1, writes: 1, hits: 0 } } });
    expect(warm).toMatchObject({ ok: true, stats: { cache: { hits: 1, writes: 0, misses: 0 } } });
    expect(await readFile(out, "utf8")).toBe(
      await readFile(join(FIXTURE, "expected.json"), "utf8"),
    );
  });

  it("runs cold, reporting no cache, when the cache can't be opened", async () => {
    let options: unknown;
    const report = await runChildJob(
      {
        src: FIXTURE,
        out: join(dir, "g.json"),
        owner: "a",
        name: "b",
        cache: { dir: "/x", maxBytes: 1 },
      },
      {
        analyze: (src, given) => {
          options = given;
          return analyze(src, given);
        },
        openCache: () => Promise.reject(new Error("EACCES")),
      },
    );
    expect(report.ok).toBe(true);
    expect(options).not.toHaveProperty("cache");
    expect(report.ok && report.stats).not.toHaveProperty("cache");
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

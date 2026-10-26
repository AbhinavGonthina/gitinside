import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringifyGraph } from "@gitinside/schema";
import { ANALYSIS_STAGES, ANALYZER_VERSION, analyze } from "./analyze.js";
import { runCli } from "./cli.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitinside-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function capture() {
  const io = {
    out: "",
    err: "",
    stdout: (t: string) => (io.out += t),
    stderr: (t: string) => (io.err += t),
  };
  return io;
}

describe("analyze", () => {
  it("returns a valid graph with a system root and a fallback service", async () => {
    const graph = await analyze(dir, { owner: "acme", name: "shop", sha: "abc1234" });
    expect(graph.repo).toEqual({ owner: "acme", name: "shop", sha: "abc1234" });
    expect(graph.analyzerVersion).toBe(ANALYZER_VERSION);
    expect(graph.nodes.map((n) => n.id)).toEqual(["system:root", "service:app/"]);
  });

  it("creates one service node per workspace package", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ workspaces: ["apps/*"] }));
    await mkdir(join(dir, "apps", "api"), { recursive: true });
    await writeFile(
      join(dir, "apps", "api", "package.json"),
      JSON.stringify({ name: "@acme/api", dependencies: { express: "4" } }),
    );
    const graph = await analyze(dir);
    expect(graph.nodes[1]).toEqual({
      id: "service:api/",
      kind: "service",
      label: "@acme/api",
      parentId: "system:root",
      root: "apps/api",
      framework: "express",
      layer: "backend",
    });
  });

  it("merges inventory and workspace warnings in sorted order", async () => {
    await writeFile(join(dir, "package.json"), "{");
    await writeFile(join(dir, "app.min.js"), "!0;");
    const graph = await analyze(dir);
    expect(graph.warnings.map((w) => [w.file, w.code])).toEqual([
      ["app.min.js", "SKIPPED_GENERATED"],
      ["package.json", "INVALID_JSON"],
    ]);
  });

  it("includes tsconfig and syntax warnings from the per-service programs", async () => {
    await writeFile(join(dir, "bad.ts"), "const = ;");
    const graph = await analyze(dir);
    expect(graph.warnings.map((w) => [w.file, w.code])).toEqual([
      [undefined, "TSCONFIG_MISSING"],
      ["bad.ts", "SYNTAX_ERROR"],
    ]);
  });

  it("defaults owner and name", async () => {
    const graph = await analyze(dir);
    expect(graph.repo.owner).toBe("local");
    expect(graph.repo.name.length).toBeGreaterThan(0);
    expect(graph.repo.sha).toBeUndefined();
  });

  it("is byte-identical across runs", async () => {
    const a = stringifyGraph(await analyze(dir, { name: "x" }));
    const b = stringifyGraph(await analyze(dir, { name: "x" }));
    expect(a).toBe(b);
  });

  it("reports every stage once, in order, without changing the graph", async () => {
    await writeFile(join(dir, "a.ts"), "export function f() { return 1; }");
    const seen: [string, number][] = [];
    const timed = await analyze(dir, { name: "x", onStage: (s, ms) => seen.push([s, ms]) });
    expect(seen.map(([s]) => s)).toEqual([...ANALYSIS_STAGES]);
    expect(seen.every(([, ms]) => Number.isFinite(ms) && ms >= 0)).toBe(true);
    expect(stringifyGraph(timed)).toBe(stringifyGraph(await analyze(dir, { name: "x" })));
  });

  it("rejects a missing directory", async () => {
    await expect(analyze(join(dir, "nope"))).rejects.toThrow(/not a directory/);
  });

  it("records skipped files as graph warnings", async () => {
    await writeFile(join(dir, "app.min.js"), "!0;");
    const graph = await analyze(dir);
    expect(graph.warnings).toEqual([
      {
        code: "SKIPPED_GENERATED",
        file: "app.min.js",
        message: "generated file skipped (minified)",
      },
    ]);
  });

  it("fails with LIMIT_FILES over the source-file limit", async () => {
    await writeFile(join(dir, "a.ts"), "");
    await writeFile(join(dir, "b.ts"), "");
    await expect(analyze(dir, { limits: { maxSourceFiles: 1 } })).rejects.toMatchObject({
      code: "LIMIT_FILES",
    });
  });
});

describe("runCli", () => {
  it("prints the graph to stdout", async () => {
    const io = capture();
    expect(await runCli(["analyze", dir], io)).toBe(0);
    expect(JSON.parse(io.out).schemaVersion).toBe("1.0.0");
  });

  it("writes to --out", async () => {
    const io = capture();
    const file = join(dir, "out.json");
    expect(await runCli(["analyze", dir, "--out", file], io)).toBe(0);
    expect(io.out).toBe("");
    expect(JSON.parse(await readFile(file, "utf8")).nodes).toHaveLength(2);
  });

  it("replaces an existing --out file and leaves no temp file behind", async () => {
    const io = capture();
    const file = join(dir, "out.json");
    await writeFile(file, "old");
    expect(await runCli(["analyze", dir, "--out", file], io)).toBe(0);
    expect(JSON.parse(await readFile(file, "utf8")).schemaVersion).toBe("1.0.0");
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("reports a failed write with exit 1 and cleans up the temp file", async () => {
    const io = capture();
    // Renaming a file onto a directory fails after the temp file was written.
    const target = join(dir, "taken");
    await mkdir(join(target, "child"), { recursive: true });
    expect(await runCli(["analyze", dir, "--out", target], io)).toBe(1);
    expect(io.err).toMatch(/^error: /);
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("reports a missing path with exit 1", async () => {
    const io = capture();
    expect(await runCli(["analyze", join(dir, "nope")], io)).toBe(1);
    expect(io.err).toMatch(/not a directory/);
  });

  it.each([
    [["analyze"]],
    [["analyze", "a", "b"]],
    [["analyze", "a", "--out"]],
    [["analyze", "a", "--bogus"]],
    [["frobnicate"]],
  ])("rejects bad usage %j with exit 2", async (argv) => {
    const io = capture();
    expect(await runCli(argv, io)).toBe(2);
    expect(io.err).toMatch(/Usage/);
  });

  it("prints usage and exits 0 with no command", async () => {
    const io = capture();
    expect(await runCli([], io)).toBe(0);
    expect(io.err).toMatch(/Usage/);
  });
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringifyGraph } from "@gitinside/schema";
import { ANALYZER_VERSION, analyze } from "./analyze.js";
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
  it("returns a valid graph with a system root", async () => {
    const graph = await analyze(dir, { owner: "acme", name: "shop", sha: "abc1234" });
    expect(graph.repo).toEqual({ owner: "acme", name: "shop", sha: "abc1234" });
    expect(graph.analyzerVersion).toBe(ANALYZER_VERSION);
    expect(graph.nodes.map((n) => n.kind)).toEqual(["system"]);
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
    expect(JSON.parse(await readFile(file, "utf8")).nodes).toHaveLength(1);
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

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RUNNER_LIMITS,
  childArgs,
  formatDuration,
  runAnalysis,
  type RunOptions,
} from "./runner.js";

const WORKER = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(WORKER, "dist");
const PROBE = join(WORKER, "test", "probe.mjs");
const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));

let jobDir: string;
let src: string;
let out: string;

beforeEach(async () => {
  jobDir = await mkdtemp(join(tmpdir(), "gitinside-runner-"));
  src = join(jobDir, "src");
  out = join(jobDir, "architecture.json");
  await cp(join(FIXTURES, "express-basic"), src, { recursive: true });
});

afterEach(async () => {
  await rm(jobDir, { recursive: true, force: true });
});

/** Run the probe script in the runner's sandbox; `mode` picks its behavior. */
function runProbe(mode: string, arg = "x", options: RunOptions = {}) {
  return runAnalysis(
    { src, out, owner: mode, name: arg },
    { scriptsDir: DIST, childScript: PROBE, ...options },
  );
}

/** The probe's findings, from its `PROBE` report. */
function findings(result: Awaited<ReturnType<typeof runAnalysis>>): Record<string, unknown> {
  if (result.ok || result.code !== "PROBE") {
    throw new Error(`expected a probe report, got ${JSON.stringify(result)}`);
  }
  return JSON.parse(result.message) as Record<string, unknown>;
}

describe("runAnalysis with the real analyzer", () => {
  it("writes the same bytes as the golden graph and reports its stats", async () => {
    const result = await runAnalysis(
      { src, out, owner: "fixtures", name: "express-basic" },
      { scriptsDir: DIST },
    );
    expect(result.ok).toBe(true);
    const text = await readFile(out, "utf8");
    expect(text).toBe(await readFile(join(FIXTURES, "express-basic", "expected.json"), "utf8"));

    const graph = JSON.parse(text) as { nodes: { kind: string }[]; edges: unknown[] };
    if (!result.ok) return;
    expect(result.stats).toMatchObject({
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      unresolved: graph.nodes.filter((node) => node.kind === "unresolved").length,
      graphBytes: Buffer.byteLength(text),
    });
    expect(Object.keys(result.stats.stageMs)).toContain("inventory");
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it("records the commit SHA it was given", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const result = await runAnalysis(
      { src, out, owner: "acme", name: "shop", sha },
      { scriptsDir: DIST },
    );
    expect(result.ok).toBe(true);
    const graph = JSON.parse(await readFile(out, "utf8")) as { repo: unknown };
    expect(graph.repo).toEqual({ owner: "acme", name: "shop", sha });
  });

  it("reports ANALYZER_CRASHED, with the stack kept for logs, when the analyzer throws", async () => {
    const file = join(jobDir, "not-a-folder.txt");
    await writeFile(file, "x");
    const result = await runAnalysis(
      { src: file, out, owner: "acme", name: "shop" },
      { scriptsDir: DIST },
    );
    expect(result).toMatchObject({
      ok: false,
      code: "ANALYZER_CRASHED",
      message: "the analyzer stopped unexpectedly",
    });
    if (!result.ok) expect(result.stderrTail).toContain("not a directory");
  });

  it("throws when src or the folder of out doesn't exist", async () => {
    await expect(
      runAnalysis({ src: join(jobDir, "missing"), out, owner: "a", name: "b" }),
    ).rejects.toThrow();
    await expect(
      runAnalysis({ src, out: join(jobDir, "missing", "g.json"), owner: "a", name: "b" }),
    ).rejects.toThrow();
  });
});

describe("runAnalysis limits", () => {
  it("SIGKILLs a child stuck in synchronous code at the time limit", async () => {
    const result = await runProbe("spin", "x", { limits: { timeoutMs: 500 } });
    expect(result).toMatchObject({
      ok: false,
      code: "LIMIT_TIME",
      message: "LIMIT_TIME: analysis took longer than 0.5 seconds. Try analyzing a subfolder.",
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(450);
    expect(result.durationMs).toBeLessThan(10_000);
  });

  it("reports LIMIT_MEMORY when the child passes its heap cap", async () => {
    const result = await runProbe("hog", "x", { limits: { maxHeapMb: 32 } });
    expect(result).toMatchObject({
      ok: false,
      code: "LIMIT_MEMORY",
      message:
        "LIMIT_MEMORY: analysis needed more than 32 MB of memory. Try analyzing a subfolder.",
    });
  });

  it("kills the child and reports CANCELLED when the signal fires", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const result = await runProbe("spin", "x", { signal: controller.signal });
    expect(result).toMatchObject({ ok: false, code: "CANCELLED" });
    expect(result.durationMs).toBeLessThan(10_000);
  });

  it("doesn't start a child for an already aborted signal", async () => {
    const result = await runProbe("crash", "x", { signal: AbortSignal.abort() });
    expect(result).toMatchObject({ ok: false, code: "CANCELLED", stderrTail: "" });
  });

  it("uses the documented defaults", () => {
    expect(DEFAULT_RUNNER_LIMITS).toEqual({ timeoutMs: 300_000, maxHeapMb: 3072 });
  });
});

describe("runAnalysis outcomes", () => {
  it("passes a known analyzer code and message through", async () => {
    expect(await runProbe("known")).toMatchObject({
      ok: false,
      code: "LIMIT_FILES",
      message: "LIMIT_FILES: too many files",
    });
  });

  it.each([
    ["an uncaught error", "crash"],
    ["no report", "silent"],
    ["over 64 KiB of stdout", "noisy"],
    ["a report the graph file doesn't match", "lie"],
  ])("treats %s as ANALYZER_CRASHED", async (_, mode) => {
    const result = await runProbe(mode);
    expect(result).toMatchObject({ ok: false, code: "ANALYZER_CRASHED" });
  });

  it("keeps only the end of stderr", async () => {
    const result = await runProbe("crash");
    if (result.ok) throw new Error("expected a failure");
    expect(result.stderrTail).toContain("boom");
    expect(result.stderrTail.length).toBeLessThanOrEqual(8 * 1024);
  });
});

describe("the child's sandbox", () => {
  let server: Server;
  let connections = 0;

  beforeEach(async () => {
    connections = 0;
    server = createServer((socket) => {
      connections++;
      socket.destroy();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  });

  afterEach(async () => {
    await new Promise((done) => server.close(done));
  });

  it("fails every network API with ERR_NETWORK_DISABLED and connects to nothing", async () => {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const result = findings(await runProbe("network", String(address.port)));
    expect(result).toEqual({
      netConnect: "ERR_NETWORK_DISABLED",
      socketConnect: "ERR_NETWORK_DISABLED",
      httpGet: "ERR_NETWORK_DISABLED",
      fetch: "ERR_NETWORK_DISABLED",
      dnsLookup: "ERR_NETWORK_DISABLED",
      listen: "ERR_NETWORK_DISABLED",
      udp: "ERR_NETWORK_DISABLED",
    });
    expect(connections).toBe(0);
  });

  it("can't read outside its roots, write anything but out, or start processes", async () => {
    const secretDir = await mkdtemp(join(tmpdir(), "gitinside-secret-"));
    const secret = join(secretDir, "worker.env");
    await writeFile(secret, "R2_SECRET=planted");
    try {
      const result = findings(await runProbe("sandbox", secret));
      expect(result).toMatchObject({
        readSecret: "ERR_ACCESS_DENIED",
        writeSrc: "ERR_ACCESS_DENIED",
        writeOut: "ALLOWED",
        spawn: "ERR_ACCESS_DENIED",
        worker: "ERR_ACCESS_DENIED",
        heapFlag: "--max-old-space-size=3072",
      });
    } finally {
      await rm(secretDir, { recursive: true, force: true });
    }
  });

  it("gives the child an empty environment, ignoring the worker's secrets and NODE_OPTIONS", async () => {
    const saved = { ...process.env };
    process.env.R2_SECRET_ACCESS_KEY = "planted";
    process.env.NODE_OPTIONS = "--max-old-space-size=7";
    try {
      const result = findings(await runProbe("sandbox", join(jobDir, "nothing")));
      // On Windows libuv copies these from the parent when set, so the process can start;
      // Linux (production) gets nothing at all.
      const windowsRequired = [
        "HOMEDRIVE",
        "HOMEPATH",
        "LOGONSERVER",
        "PATH",
        "SYSTEMDRIVE",
        "SystemRoot",
        "TEMP",
        "USERDOMAIN",
        "USERNAME",
        "USERPROFILE",
        "WINDIR",
      ];
      const env = result.env as string[];
      if (process.platform === "win32") {
        // Windows variable names are case-insensitive, and the casing follows the parent.
        const required = windowsRequired.map((key) => key.toUpperCase());
        expect(env.filter((key) => !required.includes(key.toUpperCase()))).toEqual([]);
      } else {
        expect(env).toEqual([]);
      }
      expect(result.heapFlag).toBe("--max-old-space-size=3072");
    } finally {
      process.env = saved;
    }
  });
});

describe("formatDuration", () => {
  it.each([
    [300_000, "5 minutes"],
    [60_000, "1 minute"],
    [90_000, "90 seconds"],
    [1000, "1 second"],
    [500, "0.5 seconds"],
  ])("formats %i ms as %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe("childArgs", () => {
  it("puts limits and permissions before the guard, the script, and the job", () => {
    const job = { src: "/jobs/1/src", out: "/jobs/1/architecture.json", owner: "a", name: "b" };
    expect(
      childArgs(
        job,
        { timeoutMs: 1000, maxHeapMb: 512 },
        { script: "/app/child.js", guard: "/app/netguard.js" },
        ["/app"],
      ),
    ).toEqual([
      "--max-old-space-size=512",
      "--permission",
      "--allow-fs-read=/app",
      "--allow-fs-read=/jobs/1/src",
      "--allow-fs-write=/jobs/1/architecture.json",
      expect.stringMatching(/^--import=file:\/\/.*netguard\.js$/),
      "/app/child.js",
      JSON.stringify(job),
    ]);
  });
});

import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGzip, gzipSync } from "node:zlib";
import { compareStrings } from "@gitinside/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRequest } from "./api.js";
import { SKIPPED_PATH_MAX_CHARS } from "./extract.js";
import { JobFailure } from "./failure.js";
import { entriesOf, startFakeGitHub, tarballFrom, type FakeGitHub } from "./github.testkit.js";
import { processJob, type JobOutcome } from "./job.js";
import { runAnalysis } from "./runner.js";
import { paxBody, tar, type TestEntry } from "./tar.testkit.js";

/**
 * The worker's security suite (docs/SECURITY.md T1–T5, docs/TESTING.md "Security tests";
 * fixtures/malicious/README.md). Each hostile repo goes through the real pipeline at the
 * production limits: a fake GitHub serves the tarball, `processJob` streams it through the
 * extractor, and the sandboxed analysis child analyzes what was written. Nothing is
 * stubbed between the download and the stored graph.
 */

/** Every process the worker starts, recorded by the `node:child_process` mock below. */
const started = vi.hoisted(() => [] as { via: string; command: unknown; args: unknown }[]);

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const recorded = <T extends (...args: never[]) => unknown>(via: string, fn: T): T =>
    ((...args: unknown[]) => {
      started.push({ via, command: args[0], args: args[1] });
      return Reflect.apply(fn, original, args) as unknown;
    }) as unknown as T;
  return {
    ...original,
    spawn: recorded("spawn", original.spawn),
    spawnSync: recorded("spawnSync", original.spawnSync),
    exec: recorded("exec", original.exec),
    execSync: recorded("execSync", original.execSync),
    execFile: recorded("execFile", original.execFile),
    execFileSync: recorded("execFileSync", original.execFileSync),
    fork: recorded("fork", original.fork),
  };
});

const DIST = fileURLToPath(new URL("../dist", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const SHA = "0123456789abcdef0123456789abcdef01234567";
const ID = "analyze-security-0123456789abcdef";
const REQUEST: JobRequest = { kind: "analyze", owner: "acme", repo: "shop", sha: SHA };
const TOP = "acme-shop-0123456";
const MIB = 1024 * 1024;
/**
 * Test budget for cases that stream hundreds of MiB or write thousands of files. The
 * 20,001-file case takes ~2.7 minutes on the Windows dev machine under a full `pnpm test`.
 */
const SLOW = 600_000;

interface Graph {
  nodes: { id: string; kind: string; path?: string; method?: string }[];
  warnings: { code: string; file?: string }[];
}

/** What a finished job left behind, captured while its folder still existed. */
interface Finished {
  outcome: JobOutcome;
  graph: Graph;
  text: string;
  /** Everything under the job's `src` (see {@link listing}). */
  src: string[];
}

let github: FakeGitHub;
let root: string;
let jobsRoot: string;

beforeEach(async () => {
  github = await startFakeGitHub();
  root = await mkdtemp(join(tmpdir(), "gitinside-security-"));
  jobsRoot = join(root, "jobs");
  started.length = 0;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await github.close();
  await rm(root, { recursive: true, force: true });
});

/**
 * Every path under `dir`, relative with `/`, sorted: folders end in `/`, and anything that
 * is neither a file nor a folder (a symlink, a junction) ends in `@`, so it can't hide.
 */
async function listing(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const name of await readdir(join(dir, rel))) {
      const path = rel === "" ? name : `${rel}/${name}`;
      const info = await lstat(join(dir, path));
      if (info.isDirectory()) {
        out.push(`${path}/`);
        await walk(path);
      } else {
        out.push(info.isFile() ? path : `${path}@`);
      }
    }
  };
  await walk("");
  return out.sort(compareStrings);
}

/** What the extractor should write for `entries`: their files and folders, as {@link listing} shows them. */
function expectedListing(entries: TestEntry[]): string[] {
  const out = new Set<string>();
  for (const entry of entries) {
    const segments = entry.name.split("/").filter((s) => s !== "");
    for (let i = 1; i < segments.length; i++) out.add(`${segments.slice(0, i).join("/")}/`);
    out.add(entry.type === "5" ? `${segments.join("/")}/` : segments.join("/"));
  }
  return [...out].sort(compareStrings);
}

/** Run one job with the real extractor and analysis child. */
async function job(tarball: Buffer): Promise<Finished> {
  github.tarball = tarball;
  let captured: Omit<Finished, "outcome"> | undefined;
  const outcome = await processJob(
    { id: ID, request: REQUEST },
    {
      jobsRoot,
      download: {
        apiBase: github.apiBase,
        downloadOrigins: [github.codeloadOrigin],
        token: "test-token",
      },
      runOptions: { scriptsDir: DIST },
      publish: async ({ graphPath }) => {
        const text = await readFile(graphPath, "utf8");
        captured = {
          graph: JSON.parse(text) as Graph,
          text,
          src: await listing(join(dirname(graphPath), "src")),
        };
      },
    },
  );
  if (captured === undefined) throw new Error("the job finished without publishing");
  return { outcome, ...captured };
}

/** Run a job that must fail, returning its failure. */
async function failedJob(tarball: Buffer): Promise<JobFailure> {
  try {
    await job(tarball);
  } catch (error) {
    if (error instanceof JobFailure) return error;
    throw error;
  }
  throw new Error("expected the job to fail");
}

/** A gzipped tar of exactly these entries (names taken as they are, top folder first). */
function raw(entries: TestEntry[]): Buffer {
  return gzipSync(tar([{ name: `${TOP}/`, type: "5" }, ...entries]));
}

/** A file whose path is too long for the ustar header, carried in a pax record. */
function longFile(path: string, body: string): TestEntry[] {
  return [
    { name: "PaxHeader", type: "x", body: paxBody({ path: `${TOP}/${path}` }) },
    { name: "placeholder", body },
  ];
}

const filePaths = (graph: Graph): string[] =>
  graph.nodes.filter((n) => n.kind === "file").map((n) => n.path ?? "");

/** The one process a job may start: the analysis child, under the permission model. */
function expectOnlyTheSandboxedChild(): void {
  expect(started).toHaveLength(1);
  const [only] = started;
  expect(only?.via).toBe("spawn");
  expect(only?.command).toBe(process.execPath);
  const args = only?.args as string[];
  expect(args).toContain("--permission");
  expect(args.filter((a) => a.startsWith("--allow-fs-write="))).toHaveLength(1);
  expect(args.some((a) => /^--allow-(child-process|worker|addons|wasi)/.test(a))).toBe(false);
  expect(args).toContain(join(DIST, "child.js"));
}

/** A job that failed before analysis: no process started, nothing left on disk. */
async function expectStoppedBeforeAnalysis(): Promise<void> {
  expect(started).toEqual([]);
  expect(await listing(root)).toEqual(["jobs/"]);
}

describe("postinstall-script: a repo is parsed, never run (T1)", () => {
  const fixture = join(FIXTURES, "malicious", "postinstall-script");
  // Committing an .npmrc is refused by this repo's tooling, so the archive gains one here.
  const npmrc: TestEntry = {
    name: ".npmrc",
    body: "ignore-scripts=false\nonload-script=./scripts/pwn.js\nnode-options=--require ./scripts/pwn.js\n",
  };

  it("analyzes the repo without running any of its hooks or starting any other process", async () => {
    const entries = [...(await entriesOf(fixture)), npmrc];
    const { outcome, graph, src } = await job(tarballFrom(entries, TOP));

    // Exactly the archived files: no PWNED sentinel from a script, config, plugin, or import.
    expect(src).toEqual(expectedListing(entries));
    expect(src).not.toContain("PWNED");
    expectOnlyTheSandboxedChild();
    // It was analyzed, not just skipped: the Express route in the hostile server is there.
    expect(graph.nodes).toContainEqual(
      expect.objectContaining({ kind: "route", method: "GET", path: "/health" }),
    );
    expect(filePaths(graph)).toContain("src/server.ts");
    expect(outcome.extract.skipped).toBe(0);
    expect(await listing(root)).toEqual(["jobs/"]);
  });
});

describe("huge-file: size limits (T3)", () => {
  it("skips a 3 MB source file with a warning and analyzes the rest", async () => {
    const big = `export const big = 1;\n// ${"x".repeat(3 * MIB)}\n`;
    const { graph, src } = await job(
      tarballFrom(
        [
          { name: "src/big.ts", body: big },
          { name: "src/index.ts", body: "export const small = 2;\n" },
        ],
        TOP,
      ),
    );
    // Written in full (the 500 MiB cap bounds it), then refused by the analyzer.
    expect(src).toContain("src/big.ts");
    expect(graph.warnings).toContainEqual(
      expect.objectContaining({ code: "SKIPPED_LARGE", file: "src/big.ts" }),
    );
    expect(filePaths(graph)).toEqual(["src/index.ts"]);
    expectOnlyTheSandboxedChild();
  });

  it("fails with LIMIT_SIZE on a header declaring 600 MiB, before reading its body", async () => {
    const archive = gzipSync(
      tar([
        { name: `${TOP}/`, type: "5" },
        { name: `${TOP}/huge.bin`, size: 600 * MIB },
      ]),
    );
    expect(archive.length).toBeLessThan(4096);
    const failure = await failedJob(archive);
    expect(failure.code).toBe("LIMIT_SIZE");
    expect(failure.retriable).toBe(false);
    await expectStoppedBeforeAnalysis();
  });
});

describe("symlink-escape: links never lead outside the job (T2)", () => {
  const CANARY = "gi-canary-symlink-3f9a";

  /** A folder outside the jobs root with a secret the repo would like to read. */
  async function plantCanary(): Promise<string> {
    const canary = join(root, "canary");
    await mkdir(canary);
    await writeFile(join(canary, "secret.ts"), `export const CANARY = "${CANARY}";\n`);
    return canary;
  }

  it("skips symlinks and hard links, writes nothing through them, and leaks nothing", async () => {
    const canary = await plantCanary();
    // src is <root>/jobs/<id>-<random>/src, so ../../../canary is the canary folder.
    const entries: TestEntry[] = [
      { name: "etc", type: "2", linkname: "/etc" },
      { name: "hard.ts", type: "1", linkname: "../../../canary/secret.ts" },
      { name: "leak.ts", type: "2", linkname: "../../../canary/secret.ts" },
      { name: "outside", type: "2", linkname: "../../../canary" },
      { name: "up", type: "2", linkname: "../../.." },
      { name: "outside/payload.ts", body: "export const viaOutside = 1;\n" },
      { name: "up/payload.ts", body: "export const viaUp = 1;\n" },
      { name: "etc/passwd", body: "not really\n" },
      {
        name: "src/index.ts",
        body: 'import { CANARY } from "../leak";\nimport { other } from "../hard";\nexport const shown = [CANARY, other];\n',
      },
    ];
    const { outcome, graph, text, src } = await job(tarballFrom(entries, TOP));

    expect(outcome.extract.skippedSample).toEqual([
      { path: "etc", reason: "SYMLINK" },
      { path: "hard.ts", reason: "HARDLINK" },
      { path: "leak.ts", reason: "SYMLINK" },
      { path: "outside", reason: "SYMLINK" },
      { path: "up", reason: "SYMLINK" },
    ]);
    // The later files landed in real folders inside src, not where the links pointed.
    expect(src).toEqual([
      "etc/",
      "etc/passwd",
      "outside/",
      "outside/payload.ts",
      "src/",
      "src/index.ts",
      "up/",
      "up/payload.ts",
    ]);
    expect(await listing(canary)).toEqual(["secret.ts"]);
    expect(await listing(root)).toEqual(["canary/", "canary/secret.ts", "jobs/"]);
    expect(text).not.toContain(CANARY);
    expect(filePaths(graph)).toEqual(["outside/payload.ts", "src/index.ts", "up/payload.ts"]);
    expectOnlyTheSandboxedChild();
  });

  it("doesn't follow a link that is already on disk (defense in depth behind the extractor)", async () => {
    const canary = await plantCanary();
    const dir = join(root, "planted");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "index.ts"), "export const a = 1;\n");
    // A junction on Windows (no privilege needed), a directory symlink elsewhere.
    await symlink(canary, join(dir, "src", "linked"), "junction");
    const out = join(dir, "architecture.json");

    const result = await runAnalysis(
      { src: join(dir, "src"), out, owner: "acme", name: "shop", sha: SHA },
      { scriptsDir: DIST },
    );

    expect(result.ok).toBe(true);
    const text = await readFile(out, "utf8");
    const graph = JSON.parse(text) as Graph;
    expect(graph.warnings).toContainEqual(
      expect.objectContaining({ code: "SKIPPED_SYMLINK", file: "linked" }),
    );
    expect(filePaths(graph)).toEqual(["index.ts"]);
    expect(text).not.toContain(CANARY);
  });
});

describe("path-traversal-tar: an escaping path fails the job (T2)", () => {
  /** An absolute archive path naming `<root>/escape.ts` (on Windows, on the current drive). */
  const absolute = (): string =>
    `/${root
      .replace(/^[A-Za-z]:/, "")
      .replaceAll("\\", "/")
      .replace(/^\/+/, "")}/escape.ts`;

  const cases: [string, () => TestEntry[]][] = [
    ["a leading ..", () => [{ name: "../escape.ts", body: "x" }]],
    ["a .. right after the top folder", () => [{ name: `${TOP}/../../escape.ts`, body: "x" }]],
    ["a .. in the middle", () => [{ name: `${TOP}/src/../../../../escape.ts`, body: "x" }]],
    ["an absolute path into the test folder", () => [{ name: absolute(), body: "x" }]],
    ["a ustar prefix with ..", () => [{ name: "escape.ts", prefix: `${TOP}/../../..`, body: "x" }]],
    [
      "a pax path with ..",
      () => [
        { name: "PaxHeader", type: "x", body: paxBody({ path: `${TOP}/../../../escape.ts` }) },
        { name: `${TOP}/ok.ts`, body: "x" },
      ],
    ],
    [
      "a GNU long name with ..",
      () => [
        { name: "././@LongLink", type: "L", body: `${TOP}/../../../escape.ts\0` },
        { name: `${TOP}/ok.ts`, body: "x" },
      ],
    ],
    ["a folder entry with ..", () => [{ name: `${TOP}/../../../escape/`, type: "5" }]],
  ];

  for (const [label, entries] of cases) {
    it(`rejects ${label}, writes nothing outside, and leaves no job folder`, async () => {
      const failure = await failedJob(
        raw([{ name: `${TOP}/index.ts`, body: "export const a = 1;\n" }, ...entries()]),
      );
      expect(failure.code).toBe("TAR_UNSAFE_PATH");
      expect(failure.retriable).toBe(false);
      await expectStoppedBeforeAnalysis();
    });
  }
});

describe("zip-bomb: decompressed bytes are counted while streaming (T3)", () => {
  it(
    "fails with LIMIT_SIZE at the real 500 MiB limit, having written only the small file",
    async () => {
      // A valid archive followed by 520 MiB of zeros: about half a megabyte compressed.
      const head = tar([
        { name: `${TOP}/`, type: "5" },
        { name: `${TOP}/index.ts`, body: "export const a = 1;\n" },
      ]);
      async function* bytes(): AsyncGenerator<Buffer> {
        yield head;
        const zeros = Buffer.alloc(MIB);
        for (let i = 0; i < 520; i++) yield zeros;
      }
      const chunks: Buffer[] = [];
      await pipeline(Readable.from(bytes()), createGzip({ level: 9 }), async (source) => {
        for await (const chunk of source as AsyncIterable<Buffer>) chunks.push(chunk);
      });
      const bomb = Buffer.concat(chunks);
      expect(bomb.length).toBeLessThan(MIB);

      const failure = await failedJob(bomb);
      expect(failure.code).toBe("LIMIT_SIZE");
      expect(failure.retriable).toBe(false);
      await expectStoppedBeforeAnalysis();
    },
    SLOW,
  );
});

describe("deep-nesting: depth and path-length limits (T3)", () => {
  it("analyzes down to 64 folders, skips deeper ones and over-long paths, and says so", async () => {
    const at = (depth: number): string => Array.from({ length: depth }, () => "d").join("/");
    const tooLong = `${"abcdefgh/".repeat(460)}x.ts`;
    expect(Buffer.byteLength(tooLong)).toBeGreaterThan(4096);
    const { outcome, graph, src } = await job(
      raw([
        { name: `${TOP}/index.ts`, body: "export const top = 1;\n" },
        ...longFile(`${at(64)}/kept.ts`, "export const kept = 1;\n"),
        ...longFile(`${at(80)}/deep.ts`, "export const deep = 1;\n"),
        ...longFile(tooLong, "export const long = 1;\n"),
      ]),
    );

    // Listed cut to 512 characters, so a crafted name can't bloat the stored result (ADR-0079).
    expect(outcome.extract.skippedSample).toEqual([
      { path: `${tooLong.slice(0, SKIPPED_PATH_MAX_CHARS)}…`, reason: "UNSUPPORTED_NAME" },
    ]);
    expect(src.filter((p) => !p.endsWith("/"))).toEqual(
      [`${at(80)}/deep.ts`, `${at(64)}/kept.ts`, "index.ts"].sort(compareStrings),
    );
    expect(graph.warnings).toContainEqual(
      expect.objectContaining({ code: "SKIPPED_DEPTH", file: at(65) }),
    );
    expect(filePaths(graph)).toEqual([`${at(64)}/kept.ts`, "index.ts"]);
    expectOnlyTheSandboxedChild();
  });
});

describe("too-many-files: file and entry limits (T3)", () => {
  it(
    "fails with the analyzer's LIMIT_FILES on 20,001 source files",
    async () => {
      const entries: TestEntry[] = Array.from({ length: 20_001 }, (_, i) => ({
        name: `src/m${i % 20}/f${i}.ts`,
        body: `export const v${i} = ${i};\n`,
      }));
      const failure = await failedJob(tarballFrom(entries, TOP));
      expect(failure.code).toBe("LIMIT_FILES");
      expect(failure.retriable).toBe(false);
      expectOnlyTheSandboxedChild();
      expect(await listing(root)).toEqual(["jobs/"]);
    },
    SLOW,
  );

  it(
    "fails with LIMIT_ENTRIES past 100,000 entries, even ones it wouldn't write",
    async () => {
      const links: TestEntry[] = Array.from({ length: 100_001 }, (_, i) => ({
        name: `l${i}`,
        type: "2",
        linkname: "/etc/passwd",
      }));
      const failure = await failedJob(tarballFrom(links, TOP));
      expect(failure.code).toBe("LIMIT_ENTRIES");
      expect(failure.retriable).toBe(false);
      await expectStoppedBeforeAnalysis();
    },
    SLOW,
  );
});

describe("secrets never reach the stored graph (T5)", () => {
  it("keeps fake-secrets' planted values and the worker's own secrets out of the graph", async () => {
    // The worker's environment holds real secrets in production; the child gets none.
    vi.stubEnv("SNAPSHOTS_SECRET_ACCESS_KEY", "gi-fake-worker-bucket-secret");
    vi.stubEnv("ENQUEUE_HMAC_SECRET", "gi-fake-worker-hmac-secret");
    vi.stubEnv("DATABASE_URL", "postgresql://worker:gi-fake-worker-db@db.internal/gitinside");
    vi.stubEnv("GITHUB_TOKEN", "gi_fake_worker_github_token");
    const { graph, text } = await job(
      tarballFrom(await entriesOf(join(FIXTURES, "fake-secrets")), TOP),
    );

    expect(text).not.toMatch(/gi[_-]fake/i);
    expect(text).not.toContain("hooks.example.com");
    expect(text).not.toContain("db.internal");
    // Not empty because detection failed: the env and compose detectors found their stores.
    expect(graph.nodes.filter((n) => n.kind === "datastore").length).toBeGreaterThan(0);
    expect(graph.nodes.filter((n) => n.kind === "external").length).toBeGreaterThan(0);
    expectOnlyTheSandboxedChild();
  });
});

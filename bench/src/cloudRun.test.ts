import { describe, expect, it } from "vitest";
import {
  CONTAINER_SCRIPT,
  checkTarget,
  cpuLimit,
  dockerRunArgs,
  median,
  parseContainerRun,
  parseCpuStat,
  parseSemiSpaces,
  renderCloudRunReport,
  type CloudRunMeta,
  type ContainerRun,
} from "./cloudRun.js";

const SHA = "2eb48eccd8aca8a0c0ffabf28cf92e298b33ecee";
const TARGET = { owner: "calcom", repo: "cal.diy", sha: SHA };
const MIB = 1024 * 1024;

/** A finished run as the container prints it, with `overrides` on top. */
function printed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    node: "v22.18.0",
    cpu: "AMD EPYC 7763 64-Core Processor",
    hostCores: 4,
    extract: { files: 9000, directories: 1500, tarBytes: 150 * MIB, skipped: 2, ms: 4100 },
    result: {
      ok: true,
      durationMs: 70_000,
      stats: {
        files: 5075,
        nodes: 40_000,
        edges: 90_000,
        unresolved: 300,
        warnings: 12,
        graphBytes: 25 * MIB,
        stageMs: { inventory: 3000, programs: 30_000, calls: 20_000 },
        peakRssBytes: 2200 * MIB,
        heapBytes: 2100 * MIB,
      },
    },
    graphSha256: "a".repeat(64),
    steps: [{ step: "inventory", atMs: 10 }],
    cgroup: {
      cpuMax: "100000 100000",
      cpuStat: "usage_usec 71000000\nuser_usec 65000000\nnr_throttled 700\nthrottled_usec 9000000",
      memoryMax: String(4 * 1024 * MIB),
      memoryPeak: String(2600 * MIB),
    },
    ...overrides,
  };
}

const run = (overrides: Record<string, unknown> = {}, containerMs = 76_000): ContainerRun =>
  parseContainerRun(`${JSON.stringify(printed(overrides))}\n`, containerMs);

const META: CloudRunMeta = {
  date: "2026-11-04",
  target: TARGET,
  gitinsideSha: "abc1234",
  analyzerVersion: "0.2.0",
  host: "GitHub Actions ubuntu-latest",
  image: { compressedBytes: 120e6 },
  download: { compressedBytes: 60 * MIB, ms: 3200 },
  budgetMs: 60_000,
};

describe("checkTarget", () => {
  it("accepts GitHub names and a full SHA", () => {
    expect(checkTarget(TARGET)).toEqual(TARGET);
  });

  it.each([
    [{ ...TARGET, owner: "a b" }, /bad owner/],
    [{ ...TARGET, owner: ".." }, /bad owner/],
    [{ ...TARGET, repo: "x;rm" }, /bad repo/],
    [{ ...TARGET, repo: "" }, /bad repo/],
    [{ ...TARGET, sha: "2eb48ec" }, /bad sha/],
    [{ ...TARGET, sha: SHA.toUpperCase() }, /bad sha/],
  ])("refuses %j", (target, message) => {
    expect(() => checkTarget(target)).toThrow(message);
  });
});

describe("dockerRunArgs", () => {
  const args = dockerRunArgs("img:bench", TARGET);
  const after = (name: string): string | undefined => args[args.indexOf(name) + 1];

  it("starts a fresh container with Cloud Run's instance: 1 vCPU, 4 GiB, no swap, /tmp in memory", () => {
    expect(args.slice(0, 3)).toEqual(["run", "--rm", "--interactive"]);
    expect(after("--cpus")).toBe("1");
    expect(after("--memory")).toBe("4g");
    expect(after("--memory-swap")).toBe("4g");
    expect(after("--mount")).toBe("type=tmpfs,destination=/tmp,tmpfs-mode=1777");
  });

  it("keeps the image's own user and adds no hardening Cloud Run doesn't apply", () => {
    for (const flag of [
      "--user",
      "--read-only",
      "--cap-drop",
      "--privileged",
      "--init",
      "--network",
    ]) {
      expect(args).not.toContain(flag);
    }
  });

  it("runs the container script with the checked target as its argument", () => {
    const image = args.indexOf("img:bench");
    expect(args.slice(image - 2, image)).toEqual(["--entrypoint", "node"]);
    expect(args.slice(image + 1)).toEqual([
      "--input-type=module",
      "-e",
      CONTAINER_SCRIPT,
      JSON.stringify(TARGET),
    ]);
    expect(() => dockerRunArgs("img:bench", { ...TARGET, sha: "x" })).toThrow(/bad sha/);
  });

  it("passes a semi-space cap to the script only when given one (M5.13a5)", () => {
    expect(dockerRunArgs("img:bench", TARGET, 64).slice(-2)).toEqual([
      JSON.stringify(TARGET),
      "64",
    ]);
  });
});

describe("CONTAINER_SCRIPT", () => {
  it("uses the image's own extractor and runner, under /tmp/jobs, with no cache or lifted limits", () => {
    expect(CONTAINER_SCRIPT).toContain('from "./dist/extract.js"');
    expect(CONTAINER_SCRIPT).toContain('from "./dist/runner.js"');
    expect(CONTAINER_SCRIPT).toContain('mkdtemp("/tmp/jobs/bench-")');
    expect(CONTAINER_SCRIPT).toContain("extractTarball(process.stdin, src)");
    // Production's caps: only a semi-space cap may be passed on (M5.13a5).
    expect(CONTAINER_SCRIPT).not.toMatch(/timeoutMs|maxHeapMb|cache:/);
    expect(CONTAINER_SCRIPT).toContain("limits: { semiSpaceMb }");
    expect(CONTAINER_SCRIPT).toContain('cgroup("memory.peak")');
  });
});

describe("parseContainerRun", () => {
  it("reads the last line and adds the outside wall clock", () => {
    const parsed = parseContainerRun(`noise\n${JSON.stringify(printed())}\n\n`, 76_000);
    expect(parsed.containerMs).toBe(76_000);
    expect(parsed.result.ok && parsed.result.stats.stageMs.programs).toBe(30_000);
  });

  it("accepts a failed run with its code", () => {
    const failed = run({
      result: { ok: false, code: "LIMIT_TIME", message: "m", durationMs: 300_000, stderrTail: "" },
      graphSha256: null,
    });
    expect(failed.result.ok).toBe(false);
  });

  it.each([
    ["not JSON", "oops", /isn't JSON/],
    ["an array", "[1]", /isn't an object/],
    ["no machine", JSON.stringify(printed({ hostCores: "4" })), /no machine/],
    ["no extraction", JSON.stringify(printed({ extract: { files: 1 } })), /no extraction/],
    ["no result", JSON.stringify(printed({ result: { ok: true } })), /no result/],
    [
      "bad stage times",
      JSON.stringify(
        printed({ result: { ok: true, durationMs: 1, stats: { stageMs: { a: -1 } } } }),
      ),
      /no stage times/,
    ],
    [
      "a failure without a code",
      JSON.stringify(printed({ result: { ok: false, durationMs: 1 } })),
      /without a code/,
    ],
    ["a bad semi-space", JSON.stringify(printed({ semiSpaceMb: "64" })), /bad semi-space/],
    [
      "bad collector pauses",
      JSON.stringify(
        printed({
          result: { ok: true, durationMs: 1, stats: { stageMs: {}, gcMs: { minor: -1 } } },
        }),
      ),
      /bad collector pauses/,
    ],
    ["a bad hash", JSON.stringify(printed({ graphSha256: 1 })), /bad graph hash/],
    ["bad steps", JSON.stringify(printed({ steps: [{ step: 1, atMs: 0 }] })), /bad steps/],
    ["no cgroup", JSON.stringify(printed({ cgroup: { cpuMax: 1 } })), /no cgroup/],
  ])("refuses %s", (_, stdout, message) => {
    expect(() => parseContainerRun(stdout, 1)).toThrow(message);
  });
});

describe("cgroup readings", () => {
  it("parses cpu.stat lines, skipping anything that isn't a count", () => {
    expect(parseCpuStat("usage_usec 10\nnr_throttled 2\nbad x\n\n")).toEqual({
      usage_usec: 10,
      nr_throttled: 2,
    });
    expect(parseCpuStat(null)).toEqual({});
  });

  it("reads cpu.max as vCPUs", () => {
    expect(cpuLimit("100000 100000")).toBe(1);
    expect(cpuLimit("50000 100000")).toBe(0.5);
    expect(cpuLimit("max 100000")).toBeNull();
    expect(cpuLimit(null)).toBeNull();
  });
});

describe("median", () => {
  it("takes the middle, or the mean of the two middle values", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("renderCloudRunReport", () => {
  const stageTimes = (programs: number): Record<string, unknown> => ({
    result: {
      ...(printed().result as Record<string, unknown>),
      durationMs: programs + 40_000,
      stats: {
        ...(printed().result as { stats: Record<string, unknown> }).stats,
        stageMs: { inventory: 3000, programs, calls: 20_000 },
      },
    },
  });
  const runs = [run(stageTimes(30_000)), run(stageTimes(10_000)), run(stageTimes(20_000))];
  const report = renderCloudRunReport(META, runs);

  it("says what ran, where, and how", () => {
    expect(report).toContain("# 1-vCPU analysis benchmark: calcom/cal.diy (2026-11-04)");
    expect(report).toContain(`https://github.com/calcom/cal.diy at \`${SHA}\``);
    expect(report).toContain("0.2.0 (gitinside `abc1234`)");
    expect(report).toContain("started 3 times, a fresh container per run");
    expect(report).toContain("`docker run --cpus 1 --memory 4g --memory-swap 4g`");
    expect(report).toContain(
      "GitHub Actions ubuntu-latest: AMD EPYC 7763 64-Core Processor (4 host cores; the container's cgroup allows 1 vCPU), Node v22.18.0",
    );
    expect(report).toContain("- **Graphs identical across runs:** yes");
  });

  it("prints each run's readings as measured", () => {
    expect(report).toContain(
      "| 1 | default | 76.0 s | 4.1 s | 70.0 s | n/a | 2,200 MiB | 2,100 MiB | 2,600 MiB | 71.0 s | 9.0 s |",
    );
  });

  it("gives each stage per run with its median, and the median analysis against the budget", () => {
    expect(report).toContain("| programs | 30.0 s | 10.0 s | 20.0 s | 20.0 s |");
    expect(report).toContain("| calls | 20.0 s | 20.0 s | 20.0 s | 20.0 s |");
    expect(report).toContain(
      "**Median analysis: 60.0 s** over 3 finished runs, against DESIGN.md §9's ≤ 60.0 s for a 5k-file repo: within.",
    );
    const slow = renderCloudRunReport(META, [run(stageTimes(50_000))]);
    expect(slow).toContain("**Median analysis: 90.0 s** over 1 finished run");
    expect(slow).toContain("**30.0 s over**");
    expect(slow).not.toContain("Graphs identical");
  });

  it("flags differing graphs and shows a failed run without a median from it", () => {
    const failed = run({
      result: { ok: false, code: "LIMIT_MEMORY", message: "m", durationMs: 50_000, stderrTail: "" },
      graphSha256: null,
      cgroup: { cpuMax: "max 100000", cpuStat: null, memoryMax: null, memoryPeak: null },
    });
    const other = run({ graphSha256: "b".repeat(64) });
    const mixed = renderCloudRunReport(META, [runs[0] as ContainerRun, other, failed]);
    expect(mixed).toContain("- **Graphs identical across runs:** **NO**");
    expect(mixed).toContain(
      "| 3 | default | 76.0 s | 4.1 s | **LIMIT_MEMORY** after 50.0 s | n/a | n/a | n/a | n/a | n/a | n/a |",
    );
    expect(mixed).toContain("allows 1 vCPU / unlimited");
    expect(mixed).toContain("over 2 finished runs");
    expect(renderCloudRunReport(META, [failed])).toContain(
      "No run finished, so there is no median.",
    );
  });

  it("gives collector pauses and, with several semi-space caps, a median per cap (M5.13a5)", () => {
    const capped = (
      semiSpaceMb: number | null,
      durationMs: number,
      minor: number,
    ): ContainerRun => {
      const base = printed().result as { stats: Record<string, unknown> };
      return run({
        semiSpaceMb,
        result: {
          ok: true,
          durationMs,
          stats: { ...base.stats, gcMs: { minor, major: 1000, incremental: 100 } },
        },
      });
    };
    const alternating = [
      capped(null, 60_000, 9000),
      capped(64, 50_000, 3000),
      capped(null, 62_000, 9200),
      capped(64, 52_000, 3400),
    ];
    const report = renderCloudRunReport(META, alternating);
    expect(report).toContain("| 2 | 64 MiB | 76.0 s | 4.1 s | 50.0 s | 4.1 s (3.0 s) |");
    expect(report).toContain(
      "| default | 2 | 61.0 s | **1.0 s over** | 10.2 s (9.1 s) | 2,100 MiB | 2,600 MiB |",
    );
    expect(report).toContain(
      "| 64 MiB | 2 | 51.0 s | within | 4.3 s (3.2 s) | 2,100 MiB | 2,600 MiB |",
    );
    expect(report).not.toContain("**Median analysis:");
    expect(report).toContain("| Stage | Run 1 (default) | Run 2 (64 MiB) |");
  });
});

describe("parseSemiSpaces", () => {
  it("reads caps in MiB and default as V8's own", () => {
    expect(parseSemiSpaces("default")).toEqual([undefined]);
    expect(parseSemiSpaces("default, 32,64")).toEqual([undefined, 32, 64]);
  });

  it.each(["", "0", "257", "1.5", "32;rm", "-1"])("refuses %j", (text) => {
    expect(() => parseSemiSpaces(text)).toThrow(/bad --semi-space/);
  });
});

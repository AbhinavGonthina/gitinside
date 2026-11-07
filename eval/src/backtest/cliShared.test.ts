import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ANALYZER_VERSION } from "@gitinside/analyzer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  namedRepos,
  outDir,
  ownFiles,
  parseLimit,
  takeFlag,
  thisRun,
  writeAtomically,
} from "./cliShared.js";
import { DIRTY_MARK } from "./replay.js";

const pins = [
  { owner: "getmaxun", name: "maxun" },
  { owner: "calcom", name: "cal.diy" },
  { owner: "dubinc", name: "dub.link" },
];

describe("takeFlag", () => {
  it("returns the value after the flag and removes both from the arguments", () => {
    const args = ["a/b", "--out", "eval/dist/x", "c/d"];
    expect(takeFlag(args, "out")).toBe("eval/dist/x");
    expect(args).toEqual(["a/b", "c/d"]);
  });

  it("returns undefined when the flag is absent", () => {
    const args = ["a/b"];
    expect(takeFlag(args, "out")).toBeUndefined();
    expect(args).toEqual(["a/b"]);
  });

  it("refuses a flag with no value or another flag after it", () => {
    expect(() => takeFlag(["--out"], "out")).toThrow("--out needs a value");
    expect(() => takeFlag(["--out", "--limit", "2"], "out")).toThrow("--out needs a value");
  });
});

describe("namedRepos", () => {
  it("takes every pin when no repo is named", () => {
    expect(namedRepos(pins, [])).toEqual(pins);
  });

  it("takes the named pins in pin order, in any case, once each", () => {
    expect(namedRepos(pins, ["DubInc/Dub.Link", "getmaxun/maxun", "getmaxun/maxun"])).toEqual([
      pins[0],
      pins[2],
    ]);
  });

  it("names every repo that isn't pinned", () => {
    expect(() => namedRepos(pins, ["getmaxun/maxun", "a/b", "c/d"])).toThrow(
      "not pinned: a/b, c/d",
    );
  });
});

describe("parseLimit", () => {
  it("reads a whole number of at least 1, and nothing as no limit", () => {
    expect(parseLimit("3")).toBe(3);
    expect(parseLimit(undefined)).toBeUndefined();
  });

  it.each(["0", "-1", "1.5", "x", ""])("refuses %j", (text) => {
    expect(() => parseLimit(text)).toThrow("--limit must be a whole number of at least 1");
  });
});

describe("outDir", () => {
  const root = resolve(tmpdir(), "gitinside-root");

  it("resolves a relative --out from the repo root, not the working directory", () => {
    expect(process.cwd()).not.toBe(root);
    expect(outDir(root, "eval/dist/raw", join(root, "eval", "backtest", "raw"))).toBe(
      join(root, "eval", "dist", "raw"),
    );
  });

  it("keeps an absolute --out, and takes the fallback when there's none", () => {
    const elsewhere = resolve(tmpdir(), "elsewhere");
    expect(outDir(root, elsewhere, join(root, "x"))).toBe(elsewhere);
    expect(outDir(root, undefined, join(root, "eval", "backtest", "raw"))).toBe(
      join(root, "eval", "backtest", "raw"),
    );
  });
});

describe("ownFiles", () => {
  const root = resolve(tmpdir(), "gitinside-root");

  it("lists each repo's file in the folder relative to the root, with forward slashes", () => {
    expect(ownFiles(root, join(root, "eval", "backtest", "raw"), pins.slice(0, 2))).toEqual([
      "eval/backtest/raw/getmaxun__maxun.json",
      "eval/backtest/raw/calcom__cal.diy.json",
    ]);
  });

  it("leaves a folder outside the root outside it", () => {
    expect(ownFiles(root, resolve(root, "..", "out"), [pins[0]!])).toEqual([
      "../out/getmaxun__maxun.json",
    ]);
  });
});

describe("with a scratch folder", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "gitinside-backtest-cli-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("writeAtomically writes the whole file and leaves no temporary file", async () => {
    const file = join(scratch, "a.json");
    await writeFile(file, "old\n");
    await writeAtomically(file, "new\n");
    expect(readFileSync(file, "utf8")).toBe("new\n");
    expect(readdirSync(scratch)).toEqual(["a.json"]);
  });

  it("writeAtomically removes its temporary file when the rename fails", async () => {
    const folder = join(scratch, "a-folder");
    await mkdir(join(folder, "inside"), { recursive: true });
    await expect(writeAtomically(folder, "text")).rejects.toThrow();
    expect(readdirSync(scratch)).toEqual(["a-folder"]);
  });

  it("thisRun records the commit, analyzer, and machine, marking changes besides its own files", async () => {
    const git = (...args: string[]): string =>
      execFileSync("git", ["-C", scratch, ...args], { encoding: "utf8" }).trim();
    git("init", "--quiet", "--initial-branch=main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    git("config", "commit.gpgsign", "false");
    await writeFile(join(scratch, "README.md"), "x\n");
    git("add", "README.md");
    git("commit", "--quiet", "-m", "one");
    const head = git("rev-parse", "HEAD");

    await mkdir(join(scratch, "raw"));
    await writeFile(join(scratch, "raw", "a__b.json"), "{}\n");
    const run = thisRun(scratch, ["raw/a__b.json"]);
    expect(run.gitinside).toBe(head);
    expect(run.analyzerVersion).toBe(ANALYZER_VERSION);
    expect(run.started).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(run.machine.cores).toBeGreaterThan(0);
    expect(run.machine.node).toBe(process.version);

    await writeFile(join(scratch, "README.md"), "changed\n");
    expect(thisRun(scratch, ["raw/a__b.json"]).gitinside).toBe(`${head}${DIRTY_MARK}`);
  });
});

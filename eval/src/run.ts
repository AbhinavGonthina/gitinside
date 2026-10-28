/**
 * `pnpm eval`: check out every pinned repo, analyze it, score the graph against its labels,
 * and write `eval/results/<date>-<analyzerVersion>.md` (docs/EVALUATION.md §1).
 *
 * `pnpm eval --check [report]` regenerates a committed report (the newest one by default)
 * with its recorded run line, and exits 1 unless the bytes are identical. It first refuses
 * when the eval's inputs (analyzer, schema, eval code, labels, lockfile) differ from the
 * commit the report records, since the report would then describe other code.
 *
 * Checkouts live in `eval/.repos/<owner>__<name>` (gitignored). They are only read by the
 * analyzer; nothing in them is installed or executed.
 *
 * Usage: pnpm eval [--label "<machine label>"] | pnpm eval --check [eval/results/<file>.md]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ANALYZER_VERSION, analyze } from "@gitinside/analyzer";
import { compareStrings, type ArchitectureGraph } from "@gitinside/schema";
import { labelFileName, type EvalRepo, type LabelFile } from "./format.js";
import { crossCheck, loadEvalInputs } from "./inputs.js";
import {
  DIRTY_MARK,
  firstDifference,
  parseRun,
  renderReport,
  reportFileName,
  type ReportRun,
} from "./report.js";
import { scoreAll } from "./score.js";

const EVAL = fileURLToPath(new URL("../", import.meta.url));
const ROOT = resolve(EVAL, "..");
const RESULTS = join(EVAL, "results");

/** Everything the scores depend on. Reports themselves are excluded. */
const INPUT_PATHS = [
  "eval",
  ":(exclude)eval/results",
  "packages/analyzer",
  "packages/schema",
  "pnpm-lock.yaml",
];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

/**
 * Git for the checkouts: LFS smudging and line-ending conversion off, so a checkout never
 * downloads or runs anything extra and has the same bytes on every OS.
 */
function checkoutGit(cwd: string, args: string[]): string {
  const config = ["filter.lfs.smudge=", "filter.lfs.required=false", "core.autocrlf=false"];
  return git(cwd, [...config.flatMap((c) => ["-c", c]), ...args]);
}

/** Shallow-fetch exactly `repo.sha` into `eval/.repos/<owner>__<name>`, reusing a checkout. */
function checkout(repo: EvalRepo): string {
  const dir = join(EVAL, ".repos", `${repo.owner}__${repo.name}`);
  if (existsSync(join(dir, ".git")) && checkoutGit(dir, ["rev-parse", "HEAD"]) === repo.sha) {
    return dir;
  }
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, ".git"))) {
    checkoutGit(dir, ["init", "--quiet"]);
    checkoutGit(dir, ["remote", "add", "origin", repo.url]);
  }
  checkoutGit(dir, ["fetch", "--quiet", "--depth", "1", "origin", repo.sha]);
  checkoutGit(dir, ["checkout", "--quiet", "--detach", "--force", "FETCH_HEAD"]);
  return dir;
}

/** This machine in one line; `label` says which one it is (dev machine, Oracle VM). */
function machine(label: string): string {
  const cpu = cpus();
  const ram = Math.round((totalmem() / 1024 ** 3) * 10) / 10;
  return `${label}: ${cpu[0]?.model.trim() ?? "unknown CPU"} (${cpu.length} logical cores), ${ram} GiB RAM, ${platform()} ${release()}, Node ${process.version}`;
}

/** Today's local date as YYYY-MM-DD. Reports are dated; graphs never are. */
function today(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The value after `flag`, `undefined` when absent, `""` when it's last or another flag. */
function option(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  if (at < 0) return undefined;
  const value = process.argv[at + 1] ?? "";
  return value.startsWith("--") ? "" : value;
}

/** The newest committed report, by its dated file name. */
function newestReport(): string {
  const files = existsSync(RESULTS)
    ? readdirSync(RESULTS)
        .filter((f) => f.endsWith(".md"))
        .sort(compareStrings)
    : [];
  const last = files.at(-1);
  if (!last) throw new Error("no report in eval/results/ to check; run `pnpm eval` first");
  return join(RESULTS, last);
}

/** Fail unless the eval's inputs in the working tree are exactly those of `sha`. */
function assertInputsAt(sha: string): void {
  const changed = git(ROOT, ["diff", "--name-only", sha, "--", ...INPUT_PATHS]);
  const untracked = git(ROOT, ["ls-files", "--others", "--exclude-standard", "--", ...INPUT_PATHS]);
  const files = [changed, untracked].filter((s) => s !== "").join("\n");
  if (files !== "") {
    throw new Error(
      `the eval's inputs changed since ${sha}, so this report describes other code:\n${files}\nRun \`pnpm eval\` for a new report.`,
    );
  }
}

async function main(): Promise<void> {
  const check = option("--check");
  const inputs = loadEvalInputs(EVAL);
  const problems = crossCheck(inputs);
  const labelled: { repo: EvalRepo; labels: LabelFile }[] = [];
  for (const repo of inputs.repos) {
    const labels = inputs.labels.get(labelFileName(repo.owner, repo.name));
    if (labels) labelled.push({ repo, labels });
    else problems.push(`${repo.owner}/${repo.name} has no label file`);
  }
  if (problems.length > 0) throw new Error(`eval inputs:\n  - ${problems.join("\n  - ")}`);

  let run: ReportRun;
  let reportPath: string;
  let committed: string | undefined;
  if (check !== undefined) {
    reportPath = check === "" ? newestReport() : resolve(check);
    committed = readFileSync(reportPath, "utf8");
    run = parseRun(committed);
    if (run.gitinsideSha.endsWith(DIRTY_MARK)) {
      throw new Error("this report was produced from uncommitted changes, so it can't be checked");
    }
    assertInputsAt(run.gitinsideSha);
  } else {
    const head = git(ROOT, ["rev-parse", "HEAD"]);
    const dirty = git(ROOT, ["status", "--porcelain", "--", ...INPUT_PATHS]) !== "";
    run = {
      date: today(),
      gitinsideSha: `${head}${dirty ? DIRTY_MARK : ""}`,
      analyzerVersion: ANALYZER_VERSION,
      machine: machine(option("--label") || "dev machine"),
    };
    reportPath = join(RESULTS, reportFileName(run));
  }

  const runs: { labels: LabelFile; graph: ArchitectureGraph }[] = [];
  for (const { repo, labels } of labelled) {
    process.stderr.write(`${repo.owner}/${repo.name}: checking out ${repo.sha}\n`);
    const dir = checkout(repo);
    const graph = await analyze(dir, { owner: repo.owner, name: repo.name, sha: repo.sha });
    process.stderr.write(
      `${repo.owner}/${repo.name}: ${graph.nodes.length} nodes, ${graph.edges.length} edges\n`,
    );
    runs.push({ labels, graph });
  }
  const score = scoreAll(runs);
  const text = renderReport({
    run,
    repos: labelled.map((l) => l.repo),
    labels: labelled.map((l) => l.labels),
    score,
  });
  const shown = relative(ROOT, reportPath).replaceAll("\\", "/");

  if (committed !== undefined) {
    const diff = firstDifference(committed, text);
    if (diff) {
      process.stderr.write(
        `${shown} is NOT reproduced. First difference at line ${diff.line}:\n` +
          `  committed:   ${diff.expected}\n  regenerated: ${diff.actual}\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`${shown} reproduced byte-for-byte\n`);
    return;
  }
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(reportPath, text);
  const o = score.overall;
  process.stdout.write(
    `wrote ${shown}: TP ${o.truePositives}, FP ${o.falsePositives}, FN ${o.falseNegatives} over ${o.labels} labels\n`,
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

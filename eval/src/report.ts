/**
 * Renders the committed accuracy report, `eval/results/<date>-<analyzerVersion>.md`
 * (docs/EVALUATION.md §1 "Report"). Pure: the same inputs, score, and run record always give
 * the same bytes, which is what lets `pnpm eval --check` reproduce a committed report.
 *
 * The run record (date, GitInside commit, machine) is the only part that isn't a function of
 * the pinned inputs. `--check` reads it back from the committed report with {@link parseRun}
 * and regenerates everything else.
 */
import { resolve } from "node:path";
import { compareStrings, type SourceLocation } from "@gitinside/schema";
import type { EvalRepo, LabeledEdge, LabelFile, SourcePoint } from "./format.js";
import {
  SCORED_LEVELS,
  type Counts,
  type EvalScore,
  type FalseNegative,
  type FalsePositive,
  type RepoScore,
} from "./score.js";

/** Where and when a report was produced. */
export interface ReportRun {
  /** Local date of the run, `YYYY-MM-DD`. */
  date: string;
  /** GitInside commit the analyzer ran from, plus ` + uncommitted changes` when dirty. */
  gitinsideSha: string;
  analyzerVersion: string;
  /** One line: label, CPU, cores, RAM, OS, Node. */
  machine: string;
}

/** One scored set of repos: the original set, or the held-out one. */
export interface ReportSet {
  /** The pinned repos, in `repos.json` order. */
  repos: readonly EvalRepo[];
  /** One label file per pinned repo. */
  labels: readonly LabelFile[];
  score: EvalScore;
}

/** One held-out batch (#13, ADR-0168), scored as a set of its own. */
export interface HeldOutSet extends ReportSet {
  batch: number;
  /** Why the batch counts as seen (`repos.json`), or `null` while it is unseen. */
  seen: string | null;
}

/** Everything a report is rendered from: the original set, plus the held-out batches. */
export interface ReportInput extends ReportSet {
  run: ReportRun;
  /**
   * Held-out batches in number order, each scored apart: their counts never enter the headline,
   * the original set's totals, or another batch's. Omitted (or all empty) when there are none,
   * and the report is then the same bytes as before held-out repos existed.
   */
  heldOut?: readonly HeldOutSet[];
}

/** Marks a run whose tree had changes to the eval's inputs; such a report can't be checked. */
export const DIRTY_MARK = " + uncommitted changes";

/** Thrown when a committed report can't be read back. */
export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportError";
  }
}

/** The report's file name: `<date>-<analyzerVersion>.md`. */
export function reportFileName(run: Pick<ReportRun, "date" | "analyzerVersion">): string {
  return `${run.date}-${run.analyzerVersion}.md`;
}

const REPORT_NAME = /^(\d{4}-\d{2}-\d{2})-(\d+)\.(\d+)\.(\d+)(.*)\.md$/;

/**
 * Order report file names by date, then analyzer version numerically (`0.9.0` before
 * `0.10.0`); names that don't parse sort first, by plain string order.
 */
export function compareReportNames(a: string, b: string): number {
  const ma = REPORT_NAME.exec(a);
  const mb = REPORT_NAME.exec(b);
  if (!ma || !mb) return (ma ? 1 : 0) - (mb ? 1 : 0) || compareStrings(a, b);
  return (
    compareStrings(ma[1] ?? "", mb[1] ?? "") ||
    Number(ma[2]) - Number(mb[2]) ||
    Number(ma[3]) - Number(mb[3]) ||
    Number(ma[4]) - Number(mb[4]) ||
    compareStrings(a, b)
  );
}

/**
 * The report a `--check <arg>` names, resolved against the folder the user ran `pnpm` from
 * (`INIT_CWD`), not the eval package pnpm runs the script in.
 */
export function resolveReportArg(arg: string, invokedFrom: string): string {
  return resolve(invokedFrom, arg);
}

/** `n/d` as a percentage with one decimal plus the raw fraction, or `n/a` when `d` is 0. */
export function percent(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}% (${n}/${d})`;
}

/** Precision and recall of `c` as report cells (same denominators as score.ts). */
function rates(c: Counts): [string, string] {
  return [
    percent(c.truePositives, c.truePositives + c.falsePositives),
    percent(c.truePositives, c.positiveLabels),
  ];
}

/** `file:line`, plus `:column` when known. */
function at(p: SourcePoint | SourceLocation): string {
  return p.column === undefined ? `${p.file}:${p.line}` : `${p.file}:${p.line}:${p.column}`;
}

function code(text: string): string {
  return `\`${text}\``;
}

/** A labeled target in words. */
function target(t: LabeledEdge["target"]): string {
  return t === null ? "no route in the repo (`null`)" : `${code(t.route)} in ${code(at(t))}`;
}

const FP_KIND: Record<FalsePositive["kind"], string> = {
  "wrong-route": "wrong route",
  "route-for-null-label": "route where the label says none",
  "unlabeled-site": "unlabeled call site",
};

function falsePositive(fp: FalsePositive): string {
  const why = fp.reason ? `, ${fp.reason}` : "";
  const expected =
    fp.expected.length === 0 ? "" : `; labeled: ${fp.expected.map(target).join(", ")}`;
  return (
    `- ${code(at(fp.site))}: predicted ${code(fp.predicted.route)} in ` +
    `${code(at(fp.predicted))} (${fp.confidence}${why}). ${FP_KIND[fp.kind]}${expected}.`
  );
}

function falseNegative(fn: FalseNegative): string {
  const method = fn.method ?? "runtime method";
  const instead =
    fn.predicted.length === 0
      ? "nothing predicted at the site"
      : `predicted instead: ${fn.predicted.map(code).join(", ")}`;
  return `- ${code(at(fn.callSite))} (${method}): expected ${target(fn.expected)}; ${instead}.`;
}

function missing(label: LabeledEdge): string {
  return `- ${code(at(label.callSite))} (${label.method ?? "runtime method"}): labeled ${target(label.target)}.`;
}

/** A Markdown list under a bold heading, or "none". */
function list<T>(title: string, items: readonly T[], line: (item: T) => string): string[] {
  return [
    `**${title} (${items.length})**`,
    "",
    ...(items.length ? items.map(line) : ["None."]),
    "",
  ];
}

function countsRow(name: string, c: Counts): string {
  const [p, r] = rates(c);
  return (
    `| ${name} | ${c.labels} | ${c.positiveLabels} | ${c.truePositives} | ${c.falsePositives} | ` +
    `${c.falseNegatives} | ${p} | ${r} | ${c.nullLabels} | ${c.abstentions} | ${c.missing} |`
  );
}

const COUNT_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** A small count in words (`five`), larger ones as digits. */
function count(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

/** Who wrote the label files, as a past participle phrase ("drafted by Claude"). */
function labelAuthor(labels: readonly LabelFile[]): string {
  const claude = labels.some((l) => l.labeler === "claude-draft");
  const abhinav = labels.some((l) => l.labeler === "abhinav");
  if (claude && abhinav) return "drafted by Claude or written by Abhinav (see each label file)";
  return abhinav ? "written by Abhinav" : "drafted by Claude";
}

/** Render the Markdown report. Every number is printed as counted, with its raw fraction. */
export function renderReport(input: ReportInput): string {
  const { run, repos, score } = input;
  const scored = pairUp(input);
  const heldOut = (input.heldOut ?? []).filter((b) => b.repos.length > 0);
  // Who labeled and whether review is pending cover every label file the report scores.
  const labels = [...input.labels, ...heldOut.flatMap((b) => b.labels)];

  const reviewers = [...new Set(labels.map((l) => l.reviewedBy))];
  const pending = reviewers.includes(null);
  const author = labelAuthor(labels);
  const status = pending
    ? `> **Pending owner review.** The labels were ${author} from reading each repo's code, without looking at analyzer output. Abhinav's review of a seeded random 20% of call sites is not done yet, so these numbers may change.`
    : `> **Labels reviewed** by ${reviewers.map((r) => code(r ?? "")).join(", ")} (a seeded random 20% of call sites).`;
  const whoLabeled = labels.every((l) => l.labeler === "abhinav")
    ? "- **Who labeled:** Abhinav wrote the labels from the code alone and committed them before scoring."
    : pending
      ? "- **Who labeled:** Claude drafted the labels and also wrote the analyzer. The labels were written from the code alone and committed before scoring, but until the owner review is done they are one reader's judgment."
      : "- **Who labeled:** Claude drafted the labels and also wrote the analyzer. They were written from the code alone and committed before scoring; the owner reviewed a seeded random 20% of call sites, and the rest are still one reader's judgment.";

  const o = score.overall;
  const lines = [
    `# Cross-service accuracy: ${run.date}, analyzer ${run.analyzerVersion}`,
    "",
    status,
    "",
    "## Run",
    "",
    `- **Date:** ${run.date}`,
    `- **GitInside commit:** ${code(run.gitinsideSha)}`,
    `- **Analyzer version:** ${run.analyzerVersion}`,
    `- **Machine:** ${run.machine}`,
    "",
    "The analyzer is deterministic, so the scores don't depend on the machine; it is recorded because EVALUATION.md asks every result to say where it ran.",
    "",
    "## Repos",
    "",
    ...reposTable(scored),
    "## Results",
    "",
    `Precision ${rates(o)[0]}, recall ${rates(o)[1]} over ${o.labels} labels in ${repos.length} repos.`,
    "",
    ...countsTable(scored, o, "**All repos**"),
    "- **TP / FP / FN:** route predictions that match a label / that match none / labeled real targets never predicted.",
    "- **Abstentions:** `null`-labeled call sites (no route in the repo) where the analyzer predicted only an unresolved node or an external host. Correct, but not part of precision.",
    "- **Missing:** labels with no prediction of any kind at their call site: the request was dropped, or the analyzer placed it at another site (for example inside a helper whose callers the label names).",
    "",
    "### By confidence level",
    "",
    "Recall per level is that level's true positives over all real targets, so the levels add up to the overall recall.",
    "",
    ...levelsTable(o),
    "## Misses, by repo",
    "",
    ...scored.flatMap(({ score: s }) => repoDetails(s, "###")),
    ...heldOut.flatMap(heldOutSection),
    "## Method",
    "",
    "Full rules: [docs/EVALUATION.md §1](../../docs/EVALUATION.md) and ADR-0040 to ADR-0042 in [docs/DECISIONS.md](../../docs/DECISIONS.md).",
    "",
    "- Each repo is checked out at its pinned commit and analyzed with `analyze()`; nothing in it is installed or run.",
    "- **Ground truth:** every `fetch`/axios request written in the repo's own TS/JS code, labeled at the call that fixes its route with the route it really reaches (or `null` when none in the repo), drafted from reading the code and committed before the first scoring run.",
    "- **Predictions:** every site of an `http` edge to a route, or to an unresolved node, and of an `external_call` edge. Predictions outside a label file's scope are not scored.",
    "- **Matching:** call site (file + line, plus column when labeled) and route (registering file + method + path, parameter names ignored). Route lines are not compared.",
    "",
    "## Limitations",
    "",
    `- **Small set:** ${count(repos.length)} small and mid-size ${repos.length === 1 ? "app" : "apps"} (about 100–300 source files), mostly hobby or reference projects. The numbers say nothing about large production monorepos.`,
    ...(heldOut.length > 0 ? [heldOutLimitation(heldOut)] : []),
    whoLabeled,
    "- **What isn't counted:** requests made inside third-party libraries (SDK clients, NextAuth, MCP transports), sockets, `<a href>`/`window.location` navigations, and inline HTML scripts are not labeled, so they can't count against recall.",
    "- **Precision covers routes only:** abstentions are reported apart, so a tool that abstained everywhere would show `n/a` precision, not 100%.",
    "- **Lenient route comparison:** parameter names and route lines are ignored; a route in the right file with the right method and path shape counts.",
    "",
    "## Reproduce",
    "",
    "```sh",
    "pnpm eval                          # analyze the pinned commits, write eval/results/<date>-<version>.md",
    `pnpm eval --check eval/results/${reportFileName(run)}   # regenerate this report and compare byte-for-byte`,
    "```",
    "",
    "`--check` reuses this report's run record (date, commit, machine) and fails if the analyzer, schema, eval code, labels, or lockfile changed since that commit.",
    "",
  ];
  return lines.join("\n");
}

interface ScoredRepo {
  repo: EvalRepo;
  score: RepoScore;
  labels: LabelFile;
}

/** Each pinned repo of `set` with its score and labels, in `repos.json` order. */
function pairUp(set: ReportSet): ScoredRepo[] {
  const byRepo = new Map(set.score.repos.map((r) => [r.repo.toLowerCase(), r]));
  const labelsByRepo = new Map(set.labels.map((l) => [l.repo.toLowerCase(), l]));
  return set.repos.map((r) => {
    const key = `${r.owner}/${r.name}`.toLowerCase();
    const s = byRepo.get(key);
    const l = labelsByRepo.get(key);
    if (!s || !l) throw new ReportError(`no score or labels for ${r.owner}/${r.name}`);
    return { repo: r, score: s, labels: l };
  });
}

function reposTable(scored: readonly ScoredRepo[]): string[] {
  return [
    "| Repo | Shape | Commit | License | Call sites | Labels |",
    "|---|---|---|---|---:|---:|",
    ...scored.map(({ repo, labels: l }) => {
      const sites = new Set(l.edges.map((e) => at(e.callSite))).size;
      return `| [${repo.owner}/${repo.name}](${repo.url}) | ${repo.shape} | ${code(repo.sha)} | ${repo.license} | ${sites} | ${l.edges.length} |`;
    }),
    "",
  ];
}

function countsTable(scored: readonly ScoredRepo[], total: Counts, totalName: string): string[] {
  return [
    "| Repo | Labels | Real targets | TP | FP | FN | Precision | Recall | `null` labels | Abstentions | Missing |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...scored.map(({ score: s }) => countsRow(s.repo, s.counts)),
    countsRow(totalName, total),
    "",
  ];
}

function levelsTable(total: Counts): string[] {
  return [
    "| Level | TP | FP | Precision | Recall |",
    "|---|---:|---:|---:|---:|",
    ...SCORED_LEVELS.map((level) => {
      const c = total.byConfidence[level];
      return `| ${level} | ${c.truePositives} | ${c.falsePositives} | ${percent(c.truePositives, c.truePositives + c.falsePositives)} | ${percent(c.truePositives, total.positiveLabels)} |`;
    }),
    "",
  ];
}

/** `n app(s)` in words. */
function apps(n: number): string {
  return `${count(n)} ${n === 1 ? "app" : "apps"}`;
}

/** The limitations bullet for the held-out batches: how many, how big, which are seen. */
function heldOutLimitation(batches: readonly HeldOutSet[]): string {
  const each = batches
    .map(
      (b) => `batch ${b.batch} (${apps(b.repos.length)}, ${b.seen === null ? "unseen" : "seen"})`,
    )
    .join(", ");
  const none = batches.every((b) => b.seen !== null)
    ? ", and none is unseen now: that needs a fresh batch"
    : "";
  return `- **Held-out batches:** ${each}, picked and labeled after the recall work began to test whether fixes made for the original set generalize. Only an unseen batch still tests that${none}. They are just as small, and their labels are not in the owner's review sample.`;
}

/** One held-out batch (#13, ADR-0168) in a section of its own, with its own totals. */
function heldOutSection(set: HeldOutSet): string[] {
  const scored = pairUp(set);
  const o = set.score.overall;
  const n = set.batch;
  const status =
    set.seen === null
      ? "**Unseen:** nobody has studied these repos' results while fixing the analyzer, so this batch is the one that tests whether fixes generalize."
      : `**Seen:** ${set.seen} Still scored apart, but no longer evidence that fixes generalize.`;
  return [
    `## Held-out batch ${n} (${set.seen === null ? "unseen" : "seen"})`,
    "",
    "Picked and labeled from their code after the recall work began, never by looking at analyzer output, with the labels committed before the analyzer first ran on them. Scored apart: none of these counts is in the results above or in another batch.",
    "",
    status,
    "",
    ...reposTable(scored),
    `Precision ${rates(o)[0]}, recall ${rates(o)[1]} over ${o.labels} labels in ${set.repos.length} ${set.repos.length === 1 ? "repo" : "repos"} of batch ${n}.`,
    "",
    ...countsTable(scored, o, `**All of batch ${n}**`),
    `### Batch ${n}, by confidence level`,
    "",
    ...levelsTable(o),
    `### Batch ${n} misses, by repo`,
    "",
    ...scored.flatMap(({ score: s }) => repoDetails(s, "####")),
  ];
}

function repoDetails(s: RepoScore, heading: string): string[] {
  // A missing label with a real target is also a false negative ("nothing predicted at the
  // site"), so only the `null` ones are listed again here.
  const dropped = s.missing.filter((l) => l.target === null);
  const repeated = s.missing.length - dropped.length;
  const note =
    repeated === 0
      ? []
      : [
          `${repeated} with a real target ${repeated === 1 ? "is" : "are"} listed above as false negatives ("nothing predicted at the site").${dropped.length ? " The rest:" : ""}`,
          "",
        ];
  return [
    `${heading} ${s.repo}`,
    "",
    ...list("False positives", s.falsePositives, falsePositive),
    ...list("False negatives", s.falseNegatives, falseNegative),
    `**Missing call sites (${s.missing.length})**`,
    "",
    ...note,
    ...(s.missing.length === 0 ? ["None.", ""] : []),
    ...(dropped.length ? [...dropped.map(missing), ""] : []),
  ];
}

/** Read the run record back out of a rendered report. Throws `ReportError` when it's absent. */
export function parseRun(text: string): ReportRun {
  const field = (name: string): string => {
    const match = new RegExp(`^- \\*\\*${name}:\\*\\* (.+)$`, "m").exec(text);
    if (!match?.[1]) throw new ReportError(`report has no "${name}" line in its Run section`);
    return match[1];
  };
  const sha = /^`([^`]+)`$/.exec(field("GitInside commit"));
  if (!sha?.[1]) throw new ReportError("report's GitInside commit is not in backticks");
  return {
    date: field("Date"),
    gitinsideSha: sha[1],
    analyzerVersion: field("Analyzer version"),
    machine: field("Machine"),
  };
}

/** The first line where two texts differ (1-based), or `null` when they are identical. */
export function firstDifference(
  expected: string,
  actual: string,
): { line: number; expected: string; actual: string } | null {
  if (expected === actual) return null;
  const a = expected.split("\n");
  const b = actual.split("\n");
  for (let i = 0; ; i++) {
    if (a[i] !== b[i]) {
      return { line: i + 1, expected: a[i] ?? "<end of file>", actual: b[i] ?? "<end of file>" };
    }
  }
}

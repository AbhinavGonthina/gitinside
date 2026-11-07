/**
 * Renders the PR backtest's report, `eval/backtest/results/<date>.md` (docs/EVALUATION.md §3
 * step 5, ADR-0219). Pure: it reads only the committed backtest files (inputs.ts) and the
 * hand-written limitations, so `backtest:report --check` regenerates a committed report byte
 * for byte, and the report carries no run line of its own: each input file names the run that
 * made it, and the report lists those.
 *
 * - **Dated by its inputs:** the report's date is the newest day any input records (pinned,
 *   listed, replayed, followed up, drafted), never today, so the same files give the same name.
 * - **Complete runs only:** every pinned repo needs its PR file, a raw file that replays all of
 *   its PRs, and a follow-up file; otherwise it refuses rather than report a part.
 * - **Claims as measured:** the claim line counts a break as caught only with a `true` verdict,
 *   says how many verdicts Abhinav reviewed, and counts a fix only when it was judged `real`.
 *   Edge kinds are counted apart, so in-service `calls` breaks never read as cross-service ones.
 *
 * Not handled: the limitations are the hand-written file's words; nothing checks they still
 * describe the inputs, beyond the counts this module adds itself.
 */
import { compareStrings, type BrokenEdge, type DiffSummary } from "@gitinside/schema";
import { classifiedCounts, type ClassifiedBreak, type ClassifiedFile } from "./classify.js";
import type { FollowedBreak, FollowedPr, FollowUpFile } from "./followUp.js";
import type { BacktestRepo } from "./format.js";
import type { BacktestInputs } from "./inputs.js";
import { prsFileName, type PrsFile } from "./prs.js";
import type { RawFile, ReplayRun } from "./replay.js";

/** Thrown when the inputs can't make a complete report. */
export class BacktestReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BacktestReportError";
  }
}

/** One pinned repo with all of its files. */
interface RepoFiles {
  pin: BacktestRepo;
  prs: PrsFile;
  raw: RawFile;
  followUp: FollowUpFile;
  classified: ClassifiedFile | undefined;
}

/** Each pinned repo's files, in `repos.json` order; throws naming every missing or partial one. */
function repoFiles(inputs: BacktestInputs): RepoFiles[] {
  const missing: string[] = [];
  const files = inputs.repos.repos.map((pin) => {
    const f = prsFileName(pin);
    const prs = inputs.prs.find((p) => p.f === f)?.file;
    const raw = inputs.raw.find((r) => r.f === f)?.file;
    const followUp = inputs.followUp.find((u) => u.f === f)?.file;
    const classified = inputs.classified.find((c) => c.f === f)?.file;
    if (!prs) missing.push(`backtest/prs/${f}`);
    if (!raw) missing.push(`backtest/raw/${f}`);
    else if (prs && raw.prs.length < prs.prs.length)
      missing.push(`backtest/raw/${f} (${raw.prs.length} of ${prs.prs.length} PRs replayed)`);
    if (!followUp) missing.push(`backtest/followup/${f}`);
    return { pin, prs, raw, followUp, classified };
  });
  if (missing.length > 0) {
    throw new BacktestReportError(
      `the backtest isn't complete, so there's no report to write:\n  - ${missing.join("\n  - ")}`,
    );
  }
  return files as RepoFiles[];
}

/** The newest day the inputs record: the report's date. */
export function backtestReportDate(inputs: BacktestInputs): string {
  const days = [
    inputs.repos.pinned,
    ...inputs.prs.map((p) => p.file.listed),
    ...inputs.raw.map((r) => r.file.run.started),
    ...inputs.followUp.map((u) => u.file.run.started),
    ...inputs.classified.map((c) => c.file.drafted),
  ];
  return days.sort(compareStrings).at(-1) as string;
}

/** The report's file name in `eval/backtest/results/`. */
export function backtestReportFileName(inputs: BacktestInputs): string {
  return `${backtestReportDate(inputs)}.md`;
}

/** `n` with thousands separators (`12,917`), without the locale's help. */
export function group(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** `n/d` as a percentage with one decimal plus the raw fraction, or `n/a` when `d` is 0. */
function percent(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}% (${n}/${d})`;
}

function code(text: string): string {
  return `\`${text}\``;
}

/** `count` and the noun, plural unless it's 1. */
function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${group(count)} ${count === 1 ? noun : many}`;
}

/** The time from `from` to `to` (UTC instants), in the two largest units. */
export function elapsed(from: string, to: string): string {
  const s = Math.round((Date.parse(to) - Date.parse(from)) / 1000);
  if (s < 0) return `${elapsed(to, from)} before`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
}

/** The edge kind of an edge ID (`calls:…` → `calls`). */
export function edgeKind(edge: string): string {
  return edge.slice(0, Math.max(0, edge.indexOf(":"))) || edge;
}

/** A node ID's short name: its symbol after `#`, else the ID. */
function shortNode(id: string): string {
  const hash = id.lastIndexOf("#");
  return hash < 0 ? id : id.slice(hash + 1);
}

function prLink(repo: string, n: number): string {
  return `[#${n}](https://github.com/${repo}/pull/${n})`;
}

function commitLink(repo: string, sha: string): string {
  return `[${sha.slice(0, 7)}](https://github.com/${repo}/commit/${sha})`;
}

/** Whether a diff shows any change: anything but `updated` (which isn't shown as one). */
export function changed(s: DiffSummary): boolean {
  const lists = [s.nodes, s.edges];
  return s.broken > 0 || lists.some((l) => l.added + l.removed + l.modified + l.renamed > 0);
}

/** Per-repo totals for the coverage table. */
interface Totals {
  found: number;
  replayed: number;
  excluded: number;
  overCap: number;
  diffed: number;
  failed: number;
  changed: number;
  edgesAdded: number;
  edgesRemoved: number;
  renameLimit: number;
  flagged: number;
  broken: number;
}

function totals(r: RepoFiles): Totals {
  const diffed = r.raw.prs.flatMap((p) => (p.outcome === "diffed" ? [p] : []));
  return {
    found: r.prs.found,
    replayed: r.raw.prs.length,
    excluded: r.prs.excluded.length,
    overCap: r.prs.overCap.length,
    diffed: diffed.length,
    failed: r.raw.prs.length - diffed.length,
    changed: diffed.filter((p) => changed(p.summary)).length,
    edgesAdded: diffed.reduce((n, p) => n + p.summary.edges.added, 0),
    edgesRemoved: diffed.reduce((n, p) => n + p.summary.edges.removed, 0),
    renameLimit: diffed.filter((p) => p.renameLimit !== undefined).length,
    flagged: diffed.filter((p) => p.broken.length > 0).length,
    broken: diffed.reduce((n, p) => n + p.broken.length, 0),
  };
}

function sum(all: Totals[]): Totals {
  const out = totals0();
  for (const t of all) for (const k of Object.keys(out) as (keyof Totals)[]) out[k] += t[k];
  return out;
}

function totals0(): Totals {
  return {
    found: 0,
    replayed: 0,
    excluded: 0,
    overCap: 0,
    diffed: 0,
    failed: 0,
    changed: 0,
    edgesAdded: 0,
    edgesRemoved: 0,
    renameLimit: 0,
    flagged: 0,
    broken: 0,
  };
}

/** A machine in one line. */
function machine(run: ReplayRun): string {
  const m = run.machine;
  return `${m.cpu} (${m.cores} cores, ${m.ramGiB} GiB), ${m.os}, Node ${m.node}`;
}

/** One flagged break with everything known about it. */
interface Flag {
  repo: string;
  pr: FollowedPr;
  edge: BrokenEdge;
  followed: FollowedBreak;
  classified: ClassifiedBreak;
}

function flags(repos: RepoFiles[]): Flag[] {
  return repos.flatMap((r) =>
    r.followUp.prs.flatMap((pr) => {
      const replayed = r.raw.prs.find((p) => p.number === pr.number);
      const judged = r.classified?.prs.find((p) => p.number === pr.number);
      return pr.breaks.map((followed, i) => {
        const edge =
          replayed?.outcome === "diffed"
            ? replayed.broken.find((b) => b.edge === followed.edge)
            : undefined;
        const classified = judged?.breaks[i];
        if (!edge || !classified) {
          throw new BacktestReportError(
            `${r.followUp.repo} #${pr.number}: ${followed.edge} has no ${edge ? "classification" : "broken edge in the raw file"} (run validate)`,
          );
        }
        return { repo: r.followUp.repo, pr, edge, followed, classified };
      });
    }),
  );
}

/** Render the report from the backtest's files and the hand-written limitations (Markdown). */
export function renderBacktestReport(inputs: BacktestInputs, limitations: string): string {
  const repos = repoFiles(inputs);
  const { window, maxPrsPerRepo, followUpDays } = inputs.repos;
  const perRepo = repos.map(totals);
  const all = sum(perRepo);
  const found = flags(repos);
  const counts = classifiedCounts(repos.flatMap((r) => (r.classified ? [r.classified] : [])));
  const kinds = new Map<string, number>();
  for (const f of found)
    kinds.set(edgeKind(f.edge.edge), (kinds.get(edgeKind(f.edge.edge)) ?? 0) + 1);
  const kindList = [...kinds.entries()].sort(([a], [b]) => compareStrings(a, b));
  const trueBreaks = found.filter((f) => f.classified.verdict === "true");
  const trueReviewed = trueBreaks.filter((f) => f.classified.reviewedBy !== null);
  const fixedReal = trueBreaks.filter(
    (f) => f.followed.fixed !== null && f.classified.fix?.verdict === "real",
  );
  const fixed = found.filter((f) => f.followed.fixed !== null);
  const stillFlagged = found.filter((f) => f.followed.atEnd === "flagged");
  const reviewed = found.filter((f) => f.classified.reviewedBy !== null);
  const judged = counts.verdicts.true + counts.verdicts.false;
  const reviewedJudged = reviewed.filter((f) => f.classified.verdict !== "unclear");
  const drafters = [
    ...new Set(repos.flatMap((r) => (r.classified ? [r.classified.classifiedBy] : []))),
  ];

  const out: string[] = [];
  const line = (s = ""): void => {
    out.push(s);
  };

  line(`# PR backtest: ${backtestReportDate(inputs)}`);
  line();
  line(
    `Generated by ${code("pnpm --filter @gitinside/eval backtest:report")} from the committed files in ${code("eval/backtest/")}; ${code("backtest:report --check")} regenerates it byte for byte. Method: [docs/EVALUATION.md §3](../../../docs/EVALUATION.md#3-pr-backtesting-m7), ADR-0214 to ADR-0219 in [docs/DECISIONS.md](../../../docs/DECISIONS.md). Numbers are as measured; nothing is rounded up or left out.`,
  );
  line();

  line("## Result");
  line();
  line(
    `- **Replayed:** ${plural(all.replayed, "merged PR")} of ${plural(repos.length, "repo")}, merged ${window.from} to ${window.to} (UTC): ${group(all.diffed)} diffed, ${group(all.failed)} failed. ${plural(all.found, "PR")} merged in the window in all; ${group(all.excluded)} excluded with a reason and ${group(all.overCap)} past the ${maxPrsPerRepo}-per-repo cap.`,
  );
  line(
    `- **Flagged:** ${plural(all.broken, "broken edge")} in ${plural(all.flagged, "PR")}.${kindList.length === 0 ? "" : ` By edge kind: ${kindList.map(([k, n]) => `${group(n)} ${code(k)}`).join(", ")}.`} Cross-service (${code("http")}) edges flagged: ${group(kinds.get("http") ?? 0)}.`,
  );
  line(
    `- **Verdicts:** ${group(counts.verdicts.true)} true, ${group(counts.verdicts.false)} false positive, ${group(counts.verdicts.unclear)} unclear${drafters.length === 0 ? "" : `, drafted by ${drafters.join("; ")}`}. **Reviewed by Abhinav: ${group(reviewed.length)} of ${group(found.length)}.**`,
  );
  line(
    `- **Precision of flags:** ${percent(counts.verdicts.true, judged)} true among breaks judged true or false${counts.verdicts.unclear > 0 ? ` (${group(counts.verdicts.unclear)} unclear left out)` : ""}${reviewed.length < found.length ? ", from verdicts that are still drafts" : ""}; over reviewed verdicts only: ${percent(reviewedJudged.filter((f) => f.classified.verdict === "true").length, reviewedJudged.length)}. Recall isn't measured (see Limitations).`,
  );
  line(
    `- **Fixed later:** ${group(fixed.length)} of ${group(found.length)} breaks had a later commit (up to each repo's ${code("endSha")}, ${followUpDays} days after the window) where the detector no longer flags them; ${group(counts.fixes.real)} of those fixes judged real, ${group(counts.fixes.coincidental)} coincidental, ${group(counts.fixes.unclear)} unclear. Still flagged at ${code("endSha")}: ${group(stillFlagged.length)}.`,
  );
  line();
  line(
    `**Claim, exactly as measured:** flagged ${plural(all.broken, "broken edge")} across ${plural(all.diffed, "merged PR")}; ${plural(trueBreaks.length, "was classified as a true break", "were classified as true breaks")} (${group(trueReviewed.length)} of them reviewed by Abhinav${trueReviewed.length < trueBreaks.length ? ", the rest drafts" : ""}), and ${group(fixedReal.length)} of those ${fixedReal.length === 1 ? "was" : "were"} fixed in a later commit judged a real fix.`,
  );
  line();

  line("## Per repo");
  line();
  line(
    "| Repo | Merged in window | Replayed | Excluded | Past cap | Failed | Diffs with changes | Edges added | Edges removed | Rename budget hit | Flagged PRs | Broken edges |",
  );
  line("|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
  const row = (name: string, t: Totals): string =>
    `| ${name} | ${[t.found, t.replayed, t.excluded, t.overCap, t.failed, t.changed, t.edgesAdded, t.edgesRemoved, t.renameLimit, t.flagged, t.broken].map(group).join(" | ")} |`;
  repos.forEach((r, i) =>
    line(row(`[${r.pin.owner}/${r.pin.name}](${r.pin.url})`, perRepo[i] as Totals)),
  );
  line(row("**All**", all));
  line();
  line(
    `"Diffs with changes" counts diffs that add, remove, modify, or rename a node or edge (facts that only moved, ${code("updated")}, don't count).`,
  );
  line();

  line("## Flagged breaks");
  line();
  if (found.length === 0) line("None.");
  for (const r of repos) {
    for (const pr of r.followUp.prs) {
      const repo = r.followUp.repo;
      const mine = found.filter((f) => f.repo === repo && f.pr.number === pr.number);
      line(`### ${repo} ${prLink(repo, pr.number)}`);
      line();
      line(
        `Merged ${pr.mergedAt} as ${commitLink(repo, pr.mergeSha)} (base ${commitLink(repo, pr.baseSha)}). The follow-up diffed the base with ${group(pr.checked)} of the ${group(pr.later)} later commits up to ${code("endSha")}${pr.unreadable.length > 0 ? `; ${plural(pr.unreadable.length, "commit")} couldn't be read` : ""}.`,
      );
      line();
      line(
        "| # | Kind | Call | Reason | Verdict | Fixed by | How | After | In | At endSha | Fix judged | Reviewed by |",
      );
      line("|--:|---|---|---|---|---|---|---|---|---|---|---|");
      mine.forEach((f, i) => {
        const fix = f.followed.fixed;
        line(
          `| ${i + 1} | ${code(edgeKind(f.edge.edge))} | ${code(shortNode(f.edge.from))} → ${code(shortNode(f.edge.to))} | ${code(f.edge.reason)} | ${f.classified.verdict} | ${fix ? commitLink(repo, fix.sha) : "none"} | ${fix ? code(fix.how) : ""} | ${fix ? elapsed(pr.mergedAt, fix.committedAt) : ""} | ${fix ? (fix.pr === null ? "no pinned PR" : prLink(repo, fix.pr)) : ""} | ${f.followed.atEnd} | ${f.classified.fix?.verdict ?? ""} | ${f.classified.reviewedBy ?? "draft"} |`,
        );
      });
      line();
      mine.forEach((f, i) => {
        const site = f.edge.sites[0];
        line(
          `${i + 1}. ${f.edge.detail}${site ? ` (${code(`${site.file}:${site.line}`)})` : ""}. **Verdict:** ${f.classified.why}${f.classified.fix ? ` **Fix:** ${f.classified.fix.why}` : ""} Evidence: ${f.classified.evidence.map((u, k) => `[${k + 1}](${u})`).join(", ")}.`,
        );
      });
      line();
    }
  }

  line("## PRs not replayed or not diffed");
  line();
  const excluded = repos.flatMap((r) =>
    r.prs.excluded.map(
      (p) =>
        `- ${r.prs.repo} ${prLink(r.prs.repo, p.number)} (merged ${p.mergedAt}): excluded, ${p.reason}`,
    ),
  );
  const capped = repos.flatMap((r) =>
    r.prs.overCap.length === 0
      ? []
      : [
          `- ${r.prs.repo}: ${plural(r.prs.overCap.length, "PR")} merged after the first ${maxPrsPerRepo} (${r.prs.overCap[0]?.mergedAt} to ${r.prs.overCap.at(-1)?.mergedAt}) past the cap, not replayed.`,
        ],
  );
  const failed = repos.flatMap((r) =>
    r.raw.prs.flatMap((p) =>
      p.outcome === "failed"
        ? [
            `- ${r.raw.repo} ${prLink(r.raw.repo, p.number)}: failed at ${p.stage}: ${(p.error.split("\n")[0] ?? "").trim()}`,
          ]
        : [],
    ),
  );
  const notDone = [...excluded, ...capped, ...failed];
  if (notDone.length === 0) line("None.");
  for (const l of notDone) line(l);
  line();

  line("## Inputs");
  line();
  line(
    `- ${code("eval/backtest/repos.json")}: pinned ${inputs.repos.pinned}, window ${window.from} to ${window.to}, at most ${maxPrsPerRepo} PRs per repo, ${followUpDays}-day follow-up; ${plural(repos.length, "repo")} pinned of ${group(repos.length + inputs.repos.rejected.length)} candidates (${group(inputs.repos.rejected.length)} rejected, each with the rule it fails).`,
  );
  line(
    `- PR files (${code("eval/backtest/prs/")}) listed ${[...new Set(repos.map((r) => r.prs.listed))].sort(compareStrings).join(", ")}.`,
  );
  line(
    `- Replay (${code("eval/backtest/raw/")}) and follow-up (${code("eval/backtest/followup/")}) runs: gitinside commit, analyzer version, machine, day.`,
  );
  line();
  line("| Repo | startSha..endSha | Replay | Replay machine | Follow-up |");
  line("|---|---|---|---|---|");
  for (const r of repos) {
    const repo = `${r.pin.owner}/${r.pin.name}`;
    const follow =
      r.followUp.prs.length === 0
        ? "no flagged PR"
        : `${code(r.followUp.run.gitinside.slice(0, 7))} ${r.followUp.run.analyzerVersion}, ${r.followUp.run.started}, ${machine(r.followUp.run)}`;
    line(
      `| ${repo} | ${commitLink(repo, r.pin.startSha)}..${commitLink(repo, r.pin.endSha)} | ${code(r.raw.run.gitinside.slice(0, 7))} ${r.raw.run.analyzerVersion}, ${r.raw.run.started} | ${machine(r.raw.run)} | ${follow} |`,
    );
  }
  line();
  for (const r of repos) {
    if (!r.classified) continue;
    const breaks = r.classified.prs.flatMap((p) => p.breaks);
    line(
      `- ${code(`eval/backtest/classified/${prsFileName(r.pin)}`)}: drafted ${r.classified.drafted} by ${r.classified.classifiedBy}; ${group(breaks.filter((b) => b.reviewedBy !== null).length)} of ${plural(breaks.length, "break")} reviewed.`,
    );
  }
  if (repos.some((r) => r.classified)) line();

  line("## Limitations");
  line();
  line(limitations.trim());
  line();
  return out.join("\n");
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyze } from "@gitinside/analyzer";
import { impactIndex, impactOf } from "@gitinside/impact";
import { compareStrings, parseGraph, type ArchitectureGraph } from "@gitinside/schema";
import { BENCH, benchRepos, checkout, flag, gitinsideCommit, machine, today } from "./env.js";
import { renderImpactReport, summarize, type ImpactCase, type ImpactRun } from "./impactReport.js";

// Impact analysis benchmark (M11.1): `impactIndex` and `impactOf` from @gitinside/impact on
// the analysis benchmark's real repo (bench/repos.json, cal.com), against the interactive
// budget in impactReport.ts. Targets: every service, route, page, model, datastore, queue, and
// outside API, plus every 25th file and symbol by ID. Writes
// bench/results/<date>-impact-<repo>.{md,json}.
//
// Usage: pnpm bench:impact [--label "<machine label>"] [--graph <saved graph.json>]
//   [--save <file>] (--save writes the analyzed graph, so later runs can skip analysis)

const INDEX_RUNS = 5;
const RUNS_PER_TARGET = 3;
const EVERY = 25;
const ALL_OF: ReadonlySet<string> = new Set([
  "service",
  "route",
  "page",
  "model",
  "datastore",
  "queue",
  "external",
]);

/** The nodes to ask about, by ID. */
function targetsOf(graph: ArchitectureGraph): { id: string; kind: string }[] {
  const nodes = [...graph.nodes].sort((a, b) => compareStrings(a.id, b.id));
  const sampled = new Map<string, number>();
  return nodes.filter((n) => {
    if (ALL_OF.has(n.kind)) return true;
    if (n.kind !== "file" && n.kind !== "symbol") return false;
    const seen = sampled.get(n.kind) ?? 0;
    sampled.set(n.kind, seen + 1);
    return seen % EVERY === 0;
  });
}

const time = (fn: () => void): number => {
  const start = performance.now();
  fn();
  return performance.now() - start;
};

async function main(): Promise<void> {
  const label = flag("label", "dev machine");
  // Before anything is written: this run's own report mustn't count as a local change.
  const gitinsideSha = gitinsideCommit();
  const [repo] = await benchRepos();
  if (!repo) throw new Error("bench/repos.json has no repo");

  const saved = flag("graph", "");
  let graph: ArchitectureGraph;
  if (saved) {
    graph = parseGraph(JSON.parse(await readFile(saved, "utf8")));
    if (graph.repo.sha !== repo.sha) throw new Error(`${saved} isn't ${repo.name} at ${repo.sha}`);
  } else {
    process.stderr.write(`${repo.name}: checking out ${repo.sha}, analyzing\n`);
    graph = await analyze(await checkout(repo), {
      owner: repo.owner,
      name: repo.repo,
      sha: repo.sha,
    });
  }
  const save = flag("save", "");
  if (save) await writeFile(save, JSON.stringify(graph));

  const indexMs: number[] = [];
  let index = impactIndex(graph);
  for (let i = 0; i < INDEX_RUNS; i++) {
    indexMs.push(time(() => (index = impactIndex(graph))));
  }
  const targets = targetsOf(graph);
  process.stderr.write(
    `${repo.name}: index ${indexMs.map((x) => x.toFixed(1)).join(", ")} ms; ${targets.length} targets\n`,
  );
  for (const t of targets) impactOf(index, t.id); // warm-up

  const cases: ImpactCase[] = [];
  for (const t of targets) {
    const runs: number[] = [];
    let found = impactOf(index, t.id);
    for (let i = 0; i < RUNS_PER_TARGET; i++)
      runs.push(time(() => (found = impactOf(index, t.id))));
    runs.sort((a, b) => a - b);
    cases.push({
      target: t.id,
      kind: t.kind,
      ms: runs[Math.floor(runs.length / 2)] as number,
      dependents: found.dependents.length,
      maybe: found.maybe.length,
    });
  }

  const run: ImpactRun = {
    date: today(),
    repo: { name: repo.name, url: repo.url, sha: repo.sha },
    gitinsideSha,
    analyzerVersion: graph.analyzerVersion,
    machine: machine(label),
    graph: { nodes: graph.nodes.length, edges: graph.edges.length },
    indexMs,
    runsPerTarget: RUNS_PER_TARGET,
    cases,
  };
  const s = summarize(run);
  process.stderr.write(
    `${repo.name}: query median ${s.queryMedianMs.toFixed(2)} ms, p95 ${s.queryP95Ms.toFixed(2)}, ` +
      `max ${s.queryMaxMs.toFixed(2)}; worst first ${s.worstFirstMs.toFixed(2)} ms\n`,
  );
  const out = join(BENCH, "results", `${run.date}-impact-${repo.name}`);
  await mkdir(join(BENCH, "results"), { recursive: true });
  await writeFile(`${out}.json`, `${JSON.stringify(run, null, 2)}\n`);
  await writeFile(`${out}.md`, renderImpactReport(run));
  process.stderr.write(`wrote ${out}.md\n`);
}

await main();

/**
 * Every committed file of the PR backtest (docs/EVALUATION.md §3), read and parsed together:
 * `eval/backtest/repos.json` and, per repo, its PR file, raw file, follow-up file, and
 * classification file. `validate` and the report (report.ts) both read them through here, so
 * the report can't describe files that `validate` would reject.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compareStrings } from "@gitinside/schema";
import { classifyCrossCheck, parseClassifiedFile, type ClassifiedFile } from "./classify.js";
import { followUpCrossCheck, parseFollowUpFile, type FollowUpFile } from "./followUp.js";
import { parseBacktestReposFile, type BacktestReposFile } from "./format.js";
import { parsePrsFile, prsCrossCheck, type PrsFile } from "./prs.js";
import { parseRawFile, rawCrossCheck, type RawFile } from "./replay.js";

/** A parsed file and its name in its folder (`<owner>__<name>.json`). */
export interface Named<T> {
  f: string;
  file: T;
}

/** The backtest's committed files. */
export interface BacktestInputs {
  repos: BacktestReposFile;
  prs: Named<PrsFile>[];
  raw: Named<RawFile>[];
  followUp: Named<FollowUpFile>[];
  classified: Named<ClassifiedFile>[];
}

/** Parse every `*.json` in `eval/backtest/<folder>`, in file-name order; none if it's absent. */
function readFolder<T>(
  evalDir: string,
  folder: string,
  parse: (file: string, text: string) => T,
): Named<T>[] {
  const dir = join(evalDir, "backtest", folder);
  return (existsSync(dir) ? readdirSync(dir) : [])
    .filter((f) => f.endsWith(".json"))
    .sort(compareStrings)
    .map((f) => ({
      f,
      file: parse(`backtest/${folder}/${f}`, readFileSync(join(dir, f), "utf8")),
    }));
}

/** Read and parse the backtest's files under `evalDir` (the eval package's folder). */
export function loadBacktestInputs(evalDir: string): BacktestInputs {
  return {
    repos: parseBacktestReposFile(
      "backtest/repos.json",
      readFileSync(join(evalDir, "backtest", "repos.json"), "utf8"),
    ),
    prs: readFolder(evalDir, "prs", parsePrsFile),
    raw: readFolder(evalDir, "raw", parseRawFile),
    followUp: readFolder(evalDir, "followup", parseFollowUpFile),
    classified: readFolder(evalDir, "classified", parseClassifiedFile),
  };
}

/**
 * Problems between the backtest's files: each file against the one it builds on (a PR file
 * against its pin, a raw file against its PR file, a follow-up file against its raw file and
 * pin, a classification against its follow-up), and a flagged break without a classification.
 */
export function backtestProblems(inputs: BacktestInputs): string[] {
  const { repos, prs, raw, followUp, classified } = inputs;
  return [
    ...classified.flatMap(({ f, file }) => {
      const followed = followUp.find((u) => u.f === f);
      if (!followed)
        return [`backtest/classified/${f}: there's no backtest/followup/${f} it classifies`];
      return classifyCrossCheck(file, followed.file).map((p) => `backtest/classified/${f}: ${p}`);
    }),
    // Every flagged break gets a verdict.
    ...followUp
      .filter(({ f, file }) => file.prs.length > 0 && !classified.some((c) => c.f === f))
      .map(
        ({ f }) => `backtest/followup/${f}: its flagged breaks have no backtest/classified/${f}`,
      ),
    ...followUp.flatMap(({ f, file }) => {
      const replayed = raw.find((r) => r.f === f);
      if (!replayed) return [`backtest/followup/${f}: there's no backtest/raw/${f} it follows up`];
      const pin = repos.repos.find((r) => `${r.owner}/${r.name}` === file.repo);
      if (!pin) return [`backtest/followup/${f}: ${file.repo} isn't pinned`];
      return followUpCrossCheck(file, replayed.file, pin).map(
        (p) => `backtest/followup/${f}: ${p}`,
      );
    }),
    ...prs.flatMap(({ f, file }) =>
      prsCrossCheck(file, repos, f).map((p) => `backtest/prs/${f}: ${p}`),
    ),
    ...raw.flatMap(({ f, file }) => {
      const listed = prs.find((p) => p.f === f);
      if (!listed) return [`backtest/raw/${f}: there's no backtest/prs/${f} it replays`];
      return rawCrossCheck(file, listed.file).map((p) => `backtest/raw/${f}: ${p}`);
    }),
  ];
}

/**
 * Loads and cross-checks the eval's committed inputs: `repos.json` plus every file under
 * `labels/`. Each file is validated on its own by format.ts; this adds the checks that span
 * files (a label file belongs to a pinned repo, at the pinned SHA, under the right name).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compareStrings } from "@gitinside/schema";
import {
  labelFileName,
  parseLabelFile,
  parseReposFile,
  type EvalRepo,
  type LabelFile,
} from "./format.js";

/** The validated eval inputs, label files keyed by file name. */
export interface EvalInputs {
  repos: EvalRepo[];
  labels: Map<string, LabelFile>;
}

/**
 * Problems between the repo list and the label files, sorted. A pinned repo without a label
 * file is not a problem (labels are drafted after repos are picked); a label file without a
 * pinned repo, at another SHA, or under the wrong name is.
 */
export function crossCheck(inputs: EvalInputs): string[] {
  const problems: string[] = [];
  const byName = new Map(inputs.repos.map((r) => [labelFileName(r.owner, r.name), r]));
  for (const [file, labels] of inputs.labels) {
    const [owner = "", name = ""] = labels.repo.split("/");
    const expected = labelFileName(owner, name);
    if (file !== expected) {
      problems.push(`labels/${file}: repo ${labels.repo} belongs in labels/${expected}`);
      continue;
    }
    const repo = byName.get(file);
    if (!repo) problems.push(`labels/${file}: ${labels.repo} is not pinned in repos.json`);
    else if (repo.sha !== labels.sha) {
      problems.push(`labels/${file}: labeled at ${labels.sha}, but repos.json pins ${repo.sha}`);
    }
  }
  return problems.sort(compareStrings);
}

/**
 * Read and validate `<root>/repos.json` and every `<root>/labels/*.json`. Throws
 * `EvalInputError` for a malformed file; cross-file problems come from
 * {@link crossCheck}.
 */
export function loadEvalInputs(root: string): EvalInputs {
  const { repos } = parseReposFile("repos.json", readFileSync(join(root, "repos.json"), "utf8"));
  const labels = new Map<string, LabelFile>();
  const dir = join(root, "labels");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort(compareStrings);
  for (const file of files) {
    labels.set(file, parseLabelFile(`labels/${file}`, readFileSync(join(dir, file), "utf8")));
  }
  return { repos, labels };
}

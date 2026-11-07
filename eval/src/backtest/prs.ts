/**
 * The PRs the backtest replays (docs/EVALUATION.md §3, ADR-0215), pinned per repo in
 * `eval/backtest/prs/<owner>__<name>.json` before any is replayed. Each entry names the two
 * commits M7.2b analyzes: `baseSha`, the branch just before the PR landed, and `mergeSha`, the
 * branch just after. How GitHub merged the PR decides the base:
 *
 * - **merge** (a merge commit, two or more parents): the first parent.
 * - **rebase** (the PR's `k` commits replayed onto the branch, `k > 1`): the commit `k` steps
 *   down the first-parent chain from `mergeSha`, so the replay sees the whole PR, not only its
 *   last commit. Recognized when the last `k` first-parent commits carry exactly the PR's `k`
 *   commit messages, in order.
 * - **squash** (one commit with one parent, anything else): the parent. A one-commit rebase is
 *   recorded as a squash: both put the same single change on the branch.
 *
 * Not handled: a PR merged by hand (pushed to the branch outside GitHub's merge button) whose
 * `merge_commit_sha` GitHub still reports; a rebase whose commit messages GitHub rewrote; PRs
 * of more than 250 commits (the PR commits API's limit), which are excluded with a reason.
 */
import { compareStrings } from "@gitinside/schema";
import { z } from "zod";
import { parseWith } from "../format.js";
import { addDays, type BacktestRepo, type BacktestReposFile } from "./format.js";

/** The PR commits API lists at most this many commits of one PR. */
export const MAX_PR_COMMITS = 250;

const sha = z.string().regex(/^[0-9a-f]{40}$/, "must be a 40-character lowercase hex SHA");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
/** A UTC timestamp as GitHub's API writes it. */
const instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "must be YYYY-MM-DDTHH:MM:SSZ");
const prNumber = z.number().int().min(1);

/** What GitHub's API says about one merged PR. */
export interface ListedPr {
  number: number;
  title: string;
  /** `merged_at`, a UTC timestamp. */
  mergedAt: string;
  /** The branch it was merged into. */
  baseRef: string;
  /** `merge_commit_sha`: the commit the merge put on the branch. */
  mergeSha: string;
  /** How many commits the PR had. */
  commits: number;
}

/** How a PR's commits reached the branch (see the module comment). */
export const MERGE_KINDS = ["merge", "rebase", "squash"] as const;

/** One PR the replay analyzes. */
export const pinnedPrSchema = z
  .object({
    number: prNumber,
    title: z.string(),
    mergedAt: instant,
    mergeSha: sha,
    baseSha: sha,
    kind: z.enum(MERGE_KINDS),
    commits: z.number().int().min(1),
  })
  .strict()
  .refine((p) => p.baseSha !== p.mergeSha, {
    message: "the base must differ from the merge commit",
    path: ["baseSha"],
  });

export type PinnedPr = z.infer<typeof pinnedPrSchema>;

/** A PR merged in the window that isn't replayed, and why. */
export const excludedPrSchema = z
  .object({ number: prNumber, mergedAt: instant, reason: z.string().min(1) })
  .strict();

export type ExcludedPr = z.infer<typeof excludedPrSchema>;

/** A PR merged in the window after the repo's cap was reached. */
export const overCapPrSchema = z.object({ number: prNumber, mergedAt: instant }).strict();

/** Merge order: by merge time, then PR number (negative when `a` comes first). */
function mergeOrder(a: { mergedAt: string; number: number }, b: typeof a): number {
  return compareStrings(a.mergedAt, b.mergedAt) || a.number - b.number;
}

/** `eval/backtest/prs/<owner>__<name>.json`. */
export const prsFileSchema = z
  .object({
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must be "owner/name"'),
    /** The day GitHub was asked. */
    listed: date,
    /** Copied from `repos.json`, so a file can't silently describe another pin. */
    branch: z.string().min(1),
    startSha: sha,
    endSha: sha,
    /** The search query that found the PRs (its dates a day wider than the window, see `inWindow`). */
    search: z.string().min(1),
    /** PRs merged into `branch` in the window: `prs`, `excluded`, and `overCap` together. */
    found: z.number().int().min(0),
    prs: z.array(pinnedPrSchema),
    excluded: z.array(excludedPrSchema),
    overCap: z.array(overCapPrSchema),
  })
  .strict()
  .superRefine((file, ctx) => {
    const issue = (path: (string | number)[], message: string): void =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const total = file.prs.length + file.excluded.length + file.overCap.length;
    if (total !== file.found) {
      issue(["found"], `${file.found} found, but prs, excluded and overCap hold ${total}`);
    }
    for (const key of ["prs", "excluded", "overCap"] as const) {
      const list: { number: number; mergedAt: string }[] = file[key];
      list.forEach((p, i) => {
        const before = list[i - 1];
        if (before && mergeOrder(before, p) >= 0) {
          issue([key, i], "out of merge order (by mergedAt, then number) or a duplicate");
        }
      });
    }
    const seen = new Set<number>();
    [...file.prs, ...file.excluded, ...file.overCap].forEach((p) => {
      if (seen.has(p.number)) issue(["found"], `PR #${p.number} is listed twice`);
      seen.add(p.number);
    });
    const lastKept = [...file.prs, ...file.excluded].sort(mergeOrder).at(-1);
    const firstOver = file.overCap[0];
    if (lastKept && firstOver && mergeOrder(firstOver, lastKept) < 0) {
      issue(["overCap", 0], "merged before a PR that was kept: the cap takes the earliest");
    }
  });

export type PrsFile = z.infer<typeof prsFileSchema>;

/** Parse and validate the text of a PR file; `file` names it in errors. */
export function parsePrsFile(file: string, text: string): PrsFile {
  return parseWith(prsFileSchema, file, text);
}

/** `owner__name.json`, the PR file of `repo`. */
export function prsFileName(repo: { owner: string; name: string }): string {
  return `${repo.owner}__${repo.name}.json`;
}

/**
 * Problems between a PR file named `fileName` and the pin it belongs to: another file name,
 * branch, or SHAs, a merge time outside the window, or more PRs than the cap. An empty list
 * means they agree.
 */
export function prsCrossCheck(file: PrsFile, repos: BacktestReposFile, fileName: string): string[] {
  const repo = repos.repos.find(
    (r) => `${r.owner}/${r.name}`.toLowerCase() === file.repo.toLowerCase(),
  );
  if (!repo) return [`${file.repo} isn't pinned in repos.json`];
  const problems: string[] = [];
  if (fileName !== prsFileName(repo))
    problems.push(`holds ${file.repo}, so it must be named ${prsFileName(repo)}`);
  for (const key of ["branch", "startSha", "endSha"] as const) {
    if (file[key] !== repo[key])
      problems.push(`${key} is ${file[key]}, repos.json says ${repo[key]}`);
  }
  for (const p of [...file.prs, ...file.excluded, ...file.overCap]) {
    if (!inWindow(p.mergedAt, repos.window)) {
      problems.push(`PR #${p.number} merged at ${p.mergedAt}, outside the window`);
    }
  }
  if (file.prs.length > repos.maxPrsPerRepo) {
    problems.push(`${file.prs.length} PRs, more than maxPrsPerRepo (${repos.maxPrsPerRepo})`);
  }
  if (file.overCap.length > 0 && file.prs.length !== repos.maxPrsPerRepo) {
    problems.push(`PRs over the cap are listed, but only ${file.prs.length} were kept`);
  }
  return problems;
}

/** Whether `mergedAt` falls on a UTC day from `window.from` through `window.to`. */
export function inWindow(mergedAt: string, window: { from: string; to: string }): boolean {
  return mergedAt >= `${window.from}T00:00:00Z` && mergedAt < `${addDays(window.to, 1)}T00:00:00Z`;
}

/** What the replay needs to read from a repo's local clone. */
export interface GitView {
  /** Whether `sha` is a commit in the clone. */
  has(sha: string): boolean;
  /** The parents of commit `sha`, in order. */
  parents(sha: string): string[];
  /** Whether `ancestor` is `descendant` or one of its ancestors. */
  isAncestor(ancestor: string, descendant: string): boolean;
  /**
   * The messages of `sha` and the first-parent commits below it, oldest first, `count` in all;
   * fewer when the history is shorter.
   */
  firstParentMessages(sha: string, count: number): string[];
  /** The commit `steps` first parents below `sha`, if the history is that long. */
  firstParentAncestor(sha: string, steps: number): string | undefined;
}

/** A message with line endings and trailing whitespace evened out, for comparing. */
function normalizeMessage(message: string): string {
  return message
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

/** The base and merge kind of one PR, or why it can't be replayed. */
export function classifyPr(
  pr: ListedPr,
  repo: Pick<BacktestRepo, "branch" | "endSha">,
  git: GitView,
  prMessages: (number: number) => string[],
): { kind: (typeof MERGE_KINDS)[number]; baseSha: string } | { reason: string } {
  if (pr.baseRef !== repo.branch)
    return { reason: `merged into ${pr.baseRef}, not ${repo.branch}` };
  // An ancestor, not only a first-parent one: a maintainer's `git pull` merge ("Merge branch
  // 'main' of …") puts GitHub's branch, PR merges included, under its second parent. A merge
  // that a force-push dropped isn't an ancestor at all.
  if (!git.has(pr.mergeSha) || !git.isAncestor(pr.mergeSha, repo.endSha)) {
    return {
      reason: `its merge commit ${pr.mergeSha} isn't in ${repo.branch}'s history at endSha`,
    };
  }
  const parents = git.parents(pr.mergeSha);
  if (parents.length === 0) return { reason: `its merge commit ${pr.mergeSha} has no parent` };
  let found: { kind: (typeof MERGE_KINDS)[number]; baseSha: string | undefined };
  if (parents.length > 1) found = { kind: "merge", baseSha: parents[0] };
  else if (pr.commits <= 1) found = { kind: "squash", baseSha: parents[0] };
  else if (pr.commits > MAX_PR_COMMITS) {
    return { reason: `${pr.commits} commits, more than the ${MAX_PR_COMMITS} GitHub lists` };
  } else {
    const onBranch = git.firstParentMessages(pr.mergeSha, pr.commits).map(normalizeMessage);
    const inPr = prMessages(pr.number).map(normalizeMessage);
    const rebased = inPr.length === pr.commits && inPr.every((m, i) => m === onBranch[i]);
    found = rebased
      ? { kind: "rebase", baseSha: git.firstParentAncestor(pr.mergeSha, pr.commits) }
      : { kind: "squash", baseSha: parents[0] };
  }
  const { kind, baseSha } = found;
  if (baseSha === undefined) return { reason: `the history below ${pr.mergeSha} is too short` };
  return { kind, baseSha };
}

/** How the PR list reads GitHub and the clone. */
export interface PrSources {
  /** The facts of a PR the search found (`ListedPr` from the pulls API). */
  facts: (searched: { number: number; mergedAt: string }) => ListedPr;
  /** A PR's commit messages, oldest first. */
  messages: (number: number) => string[];
  git: GitView;
}

/**
 * The PR list of one repo from what the search found: the PRs merged in the window in merge
 * order, each replayed or excluded with a reason, until `maxPrsPerRepo` are replayed; the
 * rest are listed as over the cap without being looked up.
 */
export function selectPrs(
  searched: readonly { number: number; mergedAt: string }[],
  repo: Pick<BacktestRepo, "branch" | "endSha">,
  settings: Pick<BacktestReposFile, "window" | "maxPrsPerRepo">,
  sources: PrSources,
): Pick<PrsFile, "found" | "prs" | "excluded" | "overCap"> {
  const merged = searched.filter((p) => inWindow(p.mergedAt, settings.window)).sort(mergeOrder);
  const out: Pick<PrsFile, "found" | "prs" | "excluded" | "overCap"> = {
    found: merged.length,
    prs: [],
    excluded: [],
    overCap: [],
  };
  for (const found of merged) {
    if (out.prs.length === settings.maxPrsPerRepo) {
      out.overCap.push({ number: found.number, mergedAt: found.mergedAt });
      continue;
    }
    const pr = sources.facts(found);
    const result = classifyPr(pr, repo, sources.git, sources.messages);
    if ("reason" in result) {
      out.excluded.push({ number: pr.number, mergedAt: pr.mergedAt, reason: result.reason });
    } else {
      const { number, title, mergedAt, mergeSha, commits } = pr;
      out.prs.push({ number, title, mergedAt, mergeSha, ...result, commits });
    }
  }
  return out;
}

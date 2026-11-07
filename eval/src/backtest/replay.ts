/**
 * The backtest's replay (docs/EVALUATION.md §3 step 2, ADR-0216): for each PR pinned in
 * `eval/backtest/prs/<owner>__<name>.json`, analyze its base and merge commits, diff the two
 * graphs (`diffGraphs`, with both trees' file text so moved files are found), and record what
 * broke. The raw results go to `eval/backtest/raw/<owner>__<name>.json`: one entry per PR, in
 * the PR file's order, written after every PR so a stopped run resumes where it left off.
 *
 * - A commit's analysis is kept while the next PR may need it: in merge order, one PR's merge
 *   commit is usually the next one's base, so it's analyzed once ({@link SideCache}). Both
 *   sides also share one fact cache (ADR-0175), so services a PR didn't touch are analyzed
 *   once per repo rather than once per commit.
 * - A PR whose checkout, analysis, or diff fails is recorded as `failed` with the stage and
 *   the message, never dropped. A commit that just failed isn't tried again for the next PR.
 * - An entry keeps the diff's summary, its broken edges whole (M7.3 looks for their fixes,
 *   M7.4 classifies them), and `renameLimit` when rename detection hit its budget. The rest of
 *   the diff isn't kept: it's large, and the commits are pinned, so it can be rebuilt.
 *
 * Not handled: a run interrupted mid-PR loses only that PR, but a raw file is resumed only by
 * the same gitinside commit and analyzer version on a clean tree and the same machine
 * ({@link cannotResume}), so changing the analyzer
 * means starting the repo over (its results would otherwise mix two analyzers).
 */
import { openSide, type FactCache } from "@gitinside/analyzer";
import { diffGraphs } from "@gitinside/diff";
import { BrokenEdge, DiffSummary, RenameLimit, type ArchitectureGraph } from "@gitinside/schema";
import { z } from "zod";
import { parseWith } from "../format.js";
import type { PinnedPr, PrsFile } from "./prs.js";

const sha = z.string().regex(/^[0-9a-f]{40}$/, "must be a 40-character lowercase hex SHA");

/** Marks a gitinside commit whose tree had local changes when the run started. */
export const DIRTY_MARK = " + uncommitted changes";

/** What a raw file records about the run that produced it. */
export const replayRunSchema = z
  .object({
    /** The gitinside commit, plus {@link DIRTY_MARK} if the tree had local changes. */
    gitinside: z.string().min(1),
    analyzerVersion: z.string().min(1),
    /** The local day the run started (YYYY-MM-DD). */
    started: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"),
    machine: z
      .object({
        cpu: z.string(),
        cores: z.number().int().min(1),
        ramGiB: z.number().positive(),
        os: z.string(),
        node: z.string(),
      })
      .strict(),
  })
  .strict();

export type ReplayRun = z.infer<typeof replayRunSchema>;

const prKey = { number: z.number().int().min(1), baseSha: sha, mergeSha: sha };

/** A PR whose two commits were analyzed and diffed. */
export const diffedPrSchema = z
  .object({
    ...prKey,
    outcome: z.literal("diffed"),
    summary: DiffSummary,
    broken: z.array(BrokenEdge),
    renameLimit: RenameLimit.optional(),
  })
  .strict()
  .refine((p) => p.summary.broken === p.broken.length, {
    message: "summary.broken must count the broken edges",
    path: ["summary", "broken"],
  });

/** Where a failed PR stopped. */
export const FAILED_STAGES = ["base", "head", "diff"] as const;

/** A PR that couldn't be diffed, and why. */
export const failedPrSchema = z
  .object({
    ...prKey,
    outcome: z.literal("failed"),
    stage: z.enum(FAILED_STAGES),
    error: z.string().min(1),
  })
  .strict();

export const replayedPrSchema = z.union([diffedPrSchema, failedPrSchema]);
export type ReplayedPr = z.infer<typeof replayedPrSchema>;

/** `eval/backtest/raw/<owner>__<name>.json`. */
export const rawFileSchema = z
  .object({
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must be "owner/name"'),
    run: replayRunSchema,
    /** The PR file's PRs in its order: all of them once the run is complete, a prefix until then. */
    prs: z.array(replayedPrSchema),
  })
  .strict();

export type RawFile = z.infer<typeof rawFileSchema>;

/** Parse and validate the text of a raw file; `file` names it in errors. */
export function parseRawFile(file: string, text: string): RawFile {
  return parseWith(rawFileSchema, file, text);
}

/**
 * Problems between a raw file and the PR file it replays: another repo, or an entry that
 * isn't the PR file's PR at the same position (number, base, merge). An empty list means they
 * agree; a raw file holding fewer PRs than the PR file is a run still in progress.
 */
export function rawCrossCheck(raw: RawFile, prs: PrsFile): string[] {
  if (raw.repo !== prs.repo) return [`replays ${raw.repo}, but the PR file lists ${prs.repo}`];
  const problems: string[] = [];
  if (raw.prs.length > prs.prs.length) {
    problems.push(`${raw.prs.length} PRs replayed, but only ${prs.prs.length} are pinned`);
  }
  raw.prs.forEach((entry, i) => {
    const pinned = prs.prs[i];
    if (!pinned) return;
    for (const key of ["number", "baseSha", "mergeSha"] as const) {
      if (entry[key] !== pinned[key]) {
        problems.push(`prs[${i}].${key} is ${entry[key]}, the PR file's is ${pinned[key]}`);
      }
    }
  });
  return problems;
}

/** One commit, analyzed: its graph and its file text. */
export interface ReplaySide {
  graph: ArchitectureGraph;
  /** Text of a repo-relative file, or `undefined` when there's none. */
  read: (path: string) => string | undefined;
  /** Release the side's checkout. */
  close: () => Promise<void>;
}

/**
 * Open commits of the git repo at `dir` as sides: each is checked out into a temporary
 * worktree with no hooks (`openSide`, SECURITY.md: parsed, never run) and analyzed with
 * `cache`.
 */
export function commitOpener(dir: string, cache?: FactCache): (sha: string) => Promise<ReplaySide> {
  return async (commit) => {
    // `openSide` also takes a graph file or a folder; a pinned SHA must never be read as one.
    if (!sha.safeParse(commit).success) throw new Error(`${commit} is not a full commit SHA`);
    return openSide(commit, dir, cache === undefined ? {} : { cache });
  };
}

type Opened = { side: ReplaySide } | { error: string };

/** The message of a thrown value. */
function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() === "" ? "failed with no message" : message;
}

/**
 * The last `capacity` commits opened, by SHA, so a commit two PRs share is analyzed once. A
 * failure is remembered like a success. Evicting a side, or {@link SideCache.closeAll},
 * closes its checkout.
 */
export class SideCache {
  private readonly held = new Map<string, Opened>();

  constructor(
    private readonly open: (sha: string) => Promise<ReplaySide>,
    private readonly capacity = 2,
  ) {
    // A PR's base must stay open (its file text is read) while its merge commit is opened.
    if (!(Number.isInteger(capacity) && capacity >= 2)) {
      throw new Error("a side cache must hold at least 2 sides");
    }
  }

  /** The side of `sha`, or why it couldn't be opened. */
  async get(sha: string): Promise<Opened> {
    const found = this.held.get(sha);
    if (found) {
      // Most recently used goes last.
      this.held.delete(sha);
      this.held.set(sha, found);
      return found;
    }
    let opened: Opened;
    try {
      opened = { side: await this.open(sha) };
    } catch (error) {
      opened = { error: messageOf(error) };
    }
    this.held.set(sha, opened);
    while (this.held.size > this.capacity) {
      const [oldest, value] = this.held.entries().next().value as [string, Opened];
      this.held.delete(oldest);
      if ("side" in value) await value.side.close();
    }
    return opened;
  }

  /** Close every held side. */
  async closeAll(): Promise<void> {
    const values = [...this.held.values()];
    this.held.clear();
    for (const value of values) if ("side" in value) await value.side.close();
  }
}

/** Analyze and diff one PR with sides from `sides`. */
export async function replayPr(pr: PinnedPr, sides: SideCache): Promise<ReplayedPr> {
  const key = { number: pr.number, baseSha: pr.baseSha, mergeSha: pr.mergeSha };
  const failed = (stage: (typeof FAILED_STAGES)[number], error: string): ReplayedPr => ({
    ...key,
    outcome: "failed",
    stage,
    error,
  });
  const base = await sides.get(pr.baseSha);
  if ("error" in base) return failed("base", base.error);
  const head = await sides.get(pr.mergeSha);
  if ("error" in head) return failed("head", head.error);
  try {
    const diff = diffGraphs(base.side.graph, head.side.graph, {
      contents: { base: base.side.read, head: head.side.read },
    });
    return {
      ...key,
      outcome: "diffed",
      summary: diff.summary,
      broken: diff.broken,
      ...(diff.renameLimit === undefined ? {} : { renameLimit: diff.renameLimit }),
    };
  } catch (error) {
    return failed("diff", messageOf(error));
  }
}

/** How {@link replayRepo} reads commits and saves progress. */
export interface ReplayIo {
  /** Check `sha` out and analyze it. */
  open: (sha: string) => Promise<ReplaySide>;
  /** Save the raw file so far (called after every PR). */
  save: (raw: RawFile) => Promise<void>;
  /** Progress lines for the person running it. */
  log?: (line: string) => void;
}

/**
 * Replay `prs`'s PRs in order, continuing `previous` (a raw file of an earlier, stopped run
 * by the same `run`, see {@link cannotResume}) when given, and return the complete raw file.
 * At most `limit` PRs are replayed in all (counting `previous`'s).
 */
export async function replayRepo(
  prs: PrsFile,
  run: ReplayRun,
  io: ReplayIo,
  options: { previous?: RawFile; limit?: number } = {},
): Promise<RawFile> {
  const raw: RawFile = { repo: prs.repo, run, prs: [...(options.previous?.prs ?? [])] };
  const problems = rawCrossCheck(raw, prs);
  if (problems.length > 0) throw new Error(`can't resume ${prs.repo}: ${problems.join("; ")}`);
  const end = Math.min(prs.prs.length, options.limit ?? prs.prs.length);
  const sides = new SideCache(io.open);
  try {
    for (let i = raw.prs.length; i < end; i++) {
      const pr = prs.prs[i] as PinnedPr;
      const entry = await replayPr(pr, sides);
      raw.prs.push(entry);
      await io.save(raw);
      io.log?.(
        `${prs.repo} #${pr.number} (${i + 1}/${prs.prs.length}): ${
          entry.outcome === "diffed"
            ? `${entry.broken.length} broken`
            : `failed at ${entry.stage}: ${entry.error.split("\n")[0] ?? ""}`
        }`,
      );
    }
  } finally {
    await sides.closeAll();
  }
  return raw;
}

/**
 * Why an existing raw file can't be continued by `run`, or `undefined` if it can: only the
 * same gitinside commit and analyzer version, both on a clean tree, on the same machine, may
 * add to it, so the file's one run line describes every entry.
 */
export function cannotResume(previous: RawFile, run: ReplayRun): string | undefined {
  if (previous.run.gitinside.endsWith(DIRTY_MARK) || run.gitinside.endsWith(DIRTY_MARK)) {
    return "a run from uncommitted changes can't be resumed or resume another";
  }
  if (previous.run.gitinside !== run.gitinside) {
    return `it was started at gitinside ${previous.run.gitinside}, this is ${run.gitinside}`;
  }
  if (previous.run.analyzerVersion !== run.analyzerVersion) {
    return `it was started with analyzer ${previous.run.analyzerVersion}, this is ${run.analyzerVersion}`;
  }
  if (JSON.stringify(previous.run.machine) !== JSON.stringify(run.machine)) {
    return "it was started on another machine (or Node version)";
  }
  return undefined;
}

/**
 * The backtest's follow-up (docs/EVALUATION.md §3 step 3, ADR-0217): for each PR whose replay
 * flagged broken edges, was each break fixed by a later commit, and by which? The answer goes
 * to `eval/backtest/followup/<owner>__<name>.json`.
 *
 * - **Which commits:** every commit that descends from the PR's merge commit and is the repo's
 *   pinned `endSha` or one of its ancestors, oldest first ({@link FollowUpIo.later}). That
 *   takes in direct pushes and the commits of PR branches merged later, not only the pinned
 *   PRs' merges (maxun #1157's fix was a direct push), and nothing past the follow-up period.
 * - **Fixed:** a break is fixed at the first of those commits where diffing the PR's *base*
 *   with that commit no longer flags the same base edge, so a fix is judged by the same
 *   detector that flagged the break, with nothing guessed. How ({@link howFixed}): the edge
 *   exists again (`restored`), its source went away (`sourceRemoved`), or the source stayed
 *   and stopped making the call it made (`callChanged`).
 * - **Checked first:** the PR's own base and merge commit are diffed again and must give the
 *   raw file's broken edges exactly; otherwise the analyzer differs from the replay's, and the
 *   follow-up refuses rather than judge one analyzer's breaks with another.
 * - A commit that can't be checked out, analyzed, or diffed is listed with its error and
 *   skipped; a break can't be called fixed at it. `atEnd` says whether `endSha` still flags
 *   each break, since a fix can be undone.
 *
 * Not handled: a "fix" can be coincidental (the caller rewritten for another reason), which
 * M7.4's classification and the report must say; a fixing commit is attributed to a pinned PR
 * only when that PR's base..merge range holds it, so a fix in an excluded or over-cap PR
 * reads as outside every pinned PR.
 */
import { diffGraphs } from "@gitinside/diff";
import { BrokenReason, type GraphDiff } from "@gitinside/schema";
import { z } from "zod";
import { parseWith } from "../format.js";
import type { BacktestRepo } from "./format.js";
import type { PrsFile } from "./prs.js";
import {
  replayRunSchema,
  SideCache,
  type RawFile,
  type ReplayedPr,
  type ReplayRun,
  type ReplaySide,
} from "./replay.js";

const sha = z.string().regex(/^[0-9a-f]{40}$/, "must be a 40-character lowercase hex SHA");

/** How a fixing commit made a break go away. */
export const FIX_KINDS = ["restored", "sourceRemoved", "callChanged"] as const;
export type FixKind = (typeof FIX_KINDS)[number];

/** What `endSha` says about a break: still flagged, not flagged, or couldn't be read. */
export const AT_END = ["flagged", "clear", "unreadable"] as const;

const fixSchema = z
  .object({
    sha,
    /** Commit time, UTC. */
    committedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    how: z.enum(FIX_KINDS),
    /** The pinned PR whose base..merge range holds the commit, or `null` (a direct push, …). */
    pr: z.number().int().min(1).nullable(),
  })
  .strict();

export type Fix = z.infer<typeof fixSchema>;

const breakSchema = z
  .object({
    /** The base edge that broke (`BrokenEdge.edge` in the raw file). */
    edge: z.string().min(1),
    reason: BrokenReason,
    /** The first later commit that no longer flags it, or `null` if none up to `endSha`. */
    fixed: fixSchema.nullable(),
    atEnd: z.enum(AT_END),
  })
  .strict();

export type FollowedBreak = z.infer<typeof breakSchema>;

const followedPrSchema = z
  .object({
    number: z.number().int().min(1),
    baseSha: sha,
    mergeSha: sha,
    mergedAt: z.string().min(1),
    /** Later commits up to `endSha`. */
    later: z.number().int().min(0),
    /** Of those, how many were diffed before every break was fixed (`endSha` aside). */
    checked: z.number().int().min(0),
    /** Commits that couldn't be checked out, analyzed, or diffed, with why. */
    unreadable: z.array(z.object({ sha, error: z.string().min(1) }).strict()),
    breaks: z.array(breakSchema).min(1),
  })
  .strict()
  .refine((p) => p.checked <= p.later, {
    message: "can't check more commits than there are",
    path: ["checked"],
  });

export type FollowedPr = z.infer<typeof followedPrSchema>;

/** `eval/backtest/followup/<owner>__<name>.json`. */
export const followUpFileSchema = z
  .object({
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must be "owner/name"'),
    run: replayRunSchema,
    /** The gitinside commit of the raw file followed up (its run line). */
    replay: z.string().min(1),
    endSha: sha,
    /** Every PR of the raw file with a broken edge, in its order. */
    prs: z.array(followedPrSchema),
  })
  .strict();

export type FollowUpFile = z.infer<typeof followUpFileSchema>;

/** Parse and validate the text of a follow-up file; `file` names it in errors. */
export function parseFollowUpFile(file: string, text: string): FollowUpFile {
  return parseWith(followUpFileSchema, file, text);
}

type Flagged = Extract<ReplayedPr, { outcome: "diffed" }>;

/** The raw file's PRs with at least one broken edge, in order. */
export function flaggedPrs(raw: RawFile): Flagged[] {
  return raw.prs.filter((p): p is Flagged => p.outcome === "diffed" && p.broken.length > 0);
}

/**
 * Problems between a follow-up file and what it follows up: another repo or replay, another
 * `endSha`, or PRs and breaks that aren't exactly the raw file's flagged ones, in order.
 */
export function followUpCrossCheck(
  file: FollowUpFile,
  raw: RawFile,
  repo: Pick<BacktestRepo, "endSha">,
): string[] {
  if (file.repo !== raw.repo) return [`follows up ${file.repo}, but the raw file is ${raw.repo}`];
  const problems: string[] = [];
  if (file.replay !== raw.run.gitinside) {
    problems.push(
      `follows up the replay at ${file.replay}, the raw file's is ${raw.run.gitinside}`,
    );
  }
  if (file.endSha !== repo.endSha) {
    problems.push(`endSha is ${file.endSha}, the pinned one is ${repo.endSha}`);
  }
  const flagged = flaggedPrs(raw);
  if (file.prs.length !== flagged.length) {
    problems.push(`${file.prs.length} PRs followed up, but ${flagged.length} have broken edges`);
  }
  file.prs.forEach((pr, i) => {
    const want = flagged[i];
    if (!want) return;
    for (const key of ["number", "baseSha", "mergeSha"] as const) {
      if (pr[key] !== want[key])
        problems.push(`prs[${i}].${key} is ${pr[key]}, the raw file's is ${want[key]}`);
    }
    const edges = pr.breaks.map((b) => `${b.edge} ${b.reason}`);
    const wanted = want.broken.map((b) => `${b.edge} ${b.reason}`);
    if (JSON.stringify(edges) !== JSON.stringify(wanted)) {
      problems.push(`prs[${i}].breaks aren't the raw file's broken edges of #${want.number}`);
    }
  });
  return problems;
}

/**
 * How `diff` (the PR's base against a later commit that no longer flags `edge`) made the break
 * go away: the base edge is still there (`restored`, renamed or not), its source node is gone
 * (`sourceRemoved`), or neither (`callChanged`: the source stopped making that call).
 */
export function howFixed(
  diff: { nodes: Pick<GraphDiff["nodes"], "removed">; edges: Pick<GraphDiff["edges"], "removed"> },
  broken: { edge: string; from: string },
): FixKind {
  if (!diff.edges.removed.includes(broken.edge)) return "restored";
  if (diff.nodes.removed.includes(broken.from)) return "sourceRemoved";
  return "callChanged";
}

/** What {@link followUpRepo} reads from the repo's clone. */
export interface FollowUpIo {
  /** Check `sha` out and analyze it. */
  open: (sha: string) => Promise<ReplaySide>;
  /** Commits descending from `from` up to `to` (included), oldest first. */
  later: (from: string, to: string) => string[];
  /** Commit time of `sha`, UTC. */
  committedAt: (sha: string) => string;
  /** Whether `ancestor` is `descendant` or one of its ancestors. */
  isAncestor: (ancestor: string, descendant: string) => boolean;
  log?: (line: string) => void;
}

/** The message of a thrown value. */
function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() === "" ? "failed with no message" : message;
}

/** The first pinned PR whose base..merge range holds `commit`, by the PR file's order. */
export function pinnedPrOf(
  commit: string,
  prs: Pick<PrsFile, "prs">,
  io: Pick<FollowUpIo, "isAncestor">,
): number | null {
  for (const pr of prs.prs) {
    if (io.isAncestor(commit, pr.mergeSha) && !io.isAncestor(commit, pr.baseSha)) return pr.number;
  }
  return null;
}

type Diffed = { diff: GraphDiff } | { error: string };

/**
 * Diff commit `baseSha` with commit `commit`, both opened through `sides`. The base is asked
 * for first each time, so it's the most recent side and stays open while `commit` opens.
 */
async function diffWith(baseSha: string, commit: string, sides: SideCache): Promise<Diffed> {
  const base = await sides.get(baseSha);
  if ("error" in base) return { error: `the base can't be read: ${base.error}` };
  const head = await sides.get(commit);
  if ("error" in head) return { error: head.error };
  try {
    return {
      diff: diffGraphs(base.side.graph, head.side.graph, {
        contents: { base: base.side.read, head: head.side.read },
      }),
    };
  } catch (error) {
    return { error: messageOf(error) };
  }
}

/** Follow one flagged PR's breaks through the commits after its merge. */
async function followUpPr(
  pr: Flagged,
  prs: PrsFile,
  endSha: string,
  sides: SideCache,
  io: FollowUpIo,
): Promise<FollowedPr> {
  const pinned = prs.prs.find((p) => p.number === pr.number);
  if (!pinned) throw new Error(`#${pr.number} isn't in ${prs.repo}'s PR file`);
  const again = await diffWith(pr.baseSha, pr.mergeSha, sides);
  if ("error" in again) throw new Error(`#${pr.number} can't be diffed again: ${again.error}`);
  if (JSON.stringify(again.diff.broken) !== JSON.stringify(pr.broken)) {
    throw new Error(
      `#${pr.number}'s broken edges don't come out as the replay recorded them; the analyzer differs from the replay's`,
    );
  }

  const later = io.later(pr.mergeSha, endSha);
  const fixed = new Map<string, Fix>();
  const unreadable: FollowedPr["unreadable"] = [];
  let checked = 0;
  const edges = new Set(pr.broken.map((b) => b.edge));
  let lastFlags: Set<string> | undefined;
  for (const commit of later) {
    if (fixed.size === edges.size) break;
    checked++;
    const result = await diffWith(pr.baseSha, commit, sides);
    if ("error" in result) {
      unreadable.push({ sha: commit, error: result.error });
      lastFlags = undefined;
      continue;
    }
    const flags = new Set(result.diff.broken.map((b) => b.edge));
    lastFlags = flags;
    for (const broken of pr.broken) {
      if (fixed.has(broken.edge) || flags.has(broken.edge)) continue;
      fixed.set(broken.edge, {
        sha: commit,
        committedAt: io.committedAt(commit),
        how: howFixed(result.diff, broken),
        pr: pinnedPrOf(commit, prs, io),
      });
    }
    io.log?.(
      `${prs.repo} #${pr.number}: ${commit.slice(0, 7)} ${fixed.size} of ${edges.size} fixed`,
    );
  }

  // What endSha says: known if the scan reached it, else diffed now.
  let end: Set<string> | "unreadable";
  if (checked === later.length && later.at(-1) === endSha) {
    end = lastFlags ?? "unreadable";
  } else {
    const result = await diffWith(pr.baseSha, endSha, sides);
    end = "error" in result ? "unreadable" : new Set(result.diff.broken.map((b) => b.edge));
  }

  return {
    number: pr.number,
    baseSha: pr.baseSha,
    mergeSha: pr.mergeSha,
    mergedAt: pinned.mergedAt,
    later: later.length,
    checked,
    unreadable,
    breaks: pr.broken.map((broken) => ({
      edge: broken.edge,
      reason: broken.reason,
      fixed: fixed.get(broken.edge) ?? null,
      atEnd: end === "unreadable" ? "unreadable" : end.has(broken.edge) ? "flagged" : "clear",
    })),
  };
}

/**
 * Follow up every flagged PR of `raw` (the replay of `prs`) through the commits after it, up
 * to `repo.endSha`, and return the follow-up file.
 */
export async function followUpRepo(
  raw: RawFile,
  prs: PrsFile,
  repo: Pick<BacktestRepo, "endSha">,
  run: ReplayRun,
  io: FollowUpIo,
): Promise<FollowUpFile> {
  if (raw.repo !== prs.repo)
    throw new Error(`the raw file is ${raw.repo}, the PR file ${prs.repo}`);
  if (raw.run.analyzerVersion !== run.analyzerVersion) {
    throw new Error(
      `${raw.repo} was replayed with analyzer ${raw.run.analyzerVersion}, this is ${run.analyzerVersion}`,
    );
  }
  // The base stays open while each later commit is opened and diffed with it.
  const sides = new SideCache(io.open);
  const followed: FollowedPr[] = [];
  try {
    for (const pr of flaggedPrs(raw))
      followed.push(await followUpPr(pr, prs, repo.endSha, sides, io));
  } finally {
    await sides.closeAll();
  }
  return { repo: raw.repo, run, replay: raw.run.gitinside, endSha: repo.endSha, prs: followed };
}

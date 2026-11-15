import {
  COMPUTE_ALLOWANCE,
  findComputePause,
  findPublishedAnalysis,
  isPrivateSnapshot,
  listAnalysisCounts,
  listAnalysisStates,
  type AnalysisCounts,
  type AnalysisState,
  type AnyDatabase,
} from "@gitinside/db";
import type { CodeSizeCache } from "./codeSize";
import { QUEUE_UNAVAILABLE, type EnqueueDeps } from "./enqueue";
import {
  fetchFirstParents,
  resolveRepo,
  type BranchCommit,
  type GitHubOptions,
  type ResolvedRepo,
} from "./github";
import { queueHead } from "./repoView";
import { parseRepoPath, type RepoRef } from "./repoUrl";

/**
 * The architecture timeline's series (M11.4b, ADR-0295, ADR-0301, ADR-0302):
 * `GET /api/timeline/<owner>/<repo>` answers a public repo's default branch's newest
 * {@link TIMELINE_COMMITS} first-parent commits, each with where its analysis by this analyzer
 * version stands and, when kept, its counts (services, files, nodes, edges, unresolved, broken).
 * Step diffs are worked out in the browser from the two CDN-cached graphs, never here.
 *
 * - **Only a repo someone already analyzed** (a published analysis, so public and not hidden):
 *   any other name is `404 NOT_ANALYZED` before GitHub is asked, like a name nobody analyzed,
 *   so the timeline can't start a repo's first analysis around `/api/analyze`'s limits, and a
 *   private repo's name answers exactly as an unknown one.
 * - **GitHub is asked** for the repo (it must still be that repo, by GitHub's ID, and public)
 *   and one page of its default branch's commits (`fetchFirstParents`), remembered per repo
 *   for {@link TIMELINE_GITHUB_TTL_MS}, so a busy timeline asks once a minute.
 * - **Each step's state:** `analyzed` (a stored analysis and its counts), `no-counts` (stored,
 *   but finished before M11.4a wrote counts), `not-kept` (retention evicted the analysis; its
 *   counts outlive it, so it isn't analyzed again), `queued` or `running` (with its job), `failed`
 *   (with its code; a failure isn't re-run here, as on the repo page), or `not-analyzed`. A
 *   commit analyzed only privately is `not-analyzed`: a public job analyzes it again (ADR-0239).
 * - **Queuing, cheapest refusal first:** only `not-analyzed` steps, newest first, at most
 *   {@link TIMELINE_QUEUES_PER_REQUEST} per request; none once any of the month's compute
 *   allowances is at {@link TIMELINE_COMPUTE_RATIO} (half, below the 80% pause, so the rest
 *   stays for people's own analyses and the PR bot); then check-on-view's own rules
 *   (`queueHead`: the size hold, GitHub's code count, the 80% pause) and one of the repo's
 *   {@link TIMELINE_QUEUES_PER_HOUR} slots (`timeline:<GitHub ID>`, apart from check-on-view's
 *   `repo:` and the PR bot's `diffs:`), refunded when no new job was made. The first refusal
 *   stops the request's queuing and is said in `queueing`.
 */

/** Commits in a timeline: the default branch's newest first-parent commits. */
export const TIMELINE_COMMITS = 12;
/** Not-analyzed commits one timeline request may queue. */
export const TIMELINE_QUEUES_PER_REQUEST = 2;
/** Commits the timeline may queue per repo per hour (`timeline:<GitHub ID>`). */
export const TIMELINE_QUEUES_PER_HOUR = 6;
/** The share of any compute allowance at which the timeline stops queuing (ADR-0295). */
export const TIMELINE_COMPUTE_RATIO = 0.5;
/** How long GitHub's answer for a repo's timeline is trusted. */
export const TIMELINE_GITHUB_TTL_MS = 60_000;

/** GitHub's answer for a timeline: the repo and its first-parent commits, newest first. */
export interface TimelineCommits {
  repo: ResolvedRepo;
  commits: BranchCommit[];
}

/** Recent {@link TimelineCommits} by repo name. */
export interface TimelineCache {
  get(key: string): TimelineCommits | undefined;
  set(key: string, value: TimelineCommits): void;
}

/** A {@link TimelineCache} in this process's memory, oldest dropped first. */
export function createTimelineCache(
  options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
): TimelineCache {
  const { ttlMs = TIMELINE_GITHUB_TTL_MS, maxEntries = 1_000, now = Date.now } = options;
  const entries = new Map<string, { value: TimelineCommits; expires: number }>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      if (entry.expires > now()) return entry.value;
      entries.delete(key);
      return undefined;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { value, expires: now() + ttlMs });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value as string;
        entries.delete(oldest);
      }
    },
  };
}

/** Everything {@link viewTimeline} talks to. */
export interface TimelineDeps {
  db: AnyDatabase;
  /** Without a queue (not configured), nothing is queued (`queueing: unavailable`). */
  queue: EnqueueDeps["queue"] | undefined;
  github: GitHubOptions;
  /** `@gitinside/analyzer/version`. */
  analyzerVersion: string;
  commits: TimelineCache;
  /** GitHub's code counts by commit (`findTooMuchCode`); without it, asked every time. */
  codeSizes?: CodeSizeCache;
  /** Default {@link TIMELINE_QUEUES_PER_HOUR}. */
  queuesPerHour?: number;
}

/** A step's counts, as stored with its analysis (M11.4a). */
export type StepCounts = Omit<AnalysisCounts, "sha" | "analyzerVersion">;

/** One commit of the timeline, newest first. */
export type TimelineStep = BranchCommit &
  (
    | { state: "analyzed" | "not-kept"; counts: StepCounts }
    | { state: "no-counts" | "not-analyzed" }
    | { state: "queued" | "running"; jobId: string | null }
    | { state: "failed"; errorCode: string }
  );

/** Why this request queued no more than it did. */
export type TimelineQueueing =
  /** Queued what it could: nothing was due, or the rest waits for the next request. */
  | { state: "open" }
  /** The month's compute is at {@link TIMELINE_COMPUTE_RATIO}; `until` the next UTC month. */
  | { state: "budget"; until: string }
  /** The repo's {@link TIMELINE_QUEUES_PER_HOUR} are used this hour. */
  | { state: "limited" }
  /** An analysis of the repo hit `errorCode` (`LIMIT_*`) in the past week (#11). */
  | { state: "too-big"; errorCode: string; until: string }
  /** GitHub counts more TypeScript and JavaScript than is supported (ADR-0154). */
  | { state: "too-much-code"; codeBytes: number }
  /** No queue configured, or it couldn't be reached. */
  | { state: "unavailable" };

/** The timeline's JSON (format 1). */
export interface Timeline {
  format: 1;
  /** GitHub's spelling. */
  owner: string;
  repo: string;
  branch: string;
  analyzerVersion: string;
  steps: TimelineStep[];
  queueing: TimelineQueueing;
}

/** What {@link viewTimeline} found. */
export type TimelineResult =
  | { status: "ok"; timeline: Timeline }
  /** No published analysis of the name: nobody analyzed it, it's private, or it's hidden. */
  | { status: "not-analyzed" }
  /** GitHub doesn't show the repo (any more), or the name is another repo's now. */
  | { status: "missing" }
  /** GitHub couldn't be asked (down, rate limited, an answer we can't read). */
  | { status: "github-unavailable" };

/** GitHub's answer for `ref`, remembered per name; `missing` or `github-unavailable` if none. */
async function timelineCommits(
  ref: RepoRef,
  deps: TimelineDeps,
): Promise<TimelineCommits | "missing" | "github-unavailable"> {
  const key = `${ref.owner}/${ref.repo}`.toLowerCase();
  const cached = deps.commits.get(key);
  if (cached !== undefined) return cached;
  const resolved = await resolveRepo(ref, deps.github);
  if (!resolved.ok) {
    const { code } = resolved;
    const gone = code === "REPO_NOT_FOUND" || code === "REPO_UNAVAILABLE" || code === "REPO_EMPTY";
    return gone ? "missing" : "github-unavailable";
  }
  const listed = await fetchFirstParents(resolved.repo, TIMELINE_COMMITS, deps.github);
  if (!listed.ok) return listed.code === "REPO_NOT_FOUND" ? "missing" : "github-unavailable";
  const value = { repo: resolved.repo, commits: listed.commits };
  deps.commits.set(key, value);
  return value;
}

/** Each commit's step from its analysis row and counts row (either may be absent). */
function stepsOf(
  commits: readonly BranchCommit[],
  states: readonly AnalysisState[],
  counts: readonly AnalysisCounts[],
): TimelineStep[] {
  const stateBySha = new Map(states.map((row) => [row.sha, row]));
  const countsBySha = new Map(counts.map((row) => [row.sha, row]));
  return commits.map((commit): TimelineStep => {
    const row = stateBySha.get(commit.sha);
    const counted = countsBySha.get(commit.sha);
    const stored =
      counted === undefined
        ? undefined
        : {
            services: counted.services,
            files: counted.files,
            nodes: counted.nodes,
            edges: counted.edges,
            unresolved: counted.unresolved,
            broken: counted.broken,
          };
    switch (row?.status) {
      case undefined:
        return stored === undefined
          ? { ...commit, state: "not-analyzed" }
          : { ...commit, state: "not-kept", counts: stored };
      case "done":
        // Analyzed privately and public now: a public job analyzes it again (ADR-0239).
        if (isPrivateSnapshot(row.snapshotKey)) return { ...commit, state: "not-analyzed" };
        return stored === undefined
          ? { ...commit, state: "no-counts" }
          : { ...commit, state: "analyzed", counts: stored };
      case "queued":
      case "running":
        return { ...commit, state: row.status, jobId: row.jobId };
      case "failed":
        // A task that was never created failed no analysis: due again, as on the repo page.
        if (row.errorCode === QUEUE_UNAVAILABLE) return { ...commit, state: "not-analyzed" };
        // `failed` rows always carry a code (schema.ts); the fallback is the worker's own.
        return { ...commit, state: "failed", errorCode: row.errorCode ?? "WORKER_ERROR" };
    }
  });
}

/** Read every commit's analysis and counts rows, and make the steps. */
async function readSteps(
  repoId: string,
  commits: readonly BranchCommit[],
  deps: TimelineDeps,
): Promise<TimelineStep[]> {
  const query = { repoId, analyzerVersion: deps.analyzerVersion, shas: commits.map((c) => c.sha) };
  const [states, counts] = await Promise.all([
    listAnalysisStates(deps.db, query),
    listAnalysisCounts(deps.db, query),
  ]);
  return stepsOf(commits, states, counts);
}

/**
 * Queue up to {@link TIMELINE_QUEUES_PER_REQUEST} of `due` (newest first) under the module's
 * rules; returns why it stopped and whether it asked the queue at all.
 */
async function queueDue(
  repo: ResolvedRepo,
  due: readonly string[],
  deps: TimelineDeps,
): Promise<{ queueing: TimelineQueueing; asked: boolean }> {
  const open: TimelineQueueing = { state: "open" };
  if (due.length === 0) return { queueing: open, asked: false };
  const { queue } = deps;
  if (queue === undefined) return { queueing: { state: "unavailable" }, asked: false };
  const budget = await findComputePause(deps.db, COMPUTE_ALLOWANCE, TIMELINE_COMPUTE_RATIO);
  if (budget !== undefined) {
    return { queueing: { state: "budget", until: budget.until.toISOString() }, asked: false };
  }
  const slot = {
    key: `timeline:${repo.providerRepoId}`,
    perHour: deps.queuesPerHour ?? TIMELINE_QUEUES_PER_HOUR,
  };
  const queueDeps = {
    db: deps.db,
    queue,
    analyzerVersion: deps.analyzerVersion,
    ...(deps.codeSizes !== undefined && { codeSizes: deps.codeSizes }),
  };
  for (const sha of due.slice(0, TIMELINE_QUEUES_PER_REQUEST)) {
    const head = { ...repo, sha, visibility: "public" as const };
    const next = await queueHead(head, false, queueDeps, deps.github, slot);
    if (next.state !== "behind") continue;
    switch (next.reason) {
      case "limited":
        return { queueing: { state: "limited" }, asked: true };
      case "paused":
        return { queueing: { state: "budget", until: next.until }, asked: true };
      case "too-big":
        return {
          queueing: { state: "too-big", errorCode: next.errorCode, until: next.until },
          asked: true,
        };
      case "too-much-code":
        return { queueing: { state: "too-much-code", codeBytes: next.codeBytes }, asked: true };
      default:
        // `unavailable`, or an installation's refusal, which a public job never meets.
        return { queueing: { state: "unavailable" }, asked: true };
    }
  }
  return { queueing: open, asked: true };
}

/** The timeline of `ref`'s default branch, queuing what's due (see the module's notes). */
export async function viewTimeline(ref: RepoRef, deps: TimelineDeps): Promise<TimelineResult> {
  const published = await findPublishedAnalysis(deps.db, { owner: ref.owner, name: ref.repo });
  if (published === undefined) return { status: "not-analyzed" };
  const found = await timelineCommits(ref, deps);
  if (found === "missing" || found === "github-unavailable") return { status: found };
  const { repo, commits } = found;
  // The name belongs to a different repo now (the analyzed one was renamed or deleted).
  if (repo.providerRepoId !== published.repo.providerRepoId) return { status: "missing" };

  const repoId = published.repo.id;
  let steps = await readSteps(repoId, commits, deps);
  const due = steps.filter((step) => step.state === "not-analyzed").map((step) => step.sha);
  const { queueing, asked } = await queueDue(repo, due, deps);
  // What the queue wrote (or a racing job finished) shows in the answer.
  if (asked) steps = await readSteps(repoId, commits, deps);
  return {
    status: "ok",
    timeline: {
      format: 1,
      owner: repo.owner,
      repo: repo.name,
      branch: repo.defaultBranch,
      analyzerVersion: deps.analyzerVersion,
      steps,
      queueing,
    },
  };
}

/** A JSON answer that's never cached: a timeline changes as its commits are analyzed. */
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * `GET /api/timeline/<owner>/<repo>`: `200` with the {@link Timeline}; `404 NOT_FOUND` for a
 * malformed name or a repo GitHub doesn't show; `404 NOT_ANALYZED` for a name with no published
 * analysis; `503 GITHUB_UNAVAILABLE` when GitHub can't be asked; `503 UNAVAILABLE` without the
 * database (`deps` undefined) or when it fails (logged by name only).
 */
export async function handleTimelineRequest(
  params: { owner: string; repo: string },
  deps: TimelineDeps | undefined,
): Promise<Response> {
  const ref = parseRepoPath(params.owner, params.repo);
  if (ref === null) return json({ error: "NOT_FOUND" }, 404);
  if (deps === undefined) return json({ error: "UNAVAILABLE" }, 503);
  let result: TimelineResult;
  try {
    result = await viewTimeline(ref, deps);
  } catch (error) {
    // By name only: a driver error's message can carry connection details.
    console.error(
      JSON.stringify({
        event: "timeline_failed",
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
    return json({ error: "UNAVAILABLE" }, 503);
  }
  switch (result.status) {
    case "ok":
      return json(result.timeline);
    case "not-analyzed":
      return json({ error: "NOT_ANALYZED" }, 404);
    case "missing":
      return json({ error: "NOT_FOUND" }, 404);
    case "github-unavailable":
      return json({ error: "GITHUB_UNAVAILABLE" }, 503);
  }
}

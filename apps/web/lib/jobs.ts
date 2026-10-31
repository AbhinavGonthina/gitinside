import {
  describeFound,
  describeProgress,
  describeTimeLeft,
  formatCount,
  type FoundLine,
  type JobStage,
} from "@gitinside/worker/progress";
import { SUPPORTED_SIZE, SUPPORTED_SOURCE_FILES, SUPPORTED_SOURCE_SIZE } from "./limits";
import { UNAVAILABLE_MESSAGE } from "./messages";
import type { WorkerJobStatus } from "./worker";

/**
 * What the progress page shows for a job (UX.md "Analyze", ADR-0067): the worker's status
 * turned into words once, on the server, so `GET /api/jobs/:id` and its SSE variant send the
 * same thing and the browser only renders it.
 */

/** The steps the page lists, in order: waiting for a slot, then the worker's stages. */
export type ProgressStep = "queue" | JobStage;

/** The list on the progress page, with each step's label. */
export const PROGRESS_STEPS: readonly { step: ProgressStep; label: string }[] = [
  { step: "queue", label: "In the queue" },
  { step: "download", label: "Downloading" },
  { step: "extract", label: "Unpacking" },
  { step: "analyze", label: "Analyzing" },
  { step: "upload", label: "Saving the diagram" },
];

/** One job, as the progress page sees it. */
export type JobView =
  /** Waiting for a worker slot. `text`: "2 ahead of you", "You're next", "Waiting in the queue". */
  | { state: "queued"; step: "queue"; progress: 0; text: string; position?: number }
  /**
   * Running `step`; `text` is the worker's current words ("Parsing 1,204 files"), `found`
   * what the analyzer has found so far (#8), empty until it finds something. {@link jobView}
   * always sets it; a page still open from before #8 gets views without it. `timeLeft`, once
   * the worker can estimate it (ADR-0136): "About 40 s left", or "Taking longer than usual".
   */
  | {
      state: "running";
      step: JobStage;
      progress: number;
      text: string;
      found?: FoundLine[];
      timeLeft?: string;
    }
  /** The diagram is saved: the page opens it. */
  | { state: "done" }
  /** It failed: `message` says what happened and what to do; `retry` if trying again could help. */
  | { state: "failed"; errorCode: string; message: string; retry: boolean }
  /** The worker doesn't know this job (never added, or past its 24 hours). */
  | { state: "missing"; message: string }
  /** The worker can't be reached right now; the page keeps listening. */
  | { state: "unavailable"; message: string };

/** The states after which nothing changes, so the stream ends. */
export function isFinal(view: JobView): boolean {
  return view.state === "done" || view.state === "failed" || view.state === "missing";
}

export const MISSING_MESSAGE =
  "We couldn't find this analysis. It may have finished over a day ago: open the diagram, or analyze the repo again.";

const NOT_PUBLIC = {
  reason: "We couldn't find a public GitHub repo with that name.",
  advice: "Private repos aren't supported yet.",
};
const SMALLER = "Try a smaller repo.";
const ON_OUR_SIDE = "The analysis failed on our side. Try again.";
const SUPPORTED = `GitInside analyzes repos ${SUPPORTED_SIZE}.`;
const MANY_SERVICES = "A repo with many services can";
const UNDER_SIZE = `even under ${SUPPORTED_SOURCE_SIZE} of source code.`;

/**
 * Failures that would fail again on the same commit, in UX.md's voice: what happened, then
 * what to do. Anything else (a download that dropped, a worker restart, a crash) is
 * {@link ON_OUR_SIDE} with a retry. The numbers are the limits in docs/SECURITY.md T3. The
 * two size limits say the supported size (M5.16c); memory and time are only checked once a
 * repo is within it, so they say a repo that size can still be too much (cal.com's 113
 * services took 2.4× VS Code's time per MB, bench/results/2026-10-31-capped-vscode.md).
 */
const PERMANENT: Readonly<Record<string, { reason: string; advice?: string }>> = {
  LIMIT_FILES: {
    reason: `This repo has over ${formatCount(SUPPORTED_SOURCE_FILES)} source files. ${SUPPORTED}`,
    advice: SMALLER,
  },
  LIMIT_SOURCE_SIZE: {
    reason: `This repo has over ${SUPPORTED_SOURCE_SIZE} of source code. ${SUPPORTED}`,
    advice: SMALLER,
  },
  LIMIT_SIZE: {
    reason: "This repo is over 500 MB unpacked, the limit for one analysis.",
    advice: SMALLER,
  },
  LIMIT_ENTRIES: {
    reason: "This repo has over 100,000 files and folders, the limit for one analysis.",
    advice: SMALLER,
  },
  LIMIT_TIME: {
    reason: `The analysis took over 5 minutes, the limit for one repo. ${MANY_SERVICES} take that long ${UNDER_SIZE}`,
    advice: SMALLER,
  },
  LIMIT_MEMORY: {
    reason: `The analysis needed more memory than one repo may use. ${MANY_SERVICES} need that much ${UNDER_SIZE}`,
    advice: SMALLER,
  },
  REPO_NOT_FOUND: NOT_PUBLIC,
  REPO_NOT_PUBLIC: NOT_PUBLIC,
  REPO_UNAVAILABLE: { reason: "GitHub has blocked access to that repo." },
  TAR_INVALID: {
    reason: "GitHub's download of this repo couldn't be read, so it wasn't analyzed.",
  },
  TAR_UNSAFE_PATH: {
    reason: "GitHub's download of this repo has paths outside the repo, so it wasn't analyzed.",
  },
};

/**
 * What happened, in one sentence, when `errorCode` would fail again on the same commit;
 * `undefined` when trying again could help. The repo page uses it to explain a failed latest
 * commit without offering "Analyze again" (M5 review).
 */
export function permanentFailure(errorCode: string): string | undefined {
  return Object.hasOwn(PERMANENT, errorCode) ? PERMANENT[errorCode]?.reason : undefined;
}

/** The page's words for a failed job. */
export function failureView(errorCode: string): Extract<JobView, { state: "failed" }> {
  const entry = Object.hasOwn(PERMANENT, errorCode) ? PERMANENT[errorCode] : undefined;
  if (entry === undefined) return { state: "failed", errorCode, message: ON_OUR_SIDE, retry: true };
  const message = entry.advice === undefined ? entry.reason : `${entry.reason} ${entry.advice}`;
  return { state: "failed", errorCode, message, retry: false };
}

/** "2 ahead of you" for a waiting job (0 ahead: "You're next"). */
export function queueText(position: number | undefined): string {
  if (position === undefined) return "Waiting in the queue";
  if (position === 0) return "You're next";
  return `${formatCount(position)} ahead of you`;
}

/**
 * The view for a worker status (`undefined`: the worker doesn't know the job). Diff jobs are
 * the PR bot's (M8), never shown here, so they read as missing.
 */
export function jobView(status: WorkerJobStatus | undefined): JobView {
  if (status === undefined || status.kind !== "analyze") {
    return { state: "missing", message: MISSING_MESSAGE };
  }
  switch (status.state) {
    case "queued":
      return {
        state: "queued",
        step: "queue",
        progress: 0,
        text: queueText(status.position),
        ...(status.position === undefined ? {} : { position: status.position }),
      };
    case "running": {
      // Running but no progress stored yet: the download is what starts first.
      const stage = status.stage ?? "download";
      return {
        state: "running",
        step: stage,
        progress: status.progress ?? 0,
        text: describeProgress(stage, status.step, status.count),
        found: status.found === undefined ? [] : describeFound(status.found),
        ...(status.leftMs === undefined ? {} : { timeLeft: describeTimeLeft(status.leftMs) }),
      };
    }
    case "done":
      return { state: "done" };
    case "failed":
      return failureView(status.errorCode ?? "WORKER_ERROR");
  }
}

/** The view while the worker can't be reached. */
export const UNAVAILABLE_VIEW: Extract<JobView, { state: "unavailable" }> = {
  state: "unavailable",
  message: UNAVAILABLE_MESSAGE,
};

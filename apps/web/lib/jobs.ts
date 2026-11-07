import type { JobRecord } from "@gitinside/db";
import {
  describeFound,
  describeProgress,
  describeTimeLeft,
  formatCount,
  parseRecordedProgress,
  timeLeft,
  type FoundLine,
  type JobStage,
} from "@gitinside/worker/progress";
import {
  ANALYSIS_TIME_LIMIT,
  NBSP,
  SUPPORTED_ENTRIES,
  SUPPORTED_SIZE,
  SUPPORTED_SOURCE_FILES,
  SUPPORTED_SOURCE_SIZE,
  SUPPORTED_UNPACKED_MB,
} from "./limits";
import { UNAVAILABLE_MESSAGE } from "./messages";

/**
 * What the progress page shows for a job (UX.md "Analyze", ADR-0067): the job's `analyses`
 * row (ADR-0139) turned into words once, on the server, so `GET /api/jobs/:id` and its SSE
 * variant send the same thing and the browser only renders it.
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
  /** No row has this job (never queued, or removed since), or it isn't public. */
  | { state: "missing"; message: string }
  /** The database can't be reached right now; the page keeps listening. */
  | { state: "unavailable"; message: string };

/** The states after which nothing changes, so the stream ends. */
export function isFinal(view: JobView): boolean {
  return view.state === "done" || view.state === "failed" || view.state === "missing";
}

export const MISSING_MESSAGE =
  "We couldn't find this analysis. It may have been removed since: open the diagram, or analyze the repo again.";

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
    reason: `This repo is over ${SUPPORTED_UNPACKED_MB}${NBSP}MB unpacked, the limit for one analysis.`,
    advice: SMALLER,
  },
  LIMIT_ENTRIES: {
    reason: `This repo has over ${formatCount(SUPPORTED_ENTRIES)} files and folders, the limit for one analysis.`,
    advice: SMALLER,
  },
  LIMIT_TIME: {
    reason: `The analysis took over ${ANALYSIS_TIME_LIMIT}, the limit for one repo. ${MANY_SERVICES} take that long ${UNDER_SIZE}`,
    advice: SMALLER,
  },
  LIMIT_MEMORY: {
    reason: `The analysis needed more memory than one repo may use. ${MANY_SERVICES} need that much ${UNDER_SIZE}`,
    advice: SMALLER,
  },
  REPO_NOT_FOUND: NOT_PUBLIC,
  REPO_NOT_PUBLIC: NOT_PUBLIC,
  REPO_UNAVAILABLE: { reason: "GitHub has blocked access to that repo." },
  // A private job's installation (ADR-0227): refused at enqueue, or deleted before it ran.
  INSTALLATION_NOT_FOUND: {
    reason: "GitInside isn't installed on this repo's account any more, so it can't read the repo.",
    advice: "Install GitInside again from your dashboard.",
  },
  INSTALLATION_SUSPENDED: {
    reason: "GitInside is suspended on this repo's account, so it can't read the repo.",
    advice: "An owner of the account can unsuspend it in GitHub's settings.",
  },
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

const UTC_TIME = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

/** "Nov 8, 2026, 3:04 PM UTC": the same on the server and in any browser. */
export function formatUtc(at: Date): string {
  return `${UTC_TIME.format(at)} UTC`;
}

/**
 * Why a repo isn't analyzed again yet after an earlier analysis hit `errorCode` (a `LIMIT_*`
 * code), and when it will be (#11, ADR-0153): what happened, then what changes it.
 */
export function sizeHoldMessage(errorCode: string, until: Date): string {
  const reason = permanentFailure(errorCode);
  return [
    "An earlier analysis of this repo hit a limit.",
    ...(reason === undefined ? [] : [reason]),
    `It won't be analyzed again until ${formatUtc(until)}, or sooner if it shrinks to half its size.`,
  ].join(" ");
}

/**
 * Why a repo with `codeBytes` of TypeScript and JavaScript by GitHub's count isn't analyzed
 * (`findTooMuchCode`, ADR-0154): GitHub's number, then the supported size.
 */
export function tooMuchCodeReason(codeBytes: number): string {
  const mb = formatCount(Math.floor(codeBytes / (1024 * 1024)));
  return `GitHub counts over ${mb}${NBSP}MB of TypeScript and JavaScript in this repo. ${SUPPORTED}`;
}

/**
 * Why no new analysis starts while the month's compute is at 80% of Google's free allowance
 * (`findComputePause`, ADR-0156), and that what's already there still works.
 */
export function pausedMessage(until: Date): string {
  return `Analysis is paused until ${formatUtc(until)}: GitInside has used most of this month's free compute. Diagrams already made still work.`;
}

/** {@link tooMuchCodeReason} and what to do, for `/api/analyze`'s refusal. */
export function tooMuchCodeMessage(codeBytes: number): string {
  return `${tooMuchCodeReason(codeBytes)} ${SMALLER}`;
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

/** The shape of our own failure codes; anything else stored is shown as `WORKER_ERROR`. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * The view for a job's row (`undefined`: no row has the job). A private repo's job reads as
 * missing until M8's access check, so nothing about it shows. The row's `progress` is checked
 * with the worker's own parser, and anything malformed is left out (the page then says
 * "Downloading", as for a running row with none yet). The time left is what the worker wrote
 * minus the row's age, both measured on the database's clock (ADR-0140), never compared with
 * this server's.
 */
export function jobView(job: JobRecord | undefined): JobView {
  if (job === undefined || job.visibility !== "public") {
    return { state: "missing", message: MISSING_MESSAGE };
  }
  switch (job.status) {
    case "queued":
      return {
        state: "queued",
        step: "queue",
        progress: 0,
        text: queueText(job.position),
        ...(job.position === undefined ? {} : { position: job.position }),
      };
    case "running": {
      const progress = parseRecordedProgress(job.progress);
      // Running but no progress stored yet: the download is what starts first.
      const stage = progress?.stage ?? "download";
      const leftMs =
        progress?.leftMs === undefined
          ? undefined
          : timeLeft(progress.leftMs, 0, job.progressAgeMs ?? 0);
      return {
        state: "running",
        step: stage,
        progress: progress?.progress ?? 0,
        text: describeProgress(stage, progress?.step, progress?.count),
        found: progress?.found === undefined ? [] : describeFound(progress.found),
        ...(leftMs === undefined ? {} : { timeLeft: describeTimeLeft(leftMs) }),
      };
    }
    case "done":
      return { state: "done" };
    case "failed":
      return failureView(
        job.errorCode !== null && ERROR_CODE.test(job.errorCode) ? job.errorCode : "WORKER_ERROR",
      );
  }
}

/** The view while the worker can't be reached. */
export const UNAVAILABLE_VIEW: Extract<JobView, { state: "unavailable" }> = {
  state: "unavailable",
  message: UNAVAILABLE_MESSAGE,
};

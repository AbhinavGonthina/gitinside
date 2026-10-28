/**
 * Where a running job is, in data and in words (UX.md "Analyze"; ADR-0064).
 *
 * A job moves through four {@link JobStage}s. Inside `analyze`, the child streams the
 * analyzer's own stages (its {@link AnalyzerStep}s) with counts where the analyzer knows
 * them, and the worker stores the latest as BullMQ progress. The progress page (M5.7) turns
 * the stored facts into text with {@link describeProgress}.
 *
 * This module has no dependencies, so the child protocol and the website can import it
 * (`@gitinside/worker/progress`) without loading the analyzer or BullMQ.
 */

/** Where a running job is; `GET /jobs/:id` shows it. */
export type JobStage = "download" | "extract" | "analyze" | "upload";

/** Coarse progress (0–100) at the start of each stage. */
export const STAGE_PROGRESS: Readonly<Record<JobStage, number>> = {
  download: 0,
  extract: 10,
  analyze: 30,
  upload: 90,
};

/**
 * The analyzer's pipeline stages in run order: a copy of the analyzer's `ANALYSIS_STAGES`
 * (progress.test.ts keeps them equal), so checking the child's output needs no analyzer.
 */
export const ANALYZER_STEPS = [
  "inventory",
  "workspace",
  "programs",
  "imports",
  "express",
  "next",
  "prisma",
  "infra",
  "files",
  "symbols",
  "calls",
  "http",
  "sdk",
  "queues",
  "assemble",
] as const;

/** One analyzer stage, as streamed from the child. */
export type AnalyzerStep = (typeof ANALYZER_STEPS)[number];

/** One progress event from the analyzer: a step starting, or its count becoming known. */
export interface StepProgress {
  step: AnalyzerStep;
  /** Source files for `programs`, requests for `http`. */
  count?: number;
}

/** Whether `value` names an analyzer step. */
export function isAnalyzerStep(value: unknown): value is AnalyzerStep {
  return typeof value === "string" && (ANALYZER_STEPS as readonly string[]).includes(value);
}

/**
 * Overall progress at the start of `step`: the analyzer's steps share the span between the
 * `analyze` and `upload` stages evenly, so `inventory` is 30 and `assemble` 86.
 */
export function stepProgress(step: AnalyzerStep): number {
  const span = STAGE_PROGRESS.upload - STAGE_PROGRESS.analyze;
  return (
    STAGE_PROGRESS.analyze +
    Math.floor((span * ANALYZER_STEPS.indexOf(step)) / ANALYZER_STEPS.length)
  );
}

/** `1204` ⇒ `1,204`, the same on every machine (no locale data involved). */
export function formatCount(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const STAGE_TEXT: Readonly<Record<JobStage, string>> = {
  download: "Downloading",
  extract: "Unpacking",
  analyze: "Analyzing",
  upload: "Saving the diagram",
};

const STEP_TEXT: Readonly<Record<AnalyzerStep, string>> = {
  inventory: "Listing files",
  workspace: "Finding packages",
  programs: "Parsing files",
  imports: "Resolving imports",
  express: "Finding Express routes",
  next: "Finding Next.js routes",
  prisma: "Reading Prisma models",
  infra: "Reading docker-compose and .env files",
  files: "Building the file tree",
  symbols: "Finding functions and classes",
  calls: "Linking function calls",
  http: "Finding HTTP calls",
  sdk: "Finding SDK calls",
  queues: "Finding queues",
  assemble: "Assembling the diagram",
};

const plural = (count: number, word: string): string =>
  `${formatCount(count)} ${word}${count === 1 ? "" : "s"}`;

/**
 * The words for a running job: "Downloading", "Parsing 1,204 files", "Linking 87 calls to
 * routes". A step only counts inside `analyze`; elsewhere the stage's own words win.
 */
export function describeProgress(stage: JobStage, step?: AnalyzerStep, count?: number): string {
  if (stage !== "analyze" || step === undefined) return STAGE_TEXT[stage];
  if (count !== undefined && step === "programs") return `Parsing ${plural(count, "file")}`;
  if (count !== undefined && step === "http") return `Linking ${plural(count, "call")} to routes`;
  return STEP_TEXT[step];
}

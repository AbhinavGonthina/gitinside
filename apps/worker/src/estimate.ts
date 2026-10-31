/**
 * How long a running analysis has left, from measured data only (#8, ADR-0136).
 *
 * - **What scales:** each analyzer step's time per source file. The file count is known once
 *   the `programs` step starts (the analyzer reports it), so there's no estimate before that:
 *   not while downloading, unpacking, or listing files.
 * - **Where the rates come from:** the {@link MIN_SAMPLES} or more most recent finished
 *   analyses (their `stats`: files, `stageMs`, `jobMs.upload`), the median rate per step.
 *   Until production has that many, the committed cal.com benchmark
 *   (`bench/results/2026-10-26-analysis-calcom.json`; {@link BENCH_SAMPLE}), which measured no
 *   upload, so with it "Saving the diagram" gets no estimate and the analysis's own doesn't
 *   include it.
 * - **What's sent:** the processor stores, at each step's start, what that step and every
 *   later one should take ({@link expectedMs}) and when it started; the time since is
 *   subtracted on the worker's clock (`timeLeft`, progress.ts), and the database row ages that
 *   on its own clock (ADR-0140). Past the expectation it's 0, which the page shows as
 *   "Taking longer than usual", never a negative number.
 *
 * No dependencies beyond progress.ts.
 */
import { ANALYZER_STEPS, type AnalyzerStep } from "./progress.js";

export { timeLeft } from "./progress.js";

/** One finished analysis's timings, as `analyses.stats` holds them. */
export interface TimingSample {
  /** Source files analyzed. */
  files: number;
  /** Milliseconds per analyzer step. */
  stageMs?: Record<string, number>;
  /** Milliseconds per worker stage. */
  jobMs?: { upload: number };
}

/** Typical times, per source file for the analyzer's steps. */
export interface TimingModel {
  /** Median milliseconds per source file, for each step measured. */
  msPerFile: Partial<Record<AnalyzerStep, number>>;
  /** Median milliseconds to save the diagram, when measured. */
  uploadMs?: number;
  /** Where the numbers come from: past jobs, or the benchmark. */
  source: "jobs" | "bench";
}

/** Finished analyses needed before their timings replace the benchmark's. */
export const MIN_SAMPLES = 5;
/** How many recent analyses the worker reads its rates from. */
export const SAMPLE_LIMIT = 50;

/**
 * The cal.com benchmark (2026-10-26, 5 runs on the dev machine): each step's median time and
 * the graph's file nodes. estimate.test.ts keeps it equal to the committed report.
 */
export const BENCH_SAMPLE: TimingSample = {
  files: 5041,
  stageMs: {
    inventory: 3290,
    workspace: 22,
    programs: 32686,
    imports: 6743,
    express: 64,
    next: 2141,
    prisma: 2621,
    files: 3017,
    symbols: 45,
    calls: 5573,
    assemble: 283,
  },
};

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** The median rates of `samples`, or `undefined` with fewer than `minSamples` usable ones. */
function modelOf(
  samples: readonly TimingSample[],
  minSamples: number,
  source: TimingModel["source"],
): TimingModel | undefined {
  const usable = samples.filter(
    (s) => Number.isSafeInteger(s.files) && s.files > 0 && s.stageMs !== undefined,
  );
  if (usable.length < minSamples) return undefined;
  const msPerFile: Partial<Record<AnalyzerStep, number>> = {};
  for (const step of ANALYZER_STEPS) {
    const rates = usable.flatMap(({ files, stageMs }) => {
      const ms = stageMs?.[step];
      return isTime(ms) ? [ms / files] : [];
    });
    const rate = median(rates);
    if (rate !== undefined) msPerFile[step] = rate;
  }
  const uploadMs = median(usable.flatMap((s) => (isTime(s.jobMs?.upload) ? [s.jobMs.upload] : [])));
  return { msPerFile, ...(uploadMs === undefined ? {} : { uploadMs }), source };
}

/** The model from the benchmark alone: what the worker uses until it has past jobs. */
export const BENCH_MODEL: TimingModel = modelOf([BENCH_SAMPLE], 1, "bench") ?? {
  msPerFile: {},
  source: "bench",
};

/**
 * The model from recent finished analyses (newest first, as many as the worker read), or
 * {@link BENCH_MODEL} while fewer than {@link MIN_SAMPLES} have files and step timings.
 */
export function timingModel(samples: readonly TimingSample[]): TimingModel {
  return modelOf(samples, MIN_SAMPLES, "jobs") ?? BENCH_MODEL;
}

/** Where a job is, for {@link expectedMs}. */
export type EstimatePoint = { stage: "analyze"; step: AnalyzerStep } | { stage: "upload" };

/**
 * Milliseconds the job should take from the start of `at` to the end: this step and every
 * later one at `files` source files, plus saving the diagram if that was measured. `undefined`
 * when it can't be computed: no files known (or none to analyze), or saving with no measured
 * upload time.
 */
export function expectedMs(
  model: TimingModel,
  at: EstimatePoint,
  files: number | undefined,
): number | undefined {
  if (at.stage === "upload") {
    return model.uploadMs === undefined ? undefined : Math.round(model.uploadMs);
  }
  if (files === undefined || files <= 0) return undefined;
  const from = ANALYZER_STEPS.indexOf(at.step);
  const analysis = ANALYZER_STEPS.slice(from).reduce(
    (sum, step) => sum + (model.msPerFile[step] ?? 0) * files,
    0,
  );
  return Math.round(analysis + (model.uploadMs ?? 0));
}

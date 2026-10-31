import { median } from "./report.js";

/** A frame slower than this counts as long (the threshold of Chrome's long animation frames). */
export const LONG_FRAME_MS = 50;

/** Frame rate over one measured run, from `requestAnimationFrame` timestamps (EVALUATION.md §2). */
export interface FrameStats {
  /** Frame intervals measured (timestamps minus one). */
  frames: number;
  /** From the first timestamp to the last. */
  seconds: number;
  /** 1000 / the median frame interval. */
  medianFps: number;
  /** 1000 / the 95th-percentile frame interval: the rate of the slowest 5% of frames. */
  p5Fps: number;
  /** Frames per second over the whole run. */
  meanFps: number;
  /** Frame intervals over {@link LONG_FRAME_MS}. */
  longFrames: number;
  /** The longest frame interval, in ms. */
  worstMs: number;
}

/** The nearest-rank percentile `p` (0–100] of an ascending, non-empty list. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error("percentile of an empty list");
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

/**
 * Median and 5th-percentile fps from frame timestamps (ms, e.g. the
 * `requestAnimationFrame` callback's argument). A frame rate's low tail is
 * its slow frames, so p5 fps comes from the 95th-percentile interval.
 */
export function frameStats(timestamps: readonly number[]): FrameStats {
  if (timestamps.length < 2) throw new Error("frame stats need at least two frames");
  const times = [...timestamps].sort((a, b) => a - b);
  const deltas = times.slice(1).map((t, i) => t - (times[i] as number));
  const sorted = [...deltas].sort((a, b) => a - b);
  const span = (times.at(-1) as number) - (times[0] as number);
  return {
    frames: deltas.length,
    seconds: span / 1000,
    medianFps: 1000 / median(deltas),
    p5Fps: 1000 / percentile(sorted, 95),
    meanFps: (deltas.length * 1000) / span,
    longFrames: deltas.filter((d) => d > LONG_FRAME_MS).length,
    worstMs: sorted.at(-1) as number,
  };
}

import { describe, expect, it } from "vitest";
import { frameStats, percentile } from "./fps.js";

/** Timestamps for frames `deltas` ms apart, from 0. */
function frames(deltas: readonly number[]): number[] {
  const out = [0];
  for (const d of deltas) out.push((out.at(-1) ?? 0) + d);
  return out;
}

describe("percentile", () => {
  it("takes the nearest rank", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 5)).toBe(1);
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile(sorted, 100)).toBe(10);
  });

  it("refuses an empty list", () => {
    expect(() => percentile([], 50)).toThrow(/empty/);
  });
});

describe("frameStats", () => {
  it("reads a steady 60Hz run as 60fps", () => {
    const stats = frameStats(frames(Array(600).fill(1000 / 60)));
    expect(stats.frames).toBe(600);
    expect(stats.seconds).toBeCloseTo(10, 6);
    expect(stats.medianFps).toBeCloseTo(60, 6);
    expect(stats.p5Fps).toBeCloseTo(60, 6);
    expect(stats.meanFps).toBeCloseTo(60, 6);
    expect(stats.longFrames).toBe(0);
  });

  it("takes p5 from the slowest 5% of frames, and counts frames over 50 ms", () => {
    // 90 frames at 10 ms, 10 at 100 ms: the 95th-percentile frame time is 100 ms.
    const stats = frameStats(frames([...Array(90).fill(10), ...Array(10).fill(100)]));
    expect(stats.medianFps).toBeCloseTo(100, 6);
    expect(stats.p5Fps).toBeCloseTo(10, 6);
    expect(stats.longFrames).toBe(10);
    expect(stats.worstMs).toBe(100);
    expect(stats.meanFps).toBeCloseTo(100 / 1.9, 6);
  });

  it("sorts the timestamps first, so their order doesn't matter", () => {
    expect(frameStats([33, 0, 16, 50])).toEqual(frameStats([0, 16, 33, 50]));
  });

  it("needs at least two frames", () => {
    expect(() => frameStats([5])).toThrow(/two frames/);
  });
});

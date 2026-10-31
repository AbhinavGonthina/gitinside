import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Rect } from "../chrome/describe.js";
import { REDUCED_MOTION_QUERY } from "../motion.js";
import { durations } from "../tokens.js";
import type { CameraMotion } from "./gestures.js";
import { GLIDE_SLACK_MS, useGlideSpan } from "./glide.js";

const START: Rect = { x: 0, y: 0, width: 100, height: 50 };
const END: Rect = { x: 1000, y: 400, width: 100, height: 50 };
const LAST: Rect = { x: 2000, y: 0, width: 100, height: 50 };

interface Props {
  visible: Rect | undefined;
  motion: CameraMotion;
  glides: boolean;
}

function mount(initial: Props) {
  return renderHook((p: Props) => useGlideSpan(p.visible, p.motion, p.glides), {
    initialProps: initial,
  });
}

describe("useGlideSpan", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("spans the start and the destination while a glide runs, then only the destination", () => {
    const { result, rerender } = mount({ visible: START, motion: "standard", glides: true });
    expect(result.current).toEqual(START);
    rerender({ visible: END, motion: "standard", glides: true });
    // In the render that moves the camera already.
    expect(result.current).toEqual({ x: 0, y: 0, width: 1100, height: 450 });
    act(() => vi.advanceTimersByTime(durations.standard + GLIDE_SLACK_MS - 1));
    expect(result.current).toEqual({ x: 0, y: 0, width: 1100, height: 450 });
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toEqual(END);
  });

  it("waits as long as the move's motion: a layout glide is longer", () => {
    const { result, rerender } = mount({ visible: START, motion: "layout", glides: true });
    rerender({ visible: END, motion: "layout", glides: true });
    act(() => vi.advanceTimersByTime(durations.standard + GLIDE_SLACK_MS));
    expect(result.current).not.toEqual(END);
    act(() => vi.advanceTimersByTime(durations.layout - durations.standard));
    expect(result.current).toEqual(END);
  });

  it("keeps an interrupted glide's start, and restarts the wait", () => {
    const { result, rerender } = mount({ visible: START, motion: "standard", glides: true });
    rerender({ visible: END, motion: "standard", glides: true });
    act(() => vi.advanceTimersByTime(durations.standard / 2));
    rerender({ visible: LAST, motion: "standard", glides: true });
    expect(result.current).toEqual({ x: 0, y: 0, width: 2100, height: 450 });
    act(() => vi.advanceTimersByTime(durations.standard / 2 + GLIDE_SLACK_MS));
    expect(result.current).toEqual({ x: 0, y: 0, width: 2100, height: 450 });
    act(() => vi.advanceTimersByTime(durations.standard / 2));
    expect(result.current).toEqual(LAST);
  });

  it("is the destination alone for moves that don't glide", () => {
    // The pointer moves the camera at once, and ends a glide under way.
    const { result, rerender } = mount({ visible: START, motion: "standard", glides: true });
    rerender({ visible: END, motion: "standard", glides: true });
    rerender({ visible: LAST, motion: "none", glides: true });
    expect(result.current).toEqual(LAST);
    // Before the first fit has settled.
    rerender({ visible: START, motion: "layout", glides: false });
    expect(result.current).toEqual(START);
    // A first visible rect (the canvas measured).
    const later = mount({ visible: undefined, motion: "layout", glides: true });
    expect(later.result.current).toBeUndefined();
    later.rerender({ visible: END, motion: "layout", glides: true });
    expect(later.result.current).toEqual(END);
  });

  it("is the destination alone under reduced motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === REDUCED_MOTION_QUERY,
      media: query,
    }));
    const { result, rerender } = mount({ visible: START, motion: "layout", glides: true });
    rerender({ visible: END, motion: "layout", glides: true });
    expect(result.current).toEqual(END);
  });

  it("doesn't count a new but equal rect as a move", () => {
    const { result, rerender } = mount({ visible: START, motion: "standard", glides: true });
    rerender({ visible: { ...START }, motion: "standard", glides: true });
    expect(result.current).toEqual(START);
    rerender({ visible: END, motion: "standard", glides: true });
    rerender({ visible: { ...END }, motion: "standard", glides: true });
    expect(result.current).toEqual({ x: 0, y: 0, width: 1100, height: 450 });
  });
});

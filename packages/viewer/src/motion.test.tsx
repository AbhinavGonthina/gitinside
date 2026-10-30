import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prefersReducedMotion, REDUCED_MOTION_QUERY, usePresence } from "./motion.js";
import { durations } from "./tokens.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Stubs `matchMedia` so only the reduced-motion query matches, or nothing does. */
function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: reduce && query === REDUCED_MOTION_QUERY, media: query }) as MediaQueryList,
  );
}

describe("prefersReducedMotion", () => {
  it("is false where matchMedia is missing (jsdom, server rendering)", () => {
    expect(typeof window.matchMedia).toBe("undefined");
    expect(prefersReducedMotion()).toBe(false);
  });

  it("follows the reduced-motion media query", () => {
    stubReducedMotion(true);
    expect(prefersReducedMotion()).toBe(true);
    stubReducedMotion(false);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("usePresence", () => {
  it("stays mounted as closing for the exit, then unmounts", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ open }) => usePresence(open), {
      initialProps: { open: false },
    });
    expect(result.current).toBeNull();
    rerender({ open: true });
    expect(result.current).toBe("open");
    rerender({ open: false });
    expect(result.current).toBe("closing");
    act(() => vi.advanceTimersByTime(durations.fast - 1));
    expect(result.current).toBe("closing");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBeNull();
  });

  it("goes back to open when reopened mid-exit, and the old timer can't unmount it", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ open }) => usePresence(open), {
      initialProps: { open: true },
    });
    rerender({ open: false });
    expect(result.current).toBe("closing");
    rerender({ open: true });
    expect(result.current).toBe("open");
    act(() => vi.advanceTimersByTime(durations.fast * 2));
    expect(result.current).toBe("open");
  });

  it("unmounts at once under reduced motion or with no exit time", () => {
    stubReducedMotion(true);
    const reduced = renderHook(({ open }) => usePresence(open), { initialProps: { open: true } });
    reduced.rerender({ open: false });
    expect(reduced.result.current).toBeNull();

    stubReducedMotion(false);
    const instant = renderHook(({ open }) => usePresence(open, 0), {
      initialProps: { open: true },
    });
    instant.rerender({ open: false });
    expect(instant.result.current).toBeNull();
  });
});

// @vitest-environment node
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { CACHE_TAG_HEADER, purgeRepoCache, repoCacheTag, runLater } from "./cdnCache";

describe("repoCacheTag", () => {
  it("names a repo by GitHub's ID, so a rename or a reused name can't mix two repos", () => {
    expect(repoCacheTag(4242)).toBe("repo-4242");
    expect(CACHE_TAG_HEADER).toBe("vercel-cache-tag");
  });
});

describe("purgeRepoCache", () => {
  it("deletes the repo's tag rather than invalidating it, so nothing stale is served once more", async () => {
    const calls: unknown[][] = [];
    await purgeRepoCache(4242, {
      dangerouslyDeleteByTag: async (...args: unknown[]) => {
        calls.push(args);
      },
    });
    expect(calls).toEqual([["repo-4242"]]);
  });

  it("passes a failure on to the caller", async () => {
    const failing = { dangerouslyDeleteByTag: () => Promise.reject(new Error("429")) };
    await expect(purgeRepoCache(1, failing)).rejects.toThrow("429");
  });

  it("does nothing outside Vercel (no request context), with Vercel's own package", async () => {
    await expect(purgeRepoCache(1)).resolves.toBeUndefined();
  });
});

describe("runLater", () => {
  it("runs the task after the delay, the function kept alive until it ends", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const kept: Promise<unknown>[] = [];
    let ran = 0;
    runLater(
      async () => {
        ran += 1;
      },
      20_000,
      (promise) => kept.push(promise),
    );
    expect(kept).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(ran).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await kept[0];
    expect(ran).toBe(1);
  });

  it("runs outside Vercel too, with Vercel's own waitUntil", async () => {
    let ran = false;
    runLater(async () => {
      ran = true;
    }, 0);
    await vi.waitFor(() => expect(ran).toBe(true));
  });
});

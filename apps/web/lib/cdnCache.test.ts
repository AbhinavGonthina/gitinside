// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CACHE_TAG_HEADER, purgeRepoCache, repoCacheTag } from "./cdnCache";

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

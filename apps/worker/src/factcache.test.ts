import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CACHE_BLOCK_BYTES,
  cacheFolder,
  DEFAULT_FACT_CACHE_BYTES,
  deleteInstallationCache,
  prepareCacheFolder,
} from "./factcache.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gitinside-factcache-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Fill `folder` with `pages` whole pages of entries, last used at `seconds` after the epoch. */
async function fill(folder: string, pages: number, seconds: number): Promise<void> {
  await mkdir(join(folder, "entries", "ab"), { recursive: true });
  for (let page = 0; page < pages; page++) {
    // Exactly one page each.
    await writeFile(
      join(folder, "entries", "ab", `${page}.json.gz`),
      "x".repeat(CACHE_BLOCK_BYTES),
    );
  }
  await utimes(folder, seconds, seconds);
}

describe("cacheFolder", () => {
  it("puts public repos in one folder and each installation's repos in their own", () => {
    expect(cacheFolder(root, {})).toBe(join(root, "public"));
    expect(cacheFolder(root, { visibility: "public" })).toBe(join(root, "public"));
    expect(cacheFolder(root, { installationId: 42 })).toBe(join(root, "installations", "42"));
    expect(cacheFolder(root, { installationId: 42, visibility: "private" })).toBe(
      join(root, "installations", "42"),
    );
  });

  it("gives a private repo without an installation no folder", () => {
    expect(cacheFolder(root, { visibility: "private" })).toBeUndefined();
  });

  it.each([0, -1, 1.5, Number.NaN, 1e21])("gives installation ID %d no folder", (id) => {
    expect(cacheFolder(root, { installationId: id })).toBeUndefined();
  });
});

describe("prepareCacheFolder", () => {
  it("creates the job's folder and gives it the whole cap when nothing else is cached", async () => {
    const dir = join(root, "public");
    expect(await prepareCacheFolder(root, dir)).toEqual({
      dir,
      maxBytes: DEFAULT_FACT_CACHE_BYTES,
    });
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  it("leaves the job's own entries to the child's cache, and touches its folder", async () => {
    const dir = join(root, "public");
    await fill(dir, 6, 1_000);
    expect(await prepareCacheFolder(root, dir, 4 * CACHE_BLOCK_BYTES)).toEqual({
      dir,
      maxBytes: 4 * CACHE_BLOCK_BYTES,
    });
    expect(await readdir(join(dir, "entries", "ab"))).toHaveLength(6);
    expect((await stat(dir)).mtimeMs).toBeGreaterThan(1_000_000);
  });

  it("gives the job's folder what the other folders don't hold", async () => {
    await fill(join(root, "public"), 3, 1_000);
    const dir = join(root, "installations", "7");
    expect(await prepareCacheFolder(root, dir, 10 * CACHE_BLOCK_BYTES)).toEqual({
      dir,
      maxBytes: 7 * CACHE_BLOCK_BYTES,
    });
    expect(existsSync(join(root, "public"))).toBe(true);
  });

  it("deletes other folders whole, least recently used first, until they hold half the cap", async () => {
    await fill(join(root, "public"), 3, 3_000);
    await fill(join(root, "installations", "1"), 3, 1_000);
    await fill(join(root, "installations", "2"), 3, 2_000);
    const dir = join(root, "installations", "3");
    // 9 pages held, half the cap is 5: deleting installation 1 leaves 6, then 2 leaves 3.
    expect(await prepareCacheFolder(root, dir, 10 * CACHE_BLOCK_BYTES)).toEqual({
      dir,
      maxBytes: 7 * CACHE_BLOCK_BYTES,
    });
    expect(await readdir(join(root, "installations"))).toEqual(["3"]);
    expect(existsSync(join(root, "public"))).toBe(true);
  });

  it("counts each file as whole pages", async () => {
    const other = join(root, "public");
    await mkdir(other, { recursive: true });
    await writeFile(join(other, "a"), "x");
    await writeFile(join(other, "b"), "x".repeat(CACHE_BLOCK_BYTES + 1));
    const dir = join(root, "installations", "9");
    expect((await prepareCacheFolder(root, dir, 100 * CACHE_BLOCK_BYTES))?.maxBytes).toBe(
      97 * CACHE_BLOCK_BYTES,
    );
  });

  it("gives no cache when the root can't be used", async () => {
    const file = join(root, "file");
    await writeFile(file, "not a folder");
    expect(await prepareCacheFolder(file, join(file, "public"))).toBeUndefined();
  });
});

describe("deleteInstallationCache", () => {
  it("deletes one installation's facts and nothing else", async () => {
    await fill(join(root, "public"), 1, 1_000);
    await fill(join(root, "installations", "1"), 1, 1_000);
    await fill(join(root, "installations", "12"), 1, 1_000);
    await deleteInstallationCache(root, 1);
    expect(await readdir(join(root, "installations"))).toEqual(["12"]);
    expect(existsSync(join(root, "public"))).toBe(true);
    // Deleting what isn't there, or an ID that can't be one, is fine.
    await deleteInstallationCache(root, 1);
    await deleteInstallationCache(root, 0);
    expect(existsSync(join(root, "public"))).toBe(true);
  });
});

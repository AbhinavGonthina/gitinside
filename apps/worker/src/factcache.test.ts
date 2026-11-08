import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CACHE_BLOCK_BYTES,
  cacheFolder,
  DEFAULT_FACT_CACHE_BYTES,
  prepareCacheFolder,
  purgeUnlinkedFolders,
  type LinkedRepoIds,
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

const REPO_A = "0b3c3f0e-7d6a-4a51-9c3e-2f1d8e5b6a01";
const REPO_B = "5e2a9c1d-3b4f-4e6a-8d7c-9a0b1c2d3e02";
const REPO_C = "9f8e7d6c-5b4a-4321-8fed-cba987654303";

/** An installation's folder for one repo. */
const repoFolder = (id: string, repo: string) => join(root, "installations", id, repo);

describe("cacheFolder", () => {
  it("puts public repos in one folder and each installation's repos in their own", () => {
    expect(cacheFolder(root, {})).toBe(join(root, "public"));
    expect(cacheFolder(root, { visibility: "public", repoId: REPO_A })).toBe(join(root, "public"));
    expect(cacheFolder(root, { installationId: 42, repoId: REPO_A })).toBe(
      repoFolder("42", REPO_A),
    );
    expect(cacheFolder(root, { installationId: 42, repoId: REPO_B, visibility: "private" })).toBe(
      repoFolder("42", REPO_B),
    );
  });

  it("gives a private repo without an installation no folder", () => {
    expect(cacheFolder(root, { visibility: "private" })).toBeUndefined();
  });

  it("gives an installation's job without its repo's row ID no folder", () => {
    expect(cacheFolder(root, { installationId: 42 })).toBeUndefined();
    expect(cacheFolder(root, { installationId: 42, repoId: "../41" })).toBeUndefined();
    expect(cacheFolder(root, { installationId: 42, repoId: REPO_A.toUpperCase() })).toBeUndefined();
  });

  it.each([0, -1, 1.5, Number.NaN, 1e21])("gives installation ID %d no folder", (id) => {
    expect(cacheFolder(root, { installationId: id, repoId: REPO_A })).toBeUndefined();
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
    const dir = repoFolder("7", REPO_A);
    expect(await prepareCacheFolder(root, dir, 10 * CACHE_BLOCK_BYTES)).toEqual({
      dir,
      maxBytes: 7 * CACHE_BLOCK_BYTES,
    });
    expect(existsSync(join(root, "public"))).toBe(true);
  });

  it("deletes other folders whole, least recently used first, until they hold half the cap", async () => {
    await fill(join(root, "public"), 3, 3_000);
    await fill(repoFolder("1", REPO_A), 3, 1_000);
    await fill(repoFolder("1", REPO_B), 3, 2_000);
    const dir = repoFolder("3", REPO_C);
    // 9 pages held, half the cap is 5: deleting repo A leaves 6, then B leaves 3.
    expect(await prepareCacheFolder(root, dir, 10 * CACHE_BLOCK_BYTES)).toEqual({
      dir,
      maxBytes: 7 * CACHE_BLOCK_BYTES,
    });
    expect(await readdir(join(root, "installations", "1"))).toEqual([]);
    expect(await readdir(join(root, "installations", "3"))).toEqual([REPO_C]);
    expect(existsSync(join(root, "public"))).toBe(true);
  });

  it("counts each file as whole pages", async () => {
    const other = join(root, "public");
    await mkdir(other, { recursive: true });
    await writeFile(join(other, "a"), "x");
    await writeFile(join(other, "b"), "x".repeat(CACHE_BLOCK_BYTES + 1));
    const dir = repoFolder("9", REPO_A);
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

describe("purgeUnlinkedFolders (M8.5b2)", () => {
  /** A database stand-in: installation ID → its linked repo row IDs; records each question. */
  function links(linked: Record<number, string[]>) {
    const asked: [number, readonly string[]][] = [];
    const ask: LinkedRepoIds = async (id, repoIds) => {
      asked.push([id, repoIds]);
      return repoIds.filter((repo) => linked[id]?.includes(repo));
    };
    return { asked, ask };
  }

  it("keeps the linked repos' facts and deletes the rest, asking once per installation", async () => {
    await fill(join(root, "public"), 1, 1_000);
    await fill(repoFolder("1", REPO_A), 1, 1_000);
    await fill(repoFolder("1", REPO_B), 1, 1_000);
    await fill(repoFolder("12", REPO_C), 1, 1_000);
    // Repo B was removed from installation 1; installation 12 was uninstalled.
    const { asked, ask } = links({ 1: [REPO_A] });
    expect(await purgeUnlinkedFolders(root, ask)).toBe(2);
    expect(await readdir(join(root, "installations"))).toEqual(["1"]);
    expect(await readdir(join(root, "installations", "1"))).toEqual([REPO_A]);
    expect(await readdir(join(repoFolder("1", REPO_A), "entries", "ab"))).toEqual(["0.json.gz"]);
    expect(existsSync(join(root, "public"))).toBe(true);
    expect(asked).toEqual([
      [1, [REPO_A, REPO_B]],
      [12, [REPO_C]],
    ]);
  });

  it("deletes a repo's facts under an installation it was transferred away from", async () => {
    await fill(repoFolder("1", REPO_A), 1, 1_000);
    await fill(repoFolder("2", REPO_A), 1, 1_000);
    await purgeUnlinkedFolders(root, links({ 2: [REPO_A] }).ask);
    expect(await readdir(join(root, "installations"))).toEqual(["2"]);
  });

  it("deletes names that aren't an installation's or a repo's without asking about them", async () => {
    // The layout before M8.5b2 (entries straight under the installation), and stray names.
    await fill(join(root, "installations", "1"), 1, 1_000);
    await fill(join(root, "installations", "not-an-id"), 1, 1_000);
    await writeFile(join(root, "installations", "7"), "a file");
    const { asked, ask } = links({ 1: ["entries"] });
    expect(await purgeUnlinkedFolders(root, ask)).toBe(2);
    expect(await readdir(join(root, "installations"))).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("deletes nothing when nothing is cached", async () => {
    const { asked, ask } = links({});
    expect(await purgeUnlinkedFolders(root, ask)).toBe(0);
    expect(asked).toEqual([]);
  });

  it("throws when the database can't answer, leaving that installation's folders", async () => {
    await fill(repoFolder("1", REPO_A), 1, 1_000);
    await expect(
      purgeUnlinkedFolders(root, async () => Promise.reject(new Error("database down"))),
    ).rejects.toThrow("database down");
    expect(existsSync(repoFolder("1", REPO_A))).toBe(true);
  });
});

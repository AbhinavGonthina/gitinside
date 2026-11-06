import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { SCHEMA_VERSION } from "@gitinside/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CACHE_BYTES, entryFile, entryKey, openDiskCache } from "./cache.js";
import { ANALYZER_VERSION } from "./version.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitinside-cache-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Set an entry's modification time to `seconds` after the epoch. */
const age = (key: string, seconds: number) => utimes(entryFile(dir, key), seconds, seconds);

/** The total size of every file under `root` (entries and temporary files alike). */
async function folderBytes(root: string): Promise<number> {
  const names = await readdir(root, { recursive: true }).catch(() => [] as string[]);
  let total = 0;
  for (const name of names) {
    const info = await stat(join(root, name)).catch(() => null);
    if (info?.isFile()) total += info.size;
  }
  return total;
}

/** A value whose gzipped entry is roughly `bytes` long (random-looking text barely compresses). */
function bulky(seed: number, bytes: number): string {
  const out: string[] = [];
  let x = seed;
  for (let i = 0; i < bytes / 8; i++) {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    out.push(x.toString(36));
  }
  return out.join(" ");
}

describe("entryKey", () => {
  it("namespaces keys by entry format, schema version, and analyzer version", () => {
    expect(JSON.parse(entryKey("service:web"))).toEqual([
      1,
      SCHEMA_VERSION,
      ANALYZER_VERSION,
      "service:web",
    ]);
    expect(entryFile(dir, "a")).not.toBe(entryFile(dir, "b"));
  });
});

describe("openDiskCache", () => {
  it("misses, then returns what was stored, in this and a later instance", async () => {
    const cache = await openDiskCache(dir);
    expect(await cache.get("k")).toBeUndefined();
    const value = { symbols: [{ id: "x", line: 3 }], ok: true, none: null, text: "é " };
    await cache.put("k", value);
    expect(await cache.get("k")).toEqual(value);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, writes: 1, entries: 1, errors: 0 });

    const reopened = await openDiskCache(dir);
    expect(await reopened.get("k")).toEqual(value);
    expect(reopened.stats()).toMatchObject({
      entries: 1,
      bytes: cache.stats().bytes,
      hits: 1,
      misses: 0,
    });
  });

  it("counts shared entries apart from the caller's own (M6.8c)", async () => {
    const cache = await openDiskCache(dir);
    const shared = { shared: true };
    expect(await cache.get("inputs", shared)).toBeUndefined();
    await cache.put("inputs", { files: [] }, shared);
    await cache.put("own", { facts: 1 });
    expect(await cache.get("inputs", shared)).toEqual({ files: [] });
    expect(await cache.get("inputs", shared)).toEqual({ files: [] });
    expect(await cache.get("own")).toEqual({ facts: 1 });
    expect(cache.stats()).toMatchObject({
      hits: 1,
      misses: 0,
      writes: 1,
      shared: { hits: 2, misses: 1, writes: 1 },
      entries: 2,
    });
    // A copy: changing it doesn't change the cache's counts.
    cache.stats().shared.hits = 99;
    expect(cache.stats().shared.hits).toBe(2);
  });

  it("stores a value as it was when put, with puts side by side (M6.8b)", async () => {
    const cache = await openDiskCache(dir);
    const value = { list: [1] };
    const puts = [cache.put("a", value), cache.put("b", { other: true })];
    value.list.push(2);
    await Promise.all(puts);
    expect(await cache.get("a")).toEqual({ list: [1] });
    expect(await cache.get("b")).toEqual({ other: true });
    expect(cache.stats()).toMatchObject({ writes: 2, entries: 2, errors: 0 });
  });

  it("counts a value JSON can't serialize as an error, without throwing", async () => {
    const cache = await openDiskCache(dir);
    await cache.put("k", { big: 1n });
    expect(cache.stats()).toMatchObject({ writes: 0, entries: 0, errors: 1 });
    expect(await cache.get("k")).toBeUndefined();
  });

  it("keeps key order and drops undefined properties, like JSON", async () => {
    const cache = await openDiskCache(dir);
    await cache.put("k", { b: 1, a: 2, gone: undefined });
    const read = await cache.get("k");
    expect(Object.keys(read as object)).toEqual(["b", "a"]);
    await cache.put("u", undefined);
    expect(await cache.get("u")).toBeUndefined();
    expect(cache.stats().writes).toBe(1);
  });

  it("replaces a key's entry without counting it twice", async () => {
    const cache = await openDiskCache(dir);
    await cache.put("k", "first");
    await cache.put("k", "second, which is longer");
    expect(await cache.get("k")).toBe("second, which is longer");
    const { bytes, entries } = cache.stats();
    expect(entries).toBe(1);
    expect((await openDiskCache(dir)).stats()).toMatchObject({ bytes, entries });
  });

  it("treats a corrupt entry as a miss and deletes it", async () => {
    const cache = await openDiskCache(dir);
    await cache.put("k", [1, 2, 3]);
    await writeFile(entryFile(dir, "k"), "not gzip");
    expect(await cache.get("k")).toBeUndefined();
    expect(existsSync(entryFile(dir, "k"))).toBe(false);
    expect(cache.stats()).toMatchObject({ misses: 1, entries: 0 });
    expect((await openDiskCache(dir)).stats()).toMatchObject({ entries: 0, bytes: 0 });
  });

  it("treats an entry holding another key (a hash collision) as a miss", async () => {
    const cache = await openDiskCache(dir);
    const file = entryFile(dir, "k");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, gzipSync(JSON.stringify({ key: entryKey("other"), value: 1 })));
    expect(await cache.get("k")).toBeUndefined();
    // An older analyzer's entry for the same caller key has another full key, so it's a miss too.
    const older = JSON.stringify([1, SCHEMA_VERSION, "0.0.0-older", "k"]);
    await writeFile(file, gzipSync(JSON.stringify({ key: older, value: 1 })));
    expect(await cache.get("k")).toBeUndefined();
    await writeFile(file, gzipSync(JSON.stringify({ key: entryKey("k") })));
    expect(await cache.get("k")).toBeUndefined();
  });

  it("evicts the least recently used entries down to 90% of the cap", async () => {
    const probe = await openDiskCache(join(dir, "probe"));
    await probe.put("p", bulky(1, 4000));
    const size = probe.stats().bytes;

    // Room for three entries, not four.
    const maxBytes = Math.floor(size * 3.2);
    const cache = await openDiskCache(dir, { maxBytes });
    await cache.put("a", bulky(1, 4000));
    await cache.put("b", bulky(2, 4000));
    await cache.put("c", bulky(3, 4000));
    await age("a", 1_000);
    await age("b", 2_000);
    await age("c", 3_000);
    expect(await cache.get("a")).toEqual(bulky(1, 4000)); // now the most recent

    await cache.put("d", bulky(4, 4000));
    // 4 × size > cap; down to ≤ 2.88 × size means evicting two: b, then c.
    expect(await cache.get("b")).toBeUndefined();
    expect(await cache.get("c")).toBeUndefined();
    expect(await cache.get("a")).toEqual(bulky(1, 4000));
    expect(await cache.get("d")).toEqual(bulky(4, 4000));
    expect(cache.stats()).toMatchObject({ evictions: 2, entries: 2, errors: 0 });
    expect(cache.stats().bytes).toBeLessThanOrEqual(Math.floor(maxBytes * 0.9));
  });

  it("makes room before writing, so the folder never holds more than the cap", async () => {
    const probe = await openDiskCache(join(dir, "probe"));
    await probe.put("p", bulky(1, 4000));
    const size = probe.stats().bytes;

    // Room for two entries: before a third is written, the folder already holds 2 × size.
    const maxBytes = Math.floor(size * 2.5);
    const folder = join(dir, "cache");
    const cache = await openDiskCache(folder, { maxBytes });
    await cache.put("a", bulky(1, 4000));
    await cache.put("b", bulky(2, 4000));
    await utimes(entryFile(folder, "a"), 1_000, 1_000);
    await utimes(entryFile(folder, "b"), 2_000, 2_000);

    // A write that fails once it starts shows the order: room was made before it.
    const shard = dirname(entryFile(folder, "c"));
    await writeFile(shard, "in the way");
    await cache.put("c", bulky(3, 4000));
    expect(await cache.get("a")).toBeUndefined();
    expect(cache.stats()).toMatchObject({ evictions: 1, entries: 1, errors: 1 });
    expect(await readdir(join(folder, "tmp"))).toEqual([]);

    await rm(shard);
    await cache.put("c", bulky(3, 4000));
    expect(await cache.get("b")).toEqual(bulky(2, 4000));
    expect(await cache.get("c")).toEqual(bulky(3, 4000));
    expect(cache.stats()).toMatchObject({ evictions: 1, entries: 2 });
    expect(await folderBytes(folder)).toBeLessThanOrEqual(maxBytes);
  });

  it("makes room for writes started together one at a time", async () => {
    const probe = await openDiskCache(join(dir, "probe"));
    await probe.put("p", bulky(1, 4000));
    const maxBytes = Math.floor(probe.stats().bytes * 2.5);
    const folder = join(dir, "cache");
    const cache = await openDiskCache(folder, { maxBytes });
    await Promise.all([1, 2, 3, 4].map((seed) => cache.put(`k${seed}`, bulky(seed, 4000))));
    expect(cache.stats()).toMatchObject({ writes: 4, errors: 0 });
    expect(cache.stats().entries).toBeLessThanOrEqual(2);
    expect(await folderBytes(folder)).toBeLessThanOrEqual(maxBytes);
    expect(await cache.get("k4")).toEqual(bulky(4, 4000));
  });

  it("evicts on open when the folder holds more than a smaller cap", async () => {
    const big = await openDiskCache(dir);
    await big.put("a", bulky(1, 4000));
    await big.put("b", bulky(2, 4000));
    await big.put("c", bulky(3, 4000));
    const size = big.stats().bytes / 3;
    await age("a", 3_000);
    await age("b", 1_000);
    await age("c", 2_000);

    // Room for two; 90% of it holds one, the most recently used.
    const maxBytes = Math.floor(size * 2.1);
    const small = await openDiskCache(dir, { maxBytes });
    expect(small.stats()).toMatchObject({ evictions: 2, entries: 1 });
    expect(await folderBytes(dir)).toBeLessThanOrEqual(maxBytes);
    expect(await small.get("a")).toEqual(bulky(1, 4000));
    expect(await small.get("b")).toBeUndefined();
    expect(await small.get("c")).toBeUndefined();
  });

  it("counts each entry as whole blocks of `blockBytes`", async () => {
    const cache = await openDiskCache(dir, { blockBytes: 4096 });
    await cache.put("a", "small");
    await cache.put("b", "also small");
    expect(cache.stats()).toMatchObject({ entries: 2, bytes: 2 * 4096 });
    expect((await openDiskCache(dir, { blockBytes: 4096 })).stats().bytes).toBe(2 * 4096);
    // The plain count is the files' own sizes.
    expect((await openDiskCache(dir)).stats().bytes).toBe(await folderBytes(dir));

    // Under a cap of one block and a half, a second tiny entry doesn't fit beside the first.
    const tight = await openDiskCache(join(dir, "tight"), { maxBytes: 6144, blockBytes: 4096 });
    await tight.put("a", "small");
    await tight.put("b", "also small");
    expect(tight.stats()).toMatchObject({ entries: 1, bytes: 4096, evictions: 1 });
    // An entry bigger than the cap once rounded up is never stored.
    const tiny = await openDiskCache(join(dir, "tiny"), { maxBytes: 4095, blockBytes: 4096 });
    await tiny.put("a", "small");
    expect(tiny.stats()).toMatchObject({ entries: 0, writes: 0 });
  });

  it("never stores an entry larger than the cap", async () => {
    const cache = await openDiskCache(dir, { maxBytes: 100 });
    await cache.put("big", bulky(5, 4000));
    expect(await cache.get("big")).toBeUndefined();
    expect(cache.stats()).toMatchObject({ writes: 0, entries: 0, evictions: 0 });
  });

  it("sees other instances' entries, and counts them when evicting", async () => {
    const probe = await openDiskCache(join(dir, "probe"));
    await probe.put("p", bulky(1, 4000));
    const size = probe.stats().bytes;
    const maxBytes = Math.floor(size * 2.5);

    const first = await openDiskCache(dir, { maxBytes });
    const second = await openDiskCache(dir, { maxBytes });
    await first.put("a", bulky(1, 4000));
    await second.put("b", bulky(2, 4000));
    expect(await first.get("b")).toEqual(bulky(2, 4000));
    await first.put("c", bulky(3, 4000));
    expect(first.stats()).toMatchObject({ evictions: 0, entries: 2 });
    await age("a", 1_000);
    await age("b", 2_000);
    await age("c", 3_000);
    // `first` counts three entries, but the listing before evicting finds all four, so it
    // evicts down to two: a, then `second`'s b.
    await first.put("d", bulky(4, 4000));
    expect(first.stats()).toMatchObject({ evictions: 2, entries: 2 });
    expect(await second.get("b")).toBeUndefined();
    expect(await second.get("c")).toEqual(bulky(3, 4000));
    expect(await second.get("d")).toEqual(bulky(4, 4000));
  });

  it("counts other writers' temporary files toward the cap (M6.11f)", async () => {
    const probe = await openDiskCache(join(dir, "probe"));
    await probe.put("p", bulky(1, 4000));
    const size = probe.stats().bytes;

    // A writer killed mid-write a minute ago left a file one and a half entries long.
    const folder = join(dir, "cache");
    const leftover = Math.floor(size * 1.5);
    await mkdir(join(folder, "tmp"), { recursive: true });
    await writeFile(join(folder, "tmp", "killed.tmp"), Buffer.alloc(leftover));
    const maxBytes = Math.floor(size * 3.2);
    const cache = await openDiskCache(folder, { maxBytes });
    expect(cache.stats()).toMatchObject({ entries: 0, bytes: leftover });

    await cache.put("a", bulky(1, 4000));
    await utimes(entryFile(folder, "a"), 1_000, 1_000);
    // The leftover file and two entries are past the cap, so a makes room for b.
    await cache.put("b", bulky(2, 4000));
    expect(cache.stats()).toMatchObject({ entries: 1, evictions: 1, errors: 0 });
    expect(await cache.get("b")).toEqual(bulky(2, 4000));
    expect(await folderBytes(folder)).toBeLessThanOrEqual(maxBytes);
    expect(cache.stats().bytes).toBe(await folderBytes(folder));
  });

  it("lowers its counts only for entries it counted (M6.11f)", async () => {
    const cache = await openDiskCache(dir);
    const other = await openDiskCache(dir);
    // Another instance's entry, written after `cache` listed the folder, then corrupted.
    await other.put("k", [1, 2, 3]);
    await writeFile(entryFile(dir, "k"), "not gzip");
    expect(await cache.get("k")).toBeUndefined();
    expect(existsSync(entryFile(dir, "k"))).toBe(false);
    expect(cache.stats()).toMatchObject({ misses: 1, entries: 0, bytes: 0 });

    // An entry `cache` never counted, replaced by its own write, is counted once.
    await other.put("r", "first, which is longer");
    await cache.put("r", "second");
    expect(cache.stats()).toMatchObject({ entries: 1, writes: 1 });
    expect(cache.stats().bytes).toBe(await folderBytes(dir));
  });

  it("deletes stale temporary files on open and keeps fresh ones", async () => {
    await mkdir(join(dir, "tmp"), { recursive: true });
    await writeFile(join(dir, "tmp", "old.tmp"), "x");
    await writeFile(join(dir, "tmp", "new.tmp"), "x");
    await utimes(join(dir, "tmp", "old.tmp"), 1_000, 1_000);
    await openDiskCache(dir);
    expect(await readdir(join(dir, "tmp"))).toEqual(["new.tmp"]);
  });

  it("ignores files in the folder that aren't entries", async () => {
    await mkdir(join(dir, "entries", "ab"), { recursive: true });
    await writeFile(join(dir, "entries", "ab", "notes.txt"), "hello");
    const cache = await openDiskCache(dir);
    expect(cache.stats()).toMatchObject({ entries: 0, bytes: 0 });
  });

  it("counts a failed write as an error instead of throwing", async () => {
    const cache = await openDiskCache(dir);
    // A file where the entry's shard folder should be makes the write fail.
    const shard = dirname(entryFile(dir, "k"));
    await writeFile(shard, "in the way");
    await expect(cache.put("k", 1)).resolves.toBeUndefined();
    expect(await cache.get("k")).toBeUndefined();
    expect(cache.stats()).toMatchObject({ writes: 0, errors: 1, entries: 0 });
    expect(await readdir(join(dir, "tmp"))).toEqual([]);
  });

  it("defaults to a 2 GB cap", () => {
    expect(DEFAULT_CACHE_BYTES).toBe(2_000_000_000);
  });
});

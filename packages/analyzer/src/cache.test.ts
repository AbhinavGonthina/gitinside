import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
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

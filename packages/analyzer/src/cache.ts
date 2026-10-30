/**
 * Disk cache for incremental analysis facts (M6.7a, ADR-0090; DESIGN.md §9).
 *
 * A content-addressed store of JSON values on local disk, bounded by size and evicted least
 * recently used first. Later stages of M6.7 store per-service facts in it, keyed by the
 * content hashes of the files they were computed from; this module knows nothing about what
 * the values mean.
 *
 * - **Keys** are strings chosen by the caller. The cache prefixes every key with its own entry
 *   format, `SCHEMA_VERSION`, and `ANALYZER_VERSION` ({@link entryKey}), so a new analyzer
 *   never reads an older one's facts. An entry's file is named by the SHA-256 of that full key,
 *   and the full key is stored inside it and compared on read, so a hash collision is a miss.
 * - **Values** go through `JSON.stringify` and `JSON.parse`: plain objects, arrays, strings,
 *   finite numbers, booleans, and `null`. Properties set to `undefined` are dropped, and key
 *   order is kept, so a value of that kind reads back equal.
 * - **Writes** go to a temporary file first and are renamed into place, so a reader (in this or
 *   another process) sees a whole entry or none. Two processes writing one key both write the
 *   same value (facts are deterministic), so the last rename wins harmlessly.
 * - **Size:** entries are gzipped. When the total passes `maxBytes`, the folder is listed again
 *   (other processes may have written to it) and the least recently used entries, by file
 *   modification time, are deleted until the total is at most 90% of `maxBytes`. A read that
 *   hits touches the entry's time. An entry larger than `maxBytes` is never stored.
 * - **Failures never fail an analysis:** an unreadable, corrupt, or mismatched entry is a miss
 *   (and is deleted); a write or eviction that fails is counted in {@link CacheStats.errors}
 *   and otherwise ignored. A miss only costs time, since the caller recomputes the value.
 *
 * Not handled: sharing one folder between machines (times and renames are local-disk
 * semantics), and limits on the entry count (only bytes are bounded).
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { compareStrings, SCHEMA_VERSION } from "@gitinside/schema";
import { ANALYZER_VERSION } from "./version.js";

/** The worker's cache cap (DESIGN.md §9): 2 GB. */
export const DEFAULT_CACHE_BYTES = 2_000_000_000;

/** Version of the entry file layout. Bump it when {@link entryKey} or the file format changes. */
const ENTRY_FORMAT = 1;

/** Eviction deletes entries until the total is at most this share of `maxBytes`. */
const LOW_WATER = 0.9;

/** Temporary files older than this are left over from a crashed writer and are deleted on open. */
const STALE_TMP_MS = 60 * 60 * 1000;

const ENTRY_NAME = /^[0-9a-f]{64}\.json\.gz$/;

/** A store of JSON values by key. A miss answers `undefined`. */
export interface FactCache {
  /** The value stored under `key`, or `undefined` when there is none (or it can't be read). */
  get(key: string): Promise<unknown>;
  /** Store a JSON value under `key` (`undefined` stores nothing). Never throws. */
  put(key: string, value: unknown): Promise<void>;
}

/** What a {@link DiskCache} has done since it was opened, and what it holds now. */
export interface CacheStats {
  hits: number;
  misses: number;
  writes: number;
  /** Entries deleted to stay under the size cap. */
  evictions: number;
  /** Writes, touches, and deletions that failed (ignored otherwise). */
  errors: number;
  /** Bytes held on disk, as last listed plus this instance's own writes since. */
  bytes: number;
  /** Entries held on disk, counted the same way as {@link bytes}. */
  entries: number;
}

/** A {@link FactCache} in a folder on local disk. */
export interface DiskCache extends FactCache {
  /** Counters since opening (a copy). */
  stats(): CacheStats;
}

/** Options for {@link openDiskCache}. */
export interface DiskCacheOptions {
  /** Size cap in bytes of gzipped entries. Defaults to {@link DEFAULT_CACHE_BYTES}. */
  maxBytes?: number;
}

/**
 * The key an entry is stored under: the caller's key namespaced by the entry format, graph
 * schema version, and analyzer version.
 */
export function entryKey(key: string): string {
  return JSON.stringify([ENTRY_FORMAT, SCHEMA_VERSION, ANALYZER_VERSION, key]);
}

/** The file that holds `key`'s entry in the cache folder `dir`. */
export function entryFile(dir: string, key: string): string {
  const hash = createHash("sha256").update(entryKey(key)).digest("hex");
  return join(dir, "entries", hash.slice(0, 2), `${hash}.json.gz`);
}

interface Listed {
  file: string;
  size: number;
  time: number;
}

/** Every entry file in the cache folder with its size and modification time. */
async function listEntries(entriesDir: string): Promise<Listed[]> {
  const listed: Listed[] = [];
  const shards = await readdir(entriesDir).catch(() => [] as string[]);
  for (const shard of shards.sort(compareStrings)) {
    const names = await readdir(join(entriesDir, shard)).catch(() => [] as string[]);
    for (const name of names.sort(compareStrings)) {
      if (!ENTRY_NAME.test(name)) continue;
      const file = join(entriesDir, shard, name);
      const info = await stat(file).catch(() => null);
      if (info?.isFile()) listed.push({ file, size: info.size, time: info.mtimeMs });
    }
  }
  return listed;
}

/** Whether a parsed entry file has the shape {@link DiskCache.put} writes. */
function isEntry(value: unknown): value is { key: string; value: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "key" in value &&
    typeof value.key === "string" &&
    "value" in value
  );
}

/**
 * Open (creating if needed) a disk cache in `dir`, which should be used for nothing else.
 * Lists the existing entries to learn their total size, and deletes temporary files left by
 * writers that crashed over an hour ago. See the file comment for the guarantees.
 */
export async function openDiskCache(
  dir: string,
  options: DiskCacheOptions = {},
): Promise<DiskCache> {
  const maxBytes = options.maxBytes ?? DEFAULT_CACHE_BYTES;
  const entriesDir = join(dir, "entries");
  const tmpDir = join(dir, "tmp");
  await mkdir(entriesDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });

  const now = Date.now();
  for (const name of await readdir(tmpDir)) {
    const file = join(tmpDir, name);
    const info = await stat(file).catch(() => null);
    if (info && now - info.mtimeMs > STALE_TMP_MS) await rm(file, { force: true });
  }

  const counters: CacheStats = {
    hits: 0,
    misses: 0,
    writes: 0,
    evictions: 0,
    errors: 0,
    bytes: 0,
    entries: 0,
  };
  const recount = (listed: readonly Listed[]): void => {
    counters.bytes = listed.reduce((sum, entry) => sum + entry.size, 0);
    counters.entries = listed.length;
  };
  recount(await listEntries(entriesDir));

  /** Delete an entry file, keeping the counters in step. False when it failed. */
  const remove = async (file: string, size: number): Promise<boolean> => {
    try {
      await rm(file, { force: true });
    } catch {
      counters.errors++;
      return false;
    }
    counters.bytes -= size;
    counters.entries--;
    return true;
  };

  /** Delete least recently used entries until the total is at most the low-water mark. */
  const evictNow = async (): Promise<void> => {
    const listed = await listEntries(entriesDir);
    recount(listed);
    listed.sort((a, b) => a.time - b.time || compareStrings(a.file, b.file));
    const target = Math.floor(maxBytes * LOW_WATER);
    for (const entry of listed) {
      if (counters.bytes <= target) break;
      if (await remove(entry.file, entry.size)) counters.evictions++;
    }
  };
  let eviction: Promise<void> | undefined;
  /** Run one eviction at a time; puts that pass the cap meanwhile share it. */
  const evict = (): Promise<void> => {
    eviction ??= evictNow().finally(() => {
      eviction = undefined;
    });
    return eviction;
  };

  return {
    async get(key) {
      const file = entryFile(dir, key);
      let data: Buffer;
      try {
        data = await readFile(file);
      } catch {
        counters.misses++;
        return undefined;
      }
      let value: unknown;
      try {
        const parsed: unknown = JSON.parse(gunzipSync(data).toString("utf8"));
        if (!isEntry(parsed) || parsed.key !== entryKey(key)) throw new Error("not this entry");
        value = parsed.value;
      } catch {
        counters.misses++;
        await remove(file, data.length);
        return undefined;
      }
      counters.hits++;
      const touched = new Date();
      await utimes(file, touched, touched).catch(() => {
        counters.errors++;
      });
      return value;
    },

    async put(key, value) {
      if (value === undefined) return;
      const text = JSON.stringify({ key: entryKey(key), value });
      const body = gzipSync(text);
      if (body.length > maxBytes) return;
      const file = entryFile(dir, key);
      const tmp = join(tmpDir, `${randomUUID()}.tmp`);
      try {
        await writeFile(tmp, body);
        await mkdir(dirname(file), { recursive: true });
        const previous = await stat(file).then(
          (info) => info.size,
          () => undefined,
        );
        await rename(tmp, file);
        counters.bytes += body.length - (previous ?? 0);
        if (previous === undefined) counters.entries++;
        counters.writes++;
      } catch {
        counters.errors++;
        await rm(tmp, { force: true }).catch(() => undefined);
        return;
      }
      if (counters.bytes > maxBytes) await evict();
    },

    stats: () => ({ ...counters }),
  };
}

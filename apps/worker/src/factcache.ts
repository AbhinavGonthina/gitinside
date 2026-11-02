import { mkdir, readdir, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { compareStrings } from "@gitinside/schema";

/**
 * The worker's fact cache folders (M6.7f, ADR-0090, ADR-0178).
 *
 * The analysis child stores each service's facts in a disk cache (`openDiskCache`), so a later
 * job on the same instance (a re-analysis after a push, a PR's base and head) reuses the
 * services that didn't change. On Cloud Run the cache lives in the in-memory `/tmp`, so its
 * room is part of the memory budget (budget.ts: {@link DEFAULT_FACT_CACHE_BYTES}), and it lasts
 * only as long as the instance.
 *
 * - **Folders:** `<root>/public` for public repos, `<root>/installations/<id>` for each GitHub
 *   App installation's repos (M8). The child may read and write only its job's folder
 *   (runner.ts), so facts from one installation's private code never reach another's job, and
 *   {@link deleteInstallationCache} removes all of an installation's facts on uninstall (M8.5).
 *   A private repo without an installation gets no cache.
 * - **One cap for the whole root:** before a job, {@link prepareCacheFolder} deletes other
 *   folders whole, least recently used first (by the folder's time, touched by each job that
 *   uses it), until they hold at most half the cap; the job's folder gets the rest as its own
 *   cap, which the child's cache keeps by evicting entries. Sizes count each file as whole
 *   4 KiB pages, as the in-memory filesystem allocates them.
 * - **Failures are misses:** a folder that can't be listed or deleted makes the job run
 *   without a cache (`undefined`); the analysis itself never fails because of it.
 *
 * Not handled: two workers sharing one root (Cloud Run runs one job per instance, ADR-0143);
 * shard folders' own pages (as in `openDiskCache`).
 */

/** The fact cache's share of the instance's memory: 64 MiB (ADR-0178). */
export const DEFAULT_FACT_CACHE_BYTES = 64 * 1024 * 1024;

/** What the in-memory filesystem rounds each file up to. */
export const CACHE_BLOCK_BYTES = 4096;

/** What a job's cache folder is chosen by. */
export interface CacheOwner {
  /** The GitHub App installation the job runs under (M8), if any. */
  installationId?: number;
  /** What the recorder learned from GitHub; `undefined` without a recorder. */
  visibility?: "public" | "private";
}

/** A job's cache: the folder the child may use and its cap there. */
export interface JobCache {
  dir: string;
  maxBytes: number;
}

const INSTALLATION_ID = /^[1-9][0-9]{0,19}$/;

/** The folder of installation `id`'s facts, or `undefined` for an ID that can't be one. */
function installationFolder(root: string, id: number): string | undefined {
  const name = String(id);
  return INSTALLATION_ID.test(name) ? join(root, "installations", name) : undefined;
}

/**
 * The folder a job's facts belong in: its installation's, else `public` unless the repo is
 * private (a private repo without an installation gets none).
 */
export function cacheFolder(root: string, owner: CacheOwner): string | undefined {
  if (owner.installationId !== undefined) return installationFolder(root, owner.installationId);
  return owner.visibility === "private" ? undefined : join(root, "public");
}

/** The bytes every file under `dir` takes, in whole pages. 0 for a missing folder. */
async function folderBytes(dir: string): Promise<number> {
  const names = await readdir(dir, { recursive: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  let total = 0;
  for (const name of names) {
    const info = await stat(join(dir, name)).catch(() => undefined);
    if (info?.isFile()) total += Math.ceil(info.size / CACHE_BLOCK_BYTES) * CACHE_BLOCK_BYTES;
  }
  return total;
}

/** Every cache folder under `root`: `public` and each installation's. */
async function cacheFolders(root: string): Promise<string[]> {
  const folders = [join(root, "public")];
  const ids = await readdir(join(root, "installations")).catch(() => [] as string[]);
  for (const id of ids.sort(compareStrings)) folders.push(join(root, "installations", id));
  return folders;
}

/**
 * Make room under `root` for a job whose facts belong in `dir` (see the module comment), touch
 * `dir`'s time, and return the job's cache. `undefined` when something failed.
 */
export async function prepareCacheFolder(
  root: string,
  dir: string,
  maxBytes: number = DEFAULT_FACT_CACHE_BYTES,
): Promise<JobCache | undefined> {
  try {
    const others: { folder: string; bytes: number; time: number }[] = [];
    for (const folder of await cacheFolders(root)) {
      if (folder === dir) continue;
      const info = await stat(folder).catch(() => undefined);
      if (info === undefined) continue;
      others.push({ folder, bytes: await folderBytes(folder), time: info.mtimeMs });
    }
    others.sort((a, b) => a.time - b.time || compareStrings(a.folder, b.folder));
    let held = others.reduce((sum, other) => sum + other.bytes, 0);
    for (const other of others) {
      if (held <= maxBytes / 2) break;
      await rm(other.folder, { recursive: true, force: true, maxRetries: 3 });
      held -= other.bytes;
    }
    await mkdir(dir, { recursive: true });
    const now = new Date();
    await utimes(dir, now, now);
    return { dir, maxBytes: maxBytes - held };
  } catch {
    return undefined;
  }
}

/** Delete every fact cached for installation `id` (M8.5's uninstall). */
export async function deleteInstallationCache(root: string, id: number): Promise<void> {
  const folder = installationFolder(root, id);
  if (folder !== undefined) await rm(folder, { recursive: true, force: true, maxRetries: 3 });
}

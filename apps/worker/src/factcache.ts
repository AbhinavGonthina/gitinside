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
 * - **Folders:** `<root>/public` for public repos, `<root>/installations/<id>/<repo row ID>` for
 *   each repo a GitHub App installation's jobs read (M8). The child may read and write only its
 *   job's folder (runner.ts), so facts from one installation's private code never reach
 *   another's job. A private repo without an installation gets no cache.
 * - **Purged at each job's start** (M8.5b2, ADR-0242): the website's uninstall webhook can't
 *   reach the worker's instances, so before every job {@link purgeUnlinkedFolders} asks the
 *   database which cached repos are still linked to their installation and deletes every
 *   other installation folder (an uninstall, a removed repo, a transfer, a name that isn't
 *   one). What a live instance keeps after a deletion lasts until its next job or its end
 *   (`/tmp` is memory), and no job can read it meanwhile: the deleted repo's own jobs are
 *   refused at their start (ADR-0241), and other jobs never get its folder.
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
  /** The repo's row ID, as the recorder's start wrote it; `undefined` without a recorder. */
  repoId?: string;
  /** What the recorder learned from GitHub; `undefined` without a recorder. */
  visibility?: "public" | "private";
}

/**
 * Which of `repoIds` are linked now to the installation with GitHub's ID `installationId`
 * (db's `findLinkedRepoIds`).
 */
export type LinkedRepoIds = (
  installationId: number,
  repoIds: readonly string[],
) => Promise<readonly string[]>;

/** A job's cache: the folder the child may use and its cap there. */
export interface JobCache {
  dir: string;
  maxBytes: number;
}

const INSTALLATION_ID = /^[1-9][0-9]{0,19}$/;
const REPO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The folder a job's facts belong in: its installation's folder for its repo, else `public`
 * unless the repo is private (a private repo without an installation gets none, and so does an
 * installation's job without its repo's row ID).
 */
export function cacheFolder(root: string, owner: CacheOwner): string | undefined {
  if (owner.installationId !== undefined) {
    const id = String(owner.installationId);
    const { repoId } = owner;
    if (!INSTALLATION_ID.test(id) || repoId === undefined || !REPO_ID.test(repoId)) {
      return undefined;
    }
    return join(root, "installations", id, repoId);
  }
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

/** The names in `dir`, sorted; none for a missing folder. */
async function names(dir: string): Promise<string[]> {
  const found = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw error;
  });
  return found.sort(compareStrings);
}

/** Every cache folder under `root`: `public` and each installation's repo's. */
async function cacheFolders(root: string): Promise<string[]> {
  const folders = [join(root, "public")];
  for (const id of await names(join(root, "installations"))) {
    for (const repo of await names(join(root, "installations", id))) {
      folders.push(join(root, "installations", id, repo));
    }
  }
  return folders;
}

const remove = (path: string) => rm(path, { recursive: true, force: true, maxRetries: 3 });

/**
 * Delete every installation folder under `root` that `linked` doesn't confirm: a repo no longer
 * linked to that installation (deleted, removed, or transferred), an installation that's gone,
 * and any name that isn't an installation's or a repo's. One `linked` call per installation
 * folder. Returns how many folders were deleted. Throws if `linked` or the filesystem fails,
 * having deleted what it could decide; the caller then runs the job without a cache.
 */
export async function purgeUnlinkedFolders(root: string, linked: LinkedRepoIds): Promise<number> {
  const installations = join(root, "installations");
  let deleted = 0;
  for (const id of await names(installations)) {
    const folder = join(installations, id);
    if (!INSTALLATION_ID.test(id)) {
      await remove(folder);
      deleted++;
      continue;
    }
    const repos = await names(folder);
    const asked = repos.filter((repo) => REPO_ID.test(repo));
    const kept = new Set(asked.length === 0 ? [] : await linked(Number(id), asked));
    const gone = repos.filter((repo) => !kept.has(repo));
    for (const repo of gone) await remove(join(folder, repo));
    deleted += gone.length;
    if (gone.length === repos.length) await remove(folder);
  }
  return deleted;
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
      await remove(other.folder);
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

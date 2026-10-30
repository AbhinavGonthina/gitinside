/**
 * Observed inputs (ADR-0090, M6.7b): every repo path a service's analysis read or probed,
 * with the answer it got, so a cached copy of the service's facts can be reused only when
 * every one of those questions still gets the same answer.
 *
 * Recorded per service, by its program's compiler host (`program.ts`), which is the only way
 * the program and the per-service detectors reach repo files:
 * - files read (TypeScript sources, configs and their `extends` chain, workspace manifests
 *   read by the module resolver): the SHA-256 of their bytes;
 * - files probed but not read (module resolution candidates): `present` or `absent`;
 * - folders probed (module resolution): whether the inventory has a file under them;
 * - the service's own root files (its folder's listing), so an added file is noticed.
 *
 * A service's analysis also reaches other services' programs, through workspace package
 * imports TypeScript can't resolve and through files of another service that its program
 * loads (`SymbolResolver.reached`). {@link serviceInputs} adds those programs' inputs,
 * transitively, so a service is invalidated by every file whose program it looked into.
 *
 * Not recorded here, because they are global rather than per-service and belong in the cache
 * key (M6.7e): the workspace layout (service keys, folders, package names, from the manifests
 * and workspace configs), the inventory limits, TypeScript's bundled `lib.*.d.ts` files (part
 * of our install, not the repo), and the inputs of global steps (Prisma schemas, compose and
 * `.env` files, file nodes), which always rerun.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compareStrings } from "@gitinside/schema";
import type { SymbolResolver } from "./calls.js";
import type { Inventory } from "./inventory.js";
import type { ServiceProgram } from "./program.js";
import { serviceForFile, type Workspace } from "./workspace.js";

/** Extensions parsed by the TS program. `.prisma` is a source file too, but has its own detector. */
export const PROGRAM_EXTENSIONS: readonly string[] = [
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
];

/**
 * The root files of each service's program, by service key: the source files with a
 * {@link PROGRAM_EXTENSIONS} extension that the service owns ({@link serviceForFile}), in
 * `sourceFiles` order. Services without any are missing from the map.
 */
export function programRootFiles(
  workspace: Workspace,
  sourceFiles: readonly string[],
): Map<string, string[]> {
  const owned = new Map<string, string[]>();
  for (const file of sourceFiles) {
    if (!PROGRAM_EXTENSIONS.some((ext) => file.endsWith(ext))) continue;
    const service = serviceForFile(workspace, file);
    if (!service) continue;
    const list = owned.get(service.key);
    if (list) list.push(file);
    else owned.set(service.key, [file]);
  }
  return owned;
}

/** A probed file that exists, but whose content wasn't read. */
export const PRESENT = "present";
/** A probed file that isn't in the inventory. */
export const ABSENT = "absent";

/**
 * What a service's analysis observed, in serializable form. Every list is sorted by its
 * first element with `compareStrings`, so equal observations serialize to equal bytes.
 */
export interface ObservedInputs {
  /** Root files of each service whose program was used, by service key. */
  listings: [service: string, files: string[]][];
  /** Repo files read or probed: the SHA-256 (hex) of their bytes, {@link PRESENT}, or {@link ABSENT}. */
  files: [path: string, answer: string][];
  /** Repo folders probed: whether the inventory had a file under each (`""` is the root). */
  dirs: [path: string, exists: boolean][];
}

/** Records one service's observations as its analysis runs. */
export interface InputLog {
  /** A file was read; `hash` is the SHA-256 (hex) of its bytes. */
  read(path: string, hash: string): void;
  /** A file was probed and was, or wasn't, in the inventory. */
  probeFile(path: string, exists: boolean): void;
  /** A folder was probed and did, or didn't, contain an inventory file. */
  probeDir(path: string, exists: boolean): void;
  /** What was observed so far, sorted. */
  snapshot(): ObservedInputs;
}

/** The SHA-256 (hex) of a file's bytes, as recorded by {@link InputLog.read}. */
export function contentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Combine two answers for one file: a content hash says more than {@link PRESENT}. */
function stronger(a: string | undefined, b: string): string {
  return a === undefined || a === PRESENT ? b : a;
}

function sorted<T>(entries: Iterable<[string, T]>): [string, T][] {
  return [...entries].sort((a, b) => compareStrings(a[0], b[0]));
}

/** Create an empty log for the service `service` with root files `rootFiles`. */
export function createInputLog(service: string, rootFiles: readonly string[]): InputLog {
  const files = new Map<string, string>();
  const dirs = new Map<string, boolean>();
  const listing: string[] = [...rootFiles].sort(compareStrings);
  return {
    read(path, hash) {
      files.set(path, hash);
    },
    probeFile(path, exists) {
      const answer = exists ? PRESENT : ABSENT;
      files.set(path, stronger(files.get(path), answer));
    },
    probeDir(path, exists) {
      dirs.set(path, exists);
    },
    snapshot: () => ({
      listings: [[service, [...listing]]],
      files: sorted(files),
      dirs: sorted(dirs),
    }),
  };
}

/**
 * The union of several observations of the same run. Within one run a path always gets the
 * same answer, except that one service may only have probed a file another read; the hash wins.
 */
export function mergeInputs(all: readonly ObservedInputs[]): ObservedInputs {
  const listings = new Map<string, string[]>();
  const files = new Map<string, string>();
  const dirs = new Map<string, boolean>();
  for (const inputs of all) {
    for (const [service, list] of inputs.listings) listings.set(service, list);
    for (const [path, answer] of inputs.files) files.set(path, stronger(files.get(path), answer));
    for (const [path, exists] of inputs.dirs) dirs.set(path, exists);
  }
  return { listings: sorted(listings), files: sorted(files), dirs: sorted(dirs) };
}

/**
 * Each service's observed inputs, by service key: its own program's, plus those of every
 * program its analysis reached ({@link SymbolResolver.reached}), transitively. Call after the
 * last stage that uses the resolver.
 */
export function serviceInputs(
  programs: readonly ServiceProgram[],
  resolver: SymbolResolver,
): Map<string, ObservedInputs> {
  const result = new Map<string, ObservedInputs>();
  for (const sp of programs) {
    const seen = new Set<ServiceProgram>([sp]);
    const queue = [sp];
    for (let next = queue.shift(); next; next = queue.shift()) {
      for (const other of resolver.reached(next)) {
        if (seen.has(other)) continue;
        seen.add(other);
        queue.push(other);
      }
    }
    result.set(sp.service.key, mergeInputs([...seen].map((p) => p.inputs.snapshot())));
  }
  return result;
}

/**
 * Checks observed inputs against another checkout of the repo: `verify(inputs)` answers the
 * first input (a path, or `listing:<service>`) that would now get a different answer, or
 * undefined when every one is the same, i.e. the facts recorded with `inputs` still hold.
 *
 * `workspace` and `inventory` must come from `root`; the workspace layout itself is not
 * compared (it belongs in the cache key). File hashes are computed once per verifier, so one
 * verifier serves every service of a run.
 */
export function createInputVerifier(
  root: string,
  workspace: Workspace,
  inventory: Inventory,
): (inputs: ObservedInputs) => Promise<string | undefined> {
  const present = new Set(inventory.files);
  const dirs = new Set<string>([""]);
  for (const file of inventory.files) {
    for (
      let slash = file.lastIndexOf("/");
      slash !== -1;
      slash = file.lastIndexOf("/", slash - 1)
    ) {
      dirs.add(file.slice(0, slash));
    }
  }
  const listings = programRootFiles(workspace, inventory.sourceFiles);
  const hashes = new Map<string, Promise<string>>();
  const hashOf = (path: string): Promise<string> => {
    let hash = hashes.get(path);
    if (!hash) {
      // An unreadable file can't be shown unchanged; "" matches no hash.
      hash = readFile(join(root, path)).then(contentHash, () => "");
      hashes.set(path, hash);
    }
    return hash;
  };

  return async (inputs) => {
    for (const [service, files] of inputs.listings) {
      const now = listings.get(service) ?? [];
      if (now.length !== files.length || now.some((file, i) => file !== files[i])) {
        return `listing:${service}`;
      }
    }
    for (const [path, exists] of inputs.dirs) {
      if (dirs.has(path) !== exists) return path;
    }
    for (const [path, answer] of inputs.files) {
      if (!present.has(path)) {
        if (answer !== ABSENT) return path;
      } else if (answer === ABSENT || (answer !== PRESENT && (await hashOf(path)) !== answer)) {
        return path;
      }
    }
    return undefined;
  };
}

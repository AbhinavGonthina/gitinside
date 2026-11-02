/**
 * Cached service facts (M6.7e, ADR-0090, ADR-0175, ADR-0176): one {@link FactCache} entry per
 * service, holding its {@link ServiceFacts}, the {@link ObservedInputs} its analysis recorded,
 * and the {@link RepoFacts} its collection ran under.
 *
 * - **Key:** the global inputs no service's log records (TypeScript's version, which fixes its
 *   bundled `lib.*.d.ts`; the workspace layout with every service's dependencies; the inventory
 *   limits; whether the repo uses Prisma, which decides whether client calls are looked for),
 *   the service's key, and its own root files with their content hashes. The own files only
 *   spread entries out, so a diff's base and head keep one entry each; the inputs decide.
 * - **Clean:** an entry whose inputs all still answer the same ({@link createInputVerifier})
 *   and whose repo-wide facts (the router and queue-library checks, every wrapper's ID) are
 *   the run's. Those are computed over every program, so a service's log can't show them.
 * - **Reuse:** when every service is clean, the graph is composed from the entries with no
 *   program built; the repo-wide facts are then predicted from the entries' own parts
 *   ({@link repoFactsOf}), each of which its inputs vouch for. Otherwise `analyze` builds every
 *   program, collects the services that aren't clean, and computes the repo-wide facts afresh;
 *   a reused entry collected under other ones makes it run again with that service collected.
 * - **Never stored:** a bundle with a failed collection or a TypeScript internal error, since
 *   either may come from a global step or from the order TypeScript was asked in, which a run
 *   that reuses other services' facts doesn't repeat.
 *
 * Like the cache, this can only cost time: an entry that doesn't parse as an entry is a miss.
 */
import { createHash } from "node:crypto";
import ts from "typescript";
import { compareStrings } from "@gitinside/schema";
import type { FactCache } from "./cache.js";
import type { ServiceFacts } from "./facts.js";
import {
  createFileHasher,
  createInputVerifier,
  programRootFiles,
  type ObservedInputs,
} from "./inputs.js";
import { DEFAULT_LIMITS, type Inventory, type InventoryLimits } from "./inventory.js";
import { repoUsesPrisma } from "./prisma.js";
import type { Workspace } from "./workspace.js";

/**
 * The facts computed over every program that a service's collection depends on (ADR-0176):
 * whether any service creates an Express router (else routes aren't looked for), whether any
 * root file names a queue library (else queues aren't), and the symbol node IDs of every HTTP
 * wrapper in the repo, sorted (calls spelled like one are resolved and inlined, ADR-0092).
 */
export interface RepoFacts {
  routers: boolean;
  queues: boolean;
  wrappers: string[];
}

/** What a service's cache entry holds. */
export interface CachedService {
  facts: ServiceFacts;
  inputs: ObservedInputs;
  /** The repo-wide facts the service's facts were collected under. */
  repo: RepoFacts;
  /** Whether the service's own root files name a queue library: its part of `repo.queues`. */
  queueLibrary: boolean;
}

/** A run's cache keys and the hasher they were computed with, for {@link storeFacts}. */
export interface FactKeys {
  /** Each service's entry key, by service key. */
  keys: Map<string, string>;
  /** The run's file hasher, shared with input verification. */
  hashOf: (path: string) => Promise<string>;
}

/** Bump when what an entry means changes without the analyzer's version changing. */
const KEY_FORMAT = 2;

/**
 * The global part of every service's key: what its facts depend on that no input log records.
 * `limits` are the analysis's overrides, merged over the defaults.
 */
export function globalFactsKey(
  workspace: Workspace,
  sourceFiles: readonly string[],
  limits: Partial<InventoryLimits> = {},
): string {
  return JSON.stringify([
    KEY_FORMAT,
    ts.version,
    workspace.packages,
    { ...DEFAULT_LIMITS, ...limits },
    repoUsesPrisma(workspace, sourceFiles),
  ]);
}

/** Each workspace service's cache key, from the global key and its own files' hashes. */
export async function factKeys(
  root: string,
  workspace: Workspace,
  inventory: Inventory,
  limits?: Partial<InventoryLimits>,
): Promise<FactKeys> {
  const hashOf = createFileHasher(root);
  const global = globalFactsKey(workspace, inventory.sourceFiles, limits);
  const owned = programRootFiles(workspace, inventory.sourceFiles);
  const keys = new Map<string, string>();
  for (const { key } of workspace.packages) {
    const files = owned.get(key) ?? [];
    const own = await Promise.all(files.map(async (file) => [file, await hashOf(file)]));
    const digest = createHash("sha256")
      .update(JSON.stringify([global, key, own]))
      .digest("hex");
    keys.set(key, `service-facts:${digest}`);
  }
  return { keys, hashOf };
}

/** Whether a value has the {@link RepoFacts} shape. */
function isRepoFacts(value: unknown): value is RepoFacts {
  return (
    typeof value === "object" &&
    value !== null &&
    "routers" in value &&
    typeof value.routers === "boolean" &&
    "queues" in value &&
    typeof value.queues === "boolean" &&
    "wrappers" in value &&
    Array.isArray(value.wrappers) &&
    value.wrappers.every((id) => typeof id === "string")
  );
}

/** Whether a cached value has the shape {@link storeFacts} writes, for service `service`. */
function isCachedService(value: unknown, service: string): value is CachedService {
  if (typeof value !== "object" || value === null) return false;
  if (!("facts" in value) || !("inputs" in value)) return false;
  if (!("repo" in value) || !isRepoFacts(value.repo)) return false;
  if (!("queueLibrary" in value) || typeof value.queueLibrary !== "boolean") return false;
  const { facts, inputs } = value;
  return (
    typeof facts === "object" &&
    facts !== null &&
    "service" in facts &&
    facts.service === service &&
    typeof inputs === "object" &&
    inputs !== null &&
    "listings" in inputs &&
    Array.isArray(inputs.listings) &&
    "files" in inputs &&
    Array.isArray(inputs.files) &&
    "dirs" in inputs &&
    Array.isArray(inputs.dirs)
  );
}

/** Two {@link RepoFacts} are the same answers. */
export function sameRepoFacts(a: RepoFacts, b: RepoFacts): boolean {
  return (
    a.routers === b.routers &&
    a.queues === b.queues &&
    a.wrappers.length === b.wrappers.length &&
    a.wrappers.every((id, i) => id === b.wrappers[i])
  );
}

/** The sorted IDs of every wrapper whose body is in one of `bundles`' services. */
export function wrapperIds(bundles: readonly ServiceFacts[]): string[] | undefined {
  const ids = new Set<string>();
  for (const { http } of bundles) {
    if (!http) return undefined;
    for (const { id } of http.wrappers) ids.add(id);
  }
  return [...ids].sort(compareStrings);
}

/**
 * The repo-wide facts of a repo whose every service is one of `entries`, from each entry's own
 * part (its router creations, whether it names a queue library, its wrappers). `undefined`
 * when an entry lacks the stage facts that tell.
 */
export function repoFactsOf(entries: readonly CachedService[]): RepoFacts | undefined {
  const wrappers = wrapperIds(entries.map((e) => e.facts));
  if (!wrappers || entries.some((e) => !e.facts.express)) return undefined;
  return {
    routers: entries.some((e) => (e.facts.express?.creations.length ?? 0) > 0),
    queues: entries.some((e) => e.queueLibrary),
    wrappers,
  };
}

/**
 * The entries `analyze` may reuse, by service key: each service's (except `forced`'s) whose
 * observed inputs all still hold in `root`. When every service has one, those collected under
 * other repo-wide facts than all of them together give ({@link repoFactsOf}) are left out, so
 * the result holds every service exactly when the graph can be composed with no program built.
 * `keys` comes from {@link factKeys} for the same checkout.
 */
export async function reusableFacts(
  cache: FactCache,
  root: string,
  workspace: Workspace,
  inventory: Inventory,
  { keys, hashOf }: FactKeys,
  forced: ReadonlySet<string> = new Set(),
): Promise<Map<string, CachedService>> {
  const verify = createInputVerifier(root, workspace, inventory, hashOf);
  const clean = new Map<string, CachedService>();
  for (const { key } of workspace.packages) {
    const entryKey = keys.get(key);
    if (entryKey === undefined || forced.has(key)) continue;
    const value = await cache.get(entryKey);
    if (!isCachedService(value, key)) continue;
    if ((await verify(value.inputs)) !== undefined) continue;
    clean.set(key, value);
  }
  if (clean.size === workspace.packages.length) {
    const repo = repoFactsOf([...clean.values()]);
    for (const [key, entry] of clean) {
      if (!repo || !sameRepoFacts(entry.repo, repo)) clean.delete(key);
    }
  }
  return clean;
}

/** What {@link storeFacts} stores for one service, besides its facts. */
export interface StoredService {
  inputs: ObservedInputs;
  /** Whether its own root files name a queue library. */
  queueLibrary: () => boolean;
}

/**
 * Store each service's facts with its observed inputs and the run's repo-wide facts `repo`
 * under its key, except bundles with a failed collection or a TypeScript internal error.
 * Never throws (the cache counts its own failures).
 */
export async function storeFacts(
  cache: FactCache,
  { keys }: FactKeys,
  bundles: readonly ServiceFacts[],
  stored: ReadonlyMap<string, StoredService>,
  repo: RepoFacts,
): Promise<void> {
  for (const facts of bundles) {
    const key = keys.get(facts.service);
    const service = stored.get(facts.service);
    if (key === undefined || service === undefined) continue;
    if (facts.failed.length > 0 || facts.analyzerWarnings.length > 0) continue;
    const entry: CachedService = {
      facts,
      inputs: service.inputs,
      repo,
      queueLibrary: service.queueLibrary(),
    };
    await cache.put(key, entry);
  }
}

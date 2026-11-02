/**
 * Cached service facts (M6.7e1, ADR-0090, ADR-0175): one {@link FactCache} entry per service,
 * holding its {@link ServiceFacts} and the {@link ObservedInputs} its analysis recorded.
 *
 * - **Key:** the global inputs no service's log records (TypeScript's version, which fixes its
 *   bundled `lib.*.d.ts`; the workspace layout with every service's dependencies; the inventory
 *   limits; whether the repo uses Prisma, which decides whether client calls are looked for),
 *   the service's key, and its own root files with their content hashes. The own files only
 *   spread entries out, so a diff's base and head keep one entry each; the inputs decide.
 * - **Reuse is whole-run:** the graph is composed from cached facts only when every service has
 *   an entry whose inputs all still answer the same ({@link createInputVerifier}). Then every
 *   program, and so every repo-wide fact a bundle depends on (the wrapper names, the router and
 *   queue-library checks, the HTTP stage's passes over every program), is as it was. One dirty
 *   or missing service makes it a cold run, which stores every bundle again. Reusing clean
 *   services beside dirty ones is M6.7e2.
 * - **Never stored:** a bundle with a failed collection, since the failure may come from a
 *   global step or from TypeScript's query order rather than from the service's inputs.
 *
 * Like the cache, this can only cost time: an entry that doesn't parse as an entry is a miss.
 */
import { createHash } from "node:crypto";
import ts from "typescript";
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

/** What a service's cache entry holds. */
export interface CachedService {
  facts: ServiceFacts;
  inputs: ObservedInputs;
}

/** A run's cache keys and the hasher they were computed with, for {@link storeFacts}. */
export interface FactKeys {
  /** Each service's entry key, by service key. */
  keys: Map<string, string>;
  /** The run's file hasher, shared with input verification. */
  hashOf: (path: string) => Promise<string>;
}

/** Bump when what an entry means changes without the analyzer's version changing. */
const KEY_FORMAT = 1;

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

/** Whether a cached value has the shape {@link storeFacts} writes, for service `service`. */
function isCachedService(value: unknown, service: string): value is CachedService {
  if (typeof value !== "object" || value === null) return false;
  if (!("facts" in value) || !("inputs" in value)) return false;
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

/**
 * Every service's cached facts, in workspace order, when each has an entry whose observed
 * inputs all still hold in `root`; else `undefined` (the run is cold). `keys` comes from
 * {@link factKeys} for the same checkout.
 */
export async function cachedFacts(
  cache: FactCache,
  root: string,
  workspace: Workspace,
  inventory: Inventory,
  { keys, hashOf }: FactKeys,
): Promise<ServiceFacts[] | undefined> {
  const verify = createInputVerifier(root, workspace, inventory, hashOf);
  const facts: ServiceFacts[] = [];
  for (const { key } of workspace.packages) {
    const entryKey = keys.get(key);
    const value = entryKey === undefined ? undefined : await cache.get(entryKey);
    if (!isCachedService(value, key)) return undefined;
    if ((await verify(value.inputs)) !== undefined) return undefined;
    facts.push(value.facts);
  }
  return facts;
}

/**
 * Store each service's facts with its observed inputs under its key, except bundles with a
 * failed collection. Never throws (the cache counts its own failures).
 */
export async function storeFacts(
  cache: FactCache,
  { keys }: FactKeys,
  bundles: readonly ServiceFacts[],
  inputs: ReadonlyMap<string, ObservedInputs>,
): Promise<void> {
  for (const facts of bundles) {
    const key = keys.get(facts.service);
    const observed = inputs.get(facts.service);
    if (key === undefined || observed === undefined || facts.failed.length > 0) continue;
    const entry: CachedService = { facts, inputs: observed };
    await cache.put(key, entry);
  }
}

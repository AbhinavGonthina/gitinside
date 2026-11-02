/**
 * Cached service facts (M6.7e, ADR-0090, ADR-0175, ADR-0176): one {@link FactCache} entry per
 * service, holding its {@link ServiceFacts}, the {@link RepoFacts} its collection ran under,
 * and the digest of the {@link ObservedInputs} its analysis recorded. Those inputs are their
 * own entry, stored once for every service that recorded the same ones (M6.8c, ADR-0180) and
 * counted as shared ({@link EntryUse}), so the cache's hits, misses, and writes stay per service.
 *
 * - **Key:** the global inputs no service's log records (TypeScript's version, which fixes its
 *   bundled `lib.*.d.ts`; the workspace layout with every service's dependencies; the inventory
 *   limits; whether the repo uses Prisma, which decides whether client calls are looked for),
 *   the service's key, and its own root files with their content hashes. The own files only
 *   spread entries out, so a diff's base and head keep one entry each; the inputs decide.
 * - **Clean:** an entry whose inputs all still answer the same ({@link createInputVerifier})
 *   and whose repo-wide facts (the router and queue-library checks, every wrapper's ID) are
 *   the run's. Those are computed over every program, so a service's log can't show them.
 *   Services that reached the same programs have equal inputs, stored with one digest
 *   ({@link inputsDigest}), so a run reads and verifies each distinct set once (M6.8b). An
 *   entry whose inputs entry is gone (evicted, or never written) is a miss.
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
import type { EntryUse, FactCache } from "./cache.js";
import type { ServiceFacts } from "./facts.js";
import {
  createFileHasher,
  createInputVerifier,
  inputsDigest,
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
  /**
   * {@link inputsDigest} of the service's observed inputs, stored once per distinct set under
   * {@link inputsKey} (M6.8c): entries with equal inputs share it and are verified once a run.
   */
  inputsDigest: string;
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
  /**
   * Digests whose inputs entry this run read or stored, so {@link storeFacts} doesn't write
   * one again. Filled by {@link reusableFacts} and {@link storeFacts}.
   */
  present: Set<string>;
}

/** Bump when what an entry means changes without the analyzer's version changing. */
const KEY_FORMAT = 4;

/** The {@link EntryUse} of an inputs entry: shared by the service entries naming its digest. */
const SHARED: EntryUse = { shared: true };

/** The cache key of the inputs whose {@link inputsDigest} is `digest`. */
export function inputsKey(digest: string): string {
  return `service-inputs:${KEY_FORMAT}:${digest}`;
}

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
  return { keys, hashOf, present: new Set() };
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
  if (!("facts" in value)) return false;
  if (!("repo" in value) || !isRepoFacts(value.repo)) return false;
  if (!("queueLibrary" in value) || typeof value.queueLibrary !== "boolean") return false;
  if (!("inputsDigest" in value) || typeof value.inputsDigest !== "string") return false;
  const { facts } = value;
  return (
    typeof facts === "object" && facts !== null && "service" in facts && facts.service === service
  );
}

/** Whether a cached value has the {@link ObservedInputs} shape. */
function isInputs(value: unknown): value is ObservedInputs {
  return (
    typeof value === "object" &&
    value !== null &&
    "listings" in value &&
    Array.isArray(value.listings) &&
    "files" in value &&
    Array.isArray(value.files) &&
    "dirs" in value &&
    Array.isArray(value.dirs)
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
 * observed inputs all still hold in `root` (an entry whose inputs entry is gone is a miss).
 * When every service has one, those collected under other repo-wide facts than all of them
 * together give ({@link repoFactsOf}) are left out, so the result holds every service exactly
 * when the graph can be composed with no program built. `keys` comes from {@link factKeys}
 * for the same checkout; the digests whose inputs entry was read are added to its `present`.
 */
export async function reusableFacts(
  cache: FactCache,
  root: string,
  workspace: Workspace,
  inventory: Inventory,
  { keys, hashOf, present }: FactKeys,
  forced: ReadonlySet<string> = new Set(),
): Promise<Map<string, CachedService>> {
  const verify = createInputVerifier(root, workspace, inventory, hashOf);
  /** Whether inputs still hold, by digest: each distinct set is read and verified once. */
  const holds = new Map<string, Promise<boolean>>();
  const held = (digest: string): Promise<boolean> => {
    let answer = holds.get(digest);
    if (!answer) {
      answer = cache
        .get(inputsKey(digest), SHARED)
        .catch(() => undefined)
        .then(async (inputs) => {
          if (!isInputs(inputs)) return false;
          present.add(digest);
          return (await verify(inputs)) === undefined;
        });
      holds.set(digest, answer);
    }
    return answer;
  };
  const clean = new Map<string, CachedService>();
  // Entries are read at once (the cache unzips them off the main thread), and each distinct
  // inputs set as soon as an entry names it; they're checked in order.
  const read = workspace.packages.map(async ({ key }) => {
    const entryKey = keys.get(key);
    if (entryKey === undefined || forced.has(key)) return undefined;
    const value = await cache.get(entryKey).catch(() => undefined);
    if (!isCachedService(value, key)) return undefined;
    void held(value.inputsDigest);
    return value;
  });
  for (const [i, { key }] of workspace.packages.entries()) {
    const value = await read[i];
    if (!value || !(await held(value.inputsDigest))) continue;
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

/** At most this many entries are being stored at once: libuv's default thread pool size. */
export const PUTS_IN_FLIGHT = 4;

/** What {@link storeFacts} stores for one service, besides its facts. */
export interface StoredService {
  inputs: ObservedInputs;
  /** Whether its own root files name a queue library. */
  queueLibrary: () => boolean;
}

/**
 * Store each service's facts and the run's repo-wide facts `repo` under its key, except
 * bundles with a failed collection or a TypeScript internal error, and each distinct set of
 * their observed inputs once, under {@link inputsKey} (M6.8c: on cal.com ~80 services share
 * one 1.3 MB set), unless the run already read or stored it (`present`). Inputs go first, so
 * an entry is seldom stored before what it names. Up to {@link PUTS_IN_FLIGHT} entries are
 * handed to the cache at once, in that order, so a cache that compresses off the main thread
 * does them side by side while only a few serialized entries are held at a time. Never throws
 * (the cache counts its own failures).
 */
export async function storeFacts(
  cache: FactCache,
  { keys, present }: FactKeys,
  bundles: readonly ServiceFacts[],
  stored: ReadonlyMap<string, StoredService>,
  repo: RepoFacts,
): Promise<void> {
  /** Digests by inputs object: services that reached the same programs share one. */
  const digests = new Map<ObservedInputs, string>();
  const shared: [key: string, inputs: ObservedInputs][] = [];
  const entries: [key: string, entry: CachedService][] = [];
  for (const facts of bundles) {
    const key = keys.get(facts.service);
    const service = stored.get(facts.service);
    if (key === undefined || service === undefined) continue;
    if (facts.failed.length > 0 || facts.analyzerWarnings.length > 0) continue;
    let digest = digests.get(service.inputs);
    if (digest === undefined) {
      digest = inputsDigest(service.inputs);
      digests.set(service.inputs, digest);
      if (!present.has(digest)) {
        present.add(digest);
        shared.push([inputsKey(digest), service.inputs]);
      }
    }
    const entry: CachedService = {
      facts,
      inputsDigest: digest,
      repo,
      queueLibrary: service.queueLibrary(),
    };
    entries.push([key, entry]);
  }
  const puts: [key: string, value: unknown, use?: EntryUse][] = [
    ...shared.map(([key, inputs]): [string, unknown, EntryUse] => [key, inputs, SHARED]),
    ...entries,
  ];
  let next = 0;
  const putting = async (): Promise<void> => {
    for (let i = next++; i < puts.length; i = next++) {
      const [key, value, use] = puts[i] ?? [];
      if (key !== undefined) await cache.put(key, value, use).catch(() => undefined);
    }
  };
  await Promise.all(Array.from({ length: PUTS_IN_FLIGHT }, putting));
}

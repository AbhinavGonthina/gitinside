import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  SYSTEM_ID,
  compareStrings,
  nodeId,
  type AnalysisWarning,
  type GraphNode,
  type Layer,
} from "@gitinside/schema";

/** A workspace package (or the single root package) that becomes a `service` node. */
export interface WorkspacePackage {
  /** Service key used in node IDs (`service:<key>/`). Unique within the repo. */
  key: string;
  /** Repo-relative directory with `/` separators; `""` for the repo root. */
  dir: string;
  /** `package.json` name, else Nx `project.json` name, else the folder name. For labels. */
  name: string;
  /**
   * The `package.json` `name`, when it has one: the only name other code can import the
   * package by. Fallback names (Nx project, folder, `app`) never resolve imports, so a
   * nameless `packages/config` can't capture `import "config"` from npm.
   */
  packageName?: string;
  /** Detected framework (`next`, `express`, `react`), from runtime dependencies. */
  framework?: string;
  /** Sorted names of every dependency the manifest declares (all four dependency fields). */
  dependencies: string[];
}

/** Result of {@link detectWorkspace}. */
export interface Workspace {
  /** Workspace tools found at the root, sorted: `lerna`, `npm-workspaces`, `nx`, `pnpm`, `turborepo`. */
  tools: string[];
  /** Services sorted by `dir`. Never empty: a repo without workspaces is one root service. */
  packages: WorkspacePackage[];
  /** Problems found while reading workspace config, sorted by file, code, message. */
  warnings: AnalysisWarning[];
}

/** Checked in order; the first dependency found names the service's framework. */
const FRAMEWORKS: readonly { dep: string; framework: string; layer: Layer }[] = [
  { dep: "next", framework: "next", layer: "frontend" },
  { dep: "express", framework: "express", layer: "backend" },
  { dep: "react", framework: "react", layer: "frontend" },
];

/** Pseudo-service keys used by infra and external nodes (GRAPH_SCHEMA.md); packages never get them. */
const RESERVED_KEYS: ReadonlySet<string> = new Set(["ext", "infra"]);

/** Lerna's default when `lerna.json` lists no packages. */
const LERNA_DEFAULT = ["packages/*"];

/** Key for a repo without workspaces and without a usable package name. */
const FALLBACK_KEY = "app";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** `@acme/api` → `api`; `web` → `web`. */
function unscoped(name: string): string {
  return name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
}

/**
 * Limits on repo-supplied workspace globs. Patterns come from untrusted config, so a
 * pattern beyond these is skipped with a `WORKSPACE_PATTERN_TOO_COMPLEX` warning instead
 * of being allowed to blow up time or memory.
 */
const MAX_PATTERN_LENGTH = 1024;
const MAX_BRACE_ALTERNATIVES = 256;

/**
 * Expand `{a,b}` braces: `apps/{web,api}` → `apps/web`, `apps/api`. Several groups
 * multiply (`{a,b}/{c,d}` → 4); nested braces expand innermost first. Returns undefined
 * when the expansion would exceed {@link MAX_BRACE_ALTERNATIVES}.
 */
function expandBraces(pattern: string): string[] | undefined {
  const done: string[] = [];
  const queue = [pattern];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    const match = /\{([^{}]*)\}/.exec(next);
    if (!match) {
      done.push(next);
      continue;
    }
    const head = next.slice(0, match.index);
    const tail = next.slice(match.index + match[0].length);
    for (const alt of (match[1] ?? "").split(",")) queue.push(`${head}${alt}${tail}`);
    if (done.length + queue.length > MAX_BRACE_ALTERNATIVES) return undefined;
  }
  return done.sort(compareStrings);
}

/** One step of a compiled glob. */
type GlobToken =
  | { t: "segments" } // `**/`: zero or more whole segments, each followed by `/`
  | { t: "any" } // `**` elsewhere: any characters, including `/`
  | { t: "star" } // `*`: any characters within one segment
  | { t: "one" } // `?`: one character other than `/`
  | { t: "lit"; c: string };

function tokenize(glob: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        tokens.push({ t: "segments" });
        i += 2;
      } else {
        tokens.push({ t: "any" });
        i += 1;
      }
    } else if (c === "*") tokens.push({ t: "star" });
    else if (c === "?") tokens.push({ t: "one" });
    else tokens.push({ t: "lit", c });
  }
  return tokens;
}

/**
 * Match `path` against `tokens` by dynamic programming over (token, position), so the
 * cost is O(tokens × path length) whatever the pattern. A backtracking RegExp would be
 * exponential on patterns like `**\/**\/**\/…\/z`.
 */
function matchTokens(tokens: readonly GlobToken[], path: string): boolean {
  const n = path.length;
  // nextSlash[p] = index of the first `/` at or after p, or n.
  const nextSlash = new Int32Array(n + 1);
  nextSlash[n] = n;
  for (let p = n - 1; p >= 0; p--) nextSlash[p] = path[p] === "/" ? p : (nextSlash[p + 1] ?? n);
  // row[p] = tokens[i..] match path[p..]; computed from the last token backwards.
  let row = new Uint8Array(n + 1);
  row[n] = 1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i];
    const next = row;
    row = new Uint8Array(n + 1);
    for (let p = n; p >= 0; p--) {
      let ok = false;
      switch (token?.t) {
        case "segments": {
          const slash = nextSlash[p] ?? n;
          ok = next[p] === 1 || (slash > p && slash < n && row[slash + 1] === 1);
          break;
        }
        case "any":
          ok = next[p] === 1 || (p < n && row[p + 1] === 1);
          break;
        case "star":
          ok = next[p] === 1 || (p < n && path[p] !== "/" && row[p + 1] === 1);
          break;
        case "one":
          ok = p < n && path[p] !== "/" && next[p + 1] === 1;
          break;
        case "lit":
          ok = p < n && path[p] === token.c && next[p + 1] === 1;
          break;
      }
      if (ok) row[p] = 1;
    }
  }
  return row[0] === 1;
}

/**
 * Compile a workspace glob into a matcher over repo-relative directory paths, or
 * undefined when the pattern is too complex (over {@link MAX_PATTERN_LENGTH} characters
 * or {@link MAX_BRACE_ALTERNATIVES} brace alternatives).
 *
 * Handles: `*` (within one segment), `**` (any number of segments, including none),
 * `?`, `{a,b}` braces, a leading `./`, and trailing `/` or `/package.json`. Matching is
 * linear in the path length for each alternative, so hostile patterns can't stall it.
 * Not handled: character classes (`[abc]`, matched literally) and extglobs; `*` also
 * matches dot-folders, unlike micromatch.
 */
export function compileGlob(pattern: string): ((path: string) => boolean) | undefined {
  if (pattern.length > MAX_PATTERN_LENGTH) return undefined;
  const clean = pattern
    .trim()
    .replace(/^\.\//, "")
    .replace(/\/package\.json$/, "")
    .replace(/\/+$/, "");
  const alternatives = expandBraces(clean)?.map(tokenize);
  if (!alternatives) return undefined;
  return (path) => alternatives.some((tokens) => matchTokens(tokens, path));
}

/** Workspace-level warnings carry a code, the config file, and a message. */
function warn(code: string, file: string | undefined, message: string): AnalysisWarning {
  return file === undefined ? { code, message } : { code, file, message };
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string");
}

function dependencyNames(manifest: JsonObject, fields: readonly string[]): string[] {
  const names = new Set<string>();
  for (const field of fields) {
    const deps = manifest[field];
    if (isObject(deps)) for (const name of Object.keys(deps)) names.add(name);
  }
  return [...names].sort(compareStrings);
}

const ALL_DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
/** Fields that count for framework detection and cycle warnings: what the package needs at runtime. */
const RUNTIME_DEP_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

/**
 * Give every package a unique, readable service key. The folder name is preferred
 * (`apps/api` → `api`). Packages whose folder names collide, or that hit a reserved
 * pseudo-service key, use their full directory with `/` → `-` (`apps-web`), then a numeric
 * suffix. `dirs` must be sorted so the suffixes are deterministic.
 */
function assignKeys<T extends { dir: string; preferred: string }>(
  items: readonly T[],
): (T & { key: string })[] {
  const clean = (key: string): string => key.replaceAll("/", "-");
  const counts = new Map<string, number>();
  for (const { preferred } of items) counts.set(preferred, (counts.get(preferred) ?? 0) + 1);
  const taken = new Set<string>(RESERVED_KEYS);
  return items.map((item) => {
    const fromDir = clean(item.dir) || FALLBACK_KEY;
    const first = clean(item.preferred);
    let key =
      first !== "" && counts.get(item.preferred) === 1 && !taken.has(first) ? first : fromDir;
    for (let n = 2; taken.has(key); n++) key = `${fromDir}-${n}`;
    taken.add(key);
    return { ...item, key };
  });
}

/**
 * Find strongly connected components of size > 1 (and self-loops) in the dependency
 * graph between workspace packages (Tarjan's algorithm). `graph` maps a package name to
 * its dependency names; names outside the graph are ignored. Each cycle is sorted.
 */
export function findCycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  const state = new Map<string, { index: number; low: number }>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];

  // Recursion depth is bounded by the package count, which the file limit keeps small.
  const visit = (name: string, deps: readonly string[]): { index: number; low: number } => {
    const self = { index: state.size, low: state.size };
    state.set(name, self);
    stack.push(name);
    onStack.add(name);
    for (const dep of [...deps].sort(compareStrings)) {
      const depDeps = graph.get(dep);
      if (depDeps === undefined) continue;
      const seen = state.get(dep);
      if (!seen) self.low = Math.min(self.low, visit(dep, depDeps).low);
      else if (onStack.has(dep)) self.low = Math.min(self.low, seen.index);
    }
    if (self.low === self.index) {
      const component: string[] = [];
      for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
        onStack.delete(member);
        component.push(member);
        if (member === name) break;
      }
      if (component.length > 1 || deps.includes(name)) cycles.push(component.sort(compareStrings));
    }
    return self;
  };
  const names = [...graph.keys()].sort(compareStrings);
  for (const name of names) if (!state.has(name)) visit(name, graph.get(name) ?? []);
  return cycles.sort((a, b) => compareStrings(a.join("\0"), b.join("\0")));
}

/**
 * Detect the repo's workspace layout and list its services. Reads only files present in
 * `files` (the inventory), so ignored, oversized, and symlinked files are never opened.
 *
 * Handles:
 * - npm/yarn `workspaces` in the root `package.json` (array, or yarn's `{ packages: [] }`).
 * - `pnpm-workspace.yaml` `packages`, including `!` exclusions.
 * - `lerna.json` `packages` (default `packages/*` when absent and nothing else lists packages).
 * - Nx: with `nx.json`, every folder with a `project.json` is a service, even without a
 *   `package.json`, unless a `!` exclusion matches it.
 * - Hostile globs: patterns over 1,024 characters or 256 brace alternatives are skipped
 *   with `WORKSPACE_PATTERN_TOO_COMPLEX`; matching itself is linear (see {@link compileGlob}).
 * - Turborepo: `turbo.json` is recorded as a tool; packages come from the package manager.
 * - No workspaces, or patterns that match nothing: one root service (single-package fallback).
 * - Warnings for invalid JSON/YAML, invalid `workspaces`, patterns matching nothing,
 *   duplicate package names, and circular runtime dependencies between packages.
 *
 * Not handled: the root package is never a service in a workspace repo, even if it has
 * source files; Nx `workspace.json`; Rush and Bazel; globs beyond {@link globToRegExp}.
 */
export async function detectWorkspace(root: string, files: readonly string[]): Promise<Workspace> {
  const present = new Set(files);
  const warnings: AnalysisWarning[] = [];
  const tools = new Set<string>();

  async function readText(path: string): Promise<string | undefined> {
    if (!present.has(path)) return undefined;
    return readFile(join(root, path), "utf8");
  }

  async function readJson(path: string): Promise<JsonObject | undefined> {
    const text = await readText(path);
    if (text === undefined) return undefined;
    try {
      const value: unknown = JSON.parse(text);
      if (isObject(value)) return value;
      warnings.push(warn("INVALID_JSON", path, "expected a JSON object; ignored"));
    } catch {
      warnings.push(warn("INVALID_JSON", path, "could not parse JSON; ignored"));
    }
    return undefined;
  }

  const patterns: { pattern: string; file: string }[] = [];
  const addPatterns = (list: readonly string[], file: string): void => {
    for (const pattern of list) patterns.push({ pattern, file });
  };

  const rootManifest = await readJson("package.json");
  if (rootManifest && "workspaces" in rootManifest) {
    const value = rootManifest.workspaces;
    const list = stringList(value) ?? (isObject(value) ? stringList(value.packages) : undefined);
    if (list) {
      tools.add("npm-workspaces");
      addPatterns(list, "package.json");
    } else {
      warnings.push(
        warn(
          "INVALID_WORKSPACES",
          "package.json",
          '"workspaces" must be an array or { packages: [] }; ignored',
        ),
      );
    }
  }

  const pnpmText = await readText("pnpm-workspace.yaml");
  if (pnpmText !== undefined) {
    tools.add("pnpm");
    try {
      const doc: unknown = parseYaml(pnpmText);
      addPatterns(
        (isObject(doc) ? stringList(doc.packages) : undefined) ?? [],
        "pnpm-workspace.yaml",
      );
    } catch {
      warnings.push(warn("INVALID_YAML", "pnpm-workspace.yaml", "could not parse YAML; ignored"));
    }
  }

  const lerna = await readJson("lerna.json");
  if (present.has("lerna.json")) tools.add("lerna");
  const lernaPackages = lerna ? stringList(lerna.packages) : undefined;
  if (lernaPackages) addPatterns(lernaPackages, "lerna.json");

  if (present.has("turbo.json")) tools.add("turborepo");
  const nx = present.has("nx.json");
  if (nx) tools.add("nx");

  if (tools.has("lerna") && patterns.length === 0) addPatterns(LERNA_DEFAULT, "lerna.json");

  // Candidate package folders: every non-root folder with a package.json (or project.json for Nx).
  const manifestDirs = files.filter((f) => f.endsWith("/package.json")).map(dirname);
  const nxDirs = nx ? files.filter((f) => f.endsWith("/project.json")).map(dirname) : [];

  const compile = (p: { pattern: string; file: string }, glob: string) => {
    const test = compileGlob(glob);
    if (!test) {
      warnings.push(
        warn(
          "WORKSPACE_PATTERN_TOO_COMPLEX",
          p.file,
          `workspace pattern "${p.pattern.slice(0, 80)}${p.pattern.length > 80 ? "…" : ""}" is longer than ${MAX_PATTERN_LENGTH} characters or expands to more than ${MAX_BRACE_ALTERNATIVES} alternatives; ignored`,
        ),
      );
    }
    return test;
  };
  const exclude = patterns
    .filter((p) => p.pattern.trim().startsWith("!"))
    .flatMap((p) => compile(p, p.pattern.trim().slice(1)) ?? []);
  const compiled = patterns
    .filter((p) => !p.pattern.trim().startsWith("!"))
    .flatMap((p) => {
      const test = compile(p, p.pattern);
      return test ? [{ ...p, test }] : [];
    });
  const excluded = (dir: string): boolean => exclude.some((test) => test(dir));
  const matched = new Set<number>();
  const dirs = new Set<string>(nxDirs.filter((dir) => !excluded(dir)));
  for (const dir of manifestDirs) {
    if (excluded(dir)) continue;
    compiled.forEach((p, i) => {
      if (p.test(dir)) {
        matched.add(i);
        dirs.add(dir);
      }
    });
  }
  compiled.forEach((p, i) => {
    if (!matched.has(i)) {
      warnings.push(
        warn(
          "WORKSPACE_NO_MATCH",
          p.file,
          `workspace pattern "${p.pattern}" matched no package folders`,
        ),
      );
    }
  });

  const manifestName = (manifest: JsonObject | undefined): string | undefined =>
    typeof manifest?.name === "string" && manifest.name !== "" ? manifest.name : undefined;
  const raw: {
    dir: string;
    name: string;
    packageName: string | undefined;
    preferred: string;
    manifest: JsonObject;
  }[] = [];
  for (const dir of [...dirs].sort(compareStrings)) {
    const manifest = await readJson(`${dir}/package.json`);
    const project = nxDirs.includes(dir) ? await readJson(`${dir}/project.json`) : undefined;
    const packageName = manifestName(manifest);
    raw.push({
      dir,
      name: packageName ?? manifestName(project) ?? basename(dir),
      packageName,
      preferred: basename(dir),
      manifest: manifest ?? {},
    });
  }

  if (raw.length === 0) {
    const packageName = manifestName(rootManifest);
    const name = packageName ?? FALLBACK_KEY;
    raw.push({
      dir: "",
      name,
      packageName,
      preferred: unscoped(name),
      manifest: rootManifest ?? {},
    });
  }

  const runtimeDeps = new Map<string, string[]>();
  const packages: WorkspacePackage[] = assignKeys(raw).map((r) => {
    const runtime = dependencyNames(r.manifest, RUNTIME_DEP_FIELDS);
    if (!runtimeDeps.has(r.name)) runtimeDeps.set(r.name, runtime);
    const framework = FRAMEWORKS.find((f) => runtime.includes(f.dep))?.framework;
    return {
      key: r.key,
      dir: r.dir,
      name: r.name,
      ...(r.packageName !== undefined ? { packageName: r.packageName } : {}),
      ...(framework ? { framework } : {}),
      dependencies: dependencyNames(r.manifest, ALL_DEP_FIELDS),
    };
  });

  const byName = new Map<string, string[]>();
  for (const p of packages) byName.set(p.name, [...(byName.get(p.name) ?? []), p.dir]);
  for (const [name, dirsWithName] of byName) {
    if (dirsWithName.length > 1) {
      warnings.push(
        warn(
          "DUPLICATE_PACKAGE_NAME",
          undefined,
          `package name "${name}" is used by ${dirsWithName.join(", ")}; workspace imports of it are ambiguous`,
        ),
      );
    }
  }

  for (const cycle of findCycles(runtimeDeps)) {
    warnings.push(
      warn(
        "WORKSPACE_CYCLE",
        undefined,
        `circular workspace dependencies between ${cycle.join(", ")}`,
      ),
    );
  }

  warnings.sort(
    (a, b) =>
      compareStrings(a.file ?? "", b.file ?? "") ||
      compareStrings(a.code, b.code) ||
      compareStrings(a.message, b.message),
  );
  return { tools: [...tools].sort(compareStrings), packages, warnings };
}

/**
 * The service a repo-relative file belongs to: the package with the longest `dir` that
 * contains it. Returns undefined for files outside every package (possible in workspace repos).
 */
export function serviceForFile(workspace: Workspace, path: string): WorkspacePackage | undefined {
  let best: WorkspacePackage | undefined;
  for (const p of workspace.packages) {
    const inside = p.dir === "" || path.startsWith(`${p.dir}/`);
    if (inside && (!best || p.dir.length > best.dir.length)) best = p;
  }
  return best;
}

/** One `service` node per package, parented to the system root, in package order. */
export function serviceNodes(workspace: Workspace): GraphNode[] {
  return workspace.packages.map((p) => {
    const layer = FRAMEWORKS.find((f) => f.framework === p.framework)?.layer;
    return {
      id: nodeId("service", p.key, ""),
      kind: "service",
      label: p.name,
      parentId: SYSTEM_ID,
      root: p.dir,
      ...(p.framework ? { framework: p.framework } : {}),
      ...(layer ? { layer } : {}),
    };
  });
}

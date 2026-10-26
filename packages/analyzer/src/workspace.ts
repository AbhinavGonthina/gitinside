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
  /** `package.json` name, else Nx `project.json` name, else the folder name. */
  name: string;
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

/** Expand one level of `{a,b}` braces: `apps/{web,api}` → `apps/web`, `apps/api`. Nested braces are not expanded. */
function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]*)\}/.exec(pattern);
  if (!match) return [pattern];
  const head = pattern.slice(0, match.index);
  const tail = pattern.slice(match.index + match[0].length);
  return (match[1] ?? "").split(",").flatMap((alt) => expandBraces(`${head}${alt}${tail}`));
}

/**
 * Compile a workspace glob into an anchored RegExp over repo-relative directory paths.
 *
 * Handles: `*` (within one segment), `**` (any number of segments, including none),
 * `?`, one level of `{a,b}` braces, a leading `./`, and trailing `/` or `/package.json`.
 * Not handled: character classes (`[abc]`, matched literally) and extglobs; `*` also
 * matches dot-folders, unlike micromatch.
 */
export function globToRegExp(pattern: string): RegExp {
  const clean = pattern
    .trim()
    .replace(/^\.\//, "")
    .replace(/\/package\.json$/, "")
    .replace(/\/+$/, "");
  const alternatives = expandBraces(clean).map((alt) => {
    let out = "";
    for (let i = 0; i < alt.length; i++) {
      const c = alt.charAt(i);
      if (c === "*" && alt[i + 1] === "*") {
        if (alt[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else if (c === "*") {
        out += "[^/]*";
      } else if (c === "?") {
        out += "[^/]";
      } else {
        out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      }
    }
    return out;
  });
  return new RegExp(`^(?:${alternatives.join("|")})$`);
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
 * - Nx: with `nx.json`, every folder with a `project.json` is a service, even without a `package.json`.
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

  const include = patterns.filter((p) => !p.pattern.trim().startsWith("!"));
  const exclude = patterns
    .filter((p) => p.pattern.trim().startsWith("!"))
    .map((p) => globToRegExp(p.pattern.trim().slice(1)));
  const compiled = include.map((p) => ({ ...p, regex: globToRegExp(p.pattern) }));
  const matched = new Set<number>();
  const dirs = new Set<string>(nxDirs);
  for (const dir of manifestDirs) {
    if (exclude.some((r) => r.test(dir))) continue;
    compiled.forEach((p, i) => {
      if (p.regex.test(dir)) {
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

  const raw: { dir: string; name: string; preferred: string; manifest: JsonObject }[] = [];
  for (const dir of [...dirs].sort(compareStrings)) {
    const manifest = await readJson(`${dir}/package.json`);
    const project = nxDirs.includes(dir) ? await readJson(`${dir}/project.json`) : undefined;
    const name =
      (typeof manifest?.name === "string" && manifest.name) ||
      (typeof project?.name === "string" && project.name) ||
      basename(dir);
    raw.push({ dir, name, preferred: basename(dir), manifest: manifest ?? {} });
  }

  if (raw.length === 0) {
    const name =
      typeof rootManifest?.name === "string" && rootManifest.name
        ? rootManifest.name
        : FALLBACK_KEY;
    raw.push({ dir: "", name, preferred: unscoped(name), manifest: rootManifest ?? {} });
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

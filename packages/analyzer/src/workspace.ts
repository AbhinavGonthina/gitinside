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
import { MAX_BRACE_ALTERNATIVES, MAX_PATTERN_LENGTH, globMatcher } from "./glob.js";
import { SOURCE_EXTENSIONS } from "./inventory.js";

/** A workspace package (or the single root package) that becomes a `service` node. */
export interface WorkspacePackage {
  /** Service key used in node IDs (`service:<key>/`). Unique within the repo. */
  key: string;
  /** Repo-relative directory with `/` separators; `""` for the repo root. */
  dir: string;
  /**
   * `package.json` name, else Nx `project.json` name, else the folder name. For labels. The
   * root service of an Nx repo takes its root `project.json` name first (Nx standalone apps).
   */
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
  /**
   * Sorted folders inside `dir` whose files this package doesn't own: set only on a workspace
   * repo's root service, for folders of other projects (a `package.json` or Nx `project.json`
   * that no workspace pattern names, or that a `!` pattern excludes). Absent when empty.
   */
  except?: string[];
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
 * Compile a workspace glob into a matcher over repo-relative directory paths, or
 * undefined when the pattern is too complex (over {@link MAX_PATTERN_LENGTH} characters
 * or {@link MAX_BRACE_ALTERNATIVES} brace alternatives). Patterns come from untrusted
 * config, so a pattern beyond these is skipped with a `WORKSPACE_PATTERN_TOO_COMPLEX`
 * warning instead of being allowed to blow up time or memory.
 *
 * Handles: `*` (within one segment), `**` (any number of segments, including none),
 * `?`, `{a,b}` braces, a leading `./`, and trailing `/` or `/package.json`. Matching is
 * linear in the path length for each alternative ({@link globMatcher}), so hostile
 * patterns can't stall it. Not handled: character classes (`[abc]`, matched literally)
 * and extglobs; `*` also matches dot-folders, unlike micromatch.
 */
export function compileGlob(pattern: string): ((path: string) => boolean) | undefined {
  if (pattern.length > MAX_PATTERN_LENGTH) return undefined;
  const clean = pattern
    .trim()
    .replace(/^\.\//, "")
    .replace(/\/package\.json$/, "")
    .replace(/\/+$/, "");
  return globMatcher(clean);
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
 * - No workspace config at all (no patterns, no Nx): every top-level folder with its own
 *   `package.json` is a service (`frontend/` + `backend/`), and the root is one too when it
 *   holds source files outside them (ADR-0163). Without such folders, one root service.
 * - Patterns that match nothing: one root service (single-package fallback).
 * - A workspace root with source files outside every package (root `tests/`, `scripts/`,
 *   even a lone `eslint.config.js`) is a service beside the packages, keyed and named like a
 *   single-package root; folders of other projects (a `package.json` or Nx `project.json`
 *   no pattern names, or one a `!` pattern excludes) stay outside it, in `except`
 *   (ADR-0021 amendment).
 * - Nx standalone apps (`nx.json` plus a root `project.json`, source in `src/`, often an
 *   `e2e/project.json` beside it): the root is a service by the rule above, keyed and labeled
 *   by the root `project.json` `name` (`api`, not the package.json's `@api/source`), which
 *   stays its importable `packageName` (M6.11j).
 * - Warnings for invalid JSON/YAML, invalid `workspaces`, patterns matching nothing,
 *   duplicate package names, and circular runtime dependencies between packages. Both of
 *   the last go by `packageName` (what dependencies and imports name), so a nameless package
 *   is in neither, and an Nx standalone root counts as `@api/source`, not `api` (M6.11n3).
 *
 * Not handled: without workspace config, deeper folders with a `package.json`
 * (`apps/web/`) stay part of the service that contains them; a workspace root's own files
 * aren't told apart by purpose (tool config files make it a service too); Nx
 * `workspace.json`; Nx `sourceRoot` (a project owns its whole folder, so a standalone root
 * owns its root config files beside `src/`, and a `sourceRoot` outside the folder is ignored);
 * a root `project.json` without `nx.json`; Rush and Bazel; globs beyond {@link compileGlob}.
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
    except?: string[];
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

  // No workspace config at all: top-level folders with their own package.json are the
  // services (`frontend/` + `backend/` side by side), each with its own tsconfig.
  if (patterns.length === 0 && !nx) {
    for (const dir of manifestDirs.filter((d) => !d.includes("/")).sort(compareStrings)) {
      const manifest = await readJson(`${dir}/package.json`);
      const packageName = manifestName(manifest);
      raw.push({
        dir,
        name: packageName ?? dir,
        packageName,
        preferred: dir,
        manifest: manifest ?? {},
      });
    }
  }

  // In a workspace repo, folders of other projects (a manifest no pattern names, or one a
  // `!` pattern excludes) outside every package aren't the root's: an example app or a
  // retired package is its own project. Nested ones are covered by their outer folder.
  const inside = (path: string, dir: string): boolean => path.startsWith(`${dir}/`);
  // Without workspace config, deeper folders stay the root's (ADR-0163).
  const except: string[] = [];
  if (raw.length > 0 && (patterns.length > 0 || nx)) {
    const others = [...new Set([...manifestDirs, ...nxDirs])]
      .filter((d) => d !== "" && !raw.some((r) => r.dir === d || inside(d, r.dir)))
      .sort(compareStrings);
    for (const d of others) if (!except.some((e) => inside(d, e))) except.push(d);
  }

  // The root is a service when nothing else is, or beside the packages (or sibling folders)
  // when it has source files of its own: a server at the root with a `client/` package, or
  // a monorepo's root `tests/` and `scripts/` (ADR-0021 amendment).
  const ownsSource = (path: string): boolean =>
    SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext)) &&
    !raw.some((r) => inside(path, r.dir)) &&
    !except.some((e) => inside(path, e));
  if (raw.length === 0 || files.some(ownsSource)) {
    const packageName = manifestName(rootManifest);
    // An Nx standalone app's root `project.json` names the app (`api`); its package.json name
    // is Nx's workspace placeholder (`@api/source`), kept only for imports.
    const projectName = nx ? manifestName(await readJson("project.json")) : undefined;
    const name = projectName ?? packageName ?? FALLBACK_KEY;
    raw.unshift({
      dir: "",
      name,
      packageName,
      preferred: unscoped(name),
      manifest: rootManifest ?? {},
      ...(except.length > 0 ? { except } : {}),
    });
  }

  // Dependencies and imports name packages by their package.json name, so duplicates and
  // cycles are checked by it: labels (an Nx root's project name, a folder) can't be depended
  // on, and a nameless package is in neither check (M6.11n3).
  const runtimeDeps = new Map<string, string[]>();
  const packages: WorkspacePackage[] = assignKeys(raw).map((r) => {
    const runtime = dependencyNames(r.manifest, RUNTIME_DEP_FIELDS);
    if (r.packageName !== undefined && !runtimeDeps.has(r.packageName)) {
      runtimeDeps.set(r.packageName, runtime);
    }
    const framework = FRAMEWORKS.find((f) => runtime.includes(f.dep))?.framework;
    return {
      key: r.key,
      dir: r.dir,
      name: r.name,
      ...(r.packageName !== undefined ? { packageName: r.packageName } : {}),
      ...(framework ? { framework } : {}),
      dependencies: dependencyNames(r.manifest, ALL_DEP_FIELDS),
      ...(r.except ? { except: r.except } : {}),
    };
  });

  const byName = new Map<string, string[]>();
  for (const { packageName: name, dir } of packages) {
    if (name !== undefined) byName.set(name, [...(byName.get(name) ?? []), dir || "."]);
  }
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
 * contains it, outside the package's `except` folders. Returns undefined for files outside
 * every package (possible in workspace repos: other projects' folders).
 */
export function serviceForFile(workspace: Workspace, path: string): WorkspacePackage | undefined {
  let best: WorkspacePackage | undefined;
  for (const p of workspace.packages) {
    const inside =
      (p.dir === "" || path.startsWith(`${p.dir}/`)) &&
      !(p.except ?? []).some((dir) => path.startsWith(`${dir}/`));
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

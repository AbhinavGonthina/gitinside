import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { compareStrings, type AnalysisWarning } from "@gitinside/schema";
import type { Inventory } from "./inventory.js";
import { serviceForFile, type Workspace, type WorkspacePackage } from "./workspace.js";

/** Extensions parsed by the TS program. `.prisma` is a source file too, but has its own detector. */
const PROGRAM_EXTENSIONS: readonly string[] = [
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
];

/** Config files looked up in each service folder, in order. */
const CONFIG_NAMES: readonly string[] = ["tsconfig.json", "jsconfig.json"];

/** TS18003 "No inputs were found": expected, because root files come from the inventory, not `include`. */
const NO_INPUTS = 18003;

/**
 * Compiler options used when a service has no usable config. Also fills keys the repo's
 * config leaves unset (see {@link buildServicePrograms}).
 */
export const DEFAULT_COMPILER_OPTIONS: Readonly<ts.CompilerOptions> = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
  esModuleInterop: true,
  resolveJsonModule: true,
  allowJs: true,
  skipLibCheck: true,
  noEmit: true,
  types: [],
};

/**
 * Options that always win over the repo's config: parse JS too, never emit or build,
 * and never auto-include `@types` packages (there is no `node_modules`).
 */
const FORCED_OPTIONS: Readonly<ts.CompilerOptions> = {
  allowJs: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
  composite: false,
  incremental: false,
  declaration: false,
};

/** ES module kinds whose implied resolution would be Classic; Bundler suits them. */
const ES_MODULE_KINDS: ReadonlySet<ts.ModuleKind> = new Set([
  ts.ModuleKind.ES2015,
  ts.ModuleKind.ES2020,
  ts.ModuleKind.ES2022,
  ts.ModuleKind.ESNext,
  ts.ModuleKind.Preserve,
]);

/** Node module kinds that imply their own resolution mode; left alone. */
const NODE_MODULE_KINDS: ReadonlySet<ts.ModuleKind> = new Set([
  ts.ModuleKind.Node16,
  ts.ModuleKind.NodeNext,
]);

/**
 * TypeScript's bundled `lib.*.d.ts` files, parsed once per target and file name for the
 * whole process. They come from our own install, never from the repo, and never change.
 */
const libCache = new Map<string, ts.SourceFile>();

/** A parsed TypeScript program for one service. */
export interface ServiceProgram {
  /** The service this program belongs to. */
  service: WorkspacePackage;
  /** The program. Root files are the service's source files; imports may pull in others. */
  program: ts.Program;
  /** The inventory-backed host, for module resolution in later passes. */
  host: ts.CompilerHost;
  /** Repo-relative path of the config used, or undefined when defaults were synthesized. */
  configFile?: string;
  /** Repo-relative source files owned by this service, sorted. */
  rootFiles: string[];
  /** Config problems and syntax errors, sorted by file, code, message. */
  warnings: AnalysisWarning[];
  /** Repo-relative path for a TS (absolute, `/`-separated) file name, or undefined outside the repo. */
  toRepoPath(fileName: string): string | undefined;
  /** Absolute, `/`-separated file name for a repo-relative path. */
  toAbsolute(path: string): string;
}

function warn(code: string, file: string | undefined, message: string): AnalysisWarning {
  return file === undefined || file === "" ? { code, message } : { code, file, message };
}

function parentDir(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * Fill unset `module`/`moduleResolution` so imports resolve the way bundlers and Node do.
 * Without this, `module: "es2015"` alone implies Classic resolution, which finds neither
 * `index` files nor packages.
 */
function withResolution(options: ts.CompilerOptions): ts.CompilerOptions {
  if (options.moduleResolution !== undefined) return options;
  if (options.module === undefined) {
    return {
      ...options,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    };
  }
  if (NODE_MODULE_KINDS.has(options.module)) return options;
  return {
    ...options,
    moduleResolution: ES_MODULE_KINDS.has(options.module)
      ? ts.ModuleResolutionKind.Bundler
      : ts.ModuleResolutionKind.Node10,
  };
}

/**
 * Build one TypeScript program per service, reading only files in the inventory.
 *
 * Handles:
 * - `tsconfig.json` (else `jsconfig.json`) in the service folder, including `extends`
 *   chains to other configs in the repo, `paths`, and `baseUrl`.
 * - No config, or an unparseable one: {@link DEFAULT_COMPILER_OPTIONS}, with a
 *   `TSCONFIG_MISSING` or `TSCONFIG_INVALID` warning. Other config errors (such as an
 *   `extends` that names an npm package) are `TSCONFIG_INVALID` warnings; the rest of the
 *   config still applies.
 * - Keys the config leaves unset are filled from the defaults; {@link FORCED_OPTIONS} always win.
 * - No `node_modules`: the host only sees inventory files (which never include
 *   `node_modules`, skipped, or symlinked files) plus TypeScript's own bundled `lib.*.d.ts`.
 *   Package imports therefore stay unresolved here; M1.8 maps workspace packages.
 * - Syntax errors: the file is still parsed (TS recovers), and a `SYNTAX_ERROR` warning
 *   records the first error's line and column and how many more there were.
 *
 * Not handled: `include`/`exclude`/`files` (every source file in the service folder is a
 * root file, so tests and scripts are analyzed too); project `references` (a solution-style
 * `tsconfig.json` contributes only its own options); tsconfigs outside the service folder
 * unless reached through `extends`. Nothing from the repo is ever executed.
 */
export function buildServicePrograms(
  root: string,
  workspace: Workspace,
  inventory: Inventory,
): ServiceProgram[] {
  const rootPath = resolve(root).replaceAll("\\", "/");
  const present = new Set(inventory.files);
  const dirs = new Set<string>([""]);
  for (const file of inventory.files) {
    for (let d = parentDir(file); d !== "" && !dirs.has(d); d = parentDir(d)) dirs.add(d);
  }

  const libFile = ts.getDefaultLibFilePath(DEFAULT_COMPILER_OPTIONS).replaceAll("\\", "/");
  const libDir = parentDir(libFile);
  const isLib = (fileName: string): boolean =>
    fileName.startsWith(`${libDir}/`) &&
    /^lib\.[^/]*\.d\.ts$/.test(fileName.slice(libDir.length + 1));

  const toRepoPath = (fileName: string): string | undefined => {
    const path = fileName.replaceAll("\\", "/");
    if (path === rootPath) return "";
    return path.startsWith(`${rootPath}/`) ? path.slice(rootPath.length + 1) : undefined;
  };
  const toAbsolute = (path: string): string => (path === "" ? rootPath : `${rootPath}/${path}`);
  /** Strip the machine-specific root from diagnostic text so warnings are identical everywhere. */
  const relativize = (text: string): string => text.replaceAll(`${rootPath}/`, "");

  const fileExists = (fileName: string): boolean => {
    const rel = toRepoPath(fileName);
    if (rel !== undefined) return present.has(rel);
    return isLib(fileName) && ts.sys.fileExists(fileName);
  };
  const readFile = (fileName: string): string | undefined => {
    const rel = toRepoPath(fileName);
    if (rel !== undefined) {
      return present.has(rel) ? readFileSync(toAbsolute(rel), "utf8") : undefined;
    }
    return isLib(fileName) ? ts.sys.readFile(fileName) : undefined;
  };
  const directoryExists = (dirName: string): boolean => {
    const rel = toRepoPath(dirName);
    if (rel !== undefined) return dirs.has(rel);
    return dirName.replaceAll("\\", "/") === libDir;
  };

  const host: ts.CompilerHost = {
    fileExists,
    readFile,
    directoryExists,
    getDirectories: () => [],
    realpath: (path) => path,
    getSourceFile(fileName, languageVersionOrOptions) {
      const version =
        typeof languageVersionOrOptions === "object"
          ? languageVersionOrOptions.languageVersion
          : languageVersionOrOptions;
      const cacheKey = `${version}:${fileName}`;
      if (isLib(fileName)) {
        const cached = libCache.get(cacheKey);
        if (cached) return cached;
      }
      const text = readFile(fileName);
      if (text === undefined) return undefined;
      const sourceFile = ts.createSourceFile(fileName, text, languageVersionOrOptions, true);
      if (isLib(fileName)) libCache.set(cacheKey, sourceFile);
      return sourceFile;
    },
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options).replaceAll("\\", "/"),
    getDefaultLibLocation: () => libDir,
    writeFile: () => undefined,
    getCurrentDirectory: () => rootPath,
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };

  const configHost: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: true,
    fileExists,
    readFile,
    // Root files come from the inventory, so `include` globs are never expanded.
    readDirectory: () => [],
  };

  const owned = new Map<string, string[]>();
  for (const file of inventory.sourceFiles) {
    if (!PROGRAM_EXTENSIONS.some((ext) => file.endsWith(ext))) continue;
    const service = serviceForFile(workspace, file);
    if (!service) continue;
    const list = owned.get(service.key);
    if (list) list.push(file);
    else owned.set(service.key, [file]);
  }

  return workspace.packages.map((service) => {
    const rootFiles = owned.get(service.key) ?? [];
    const warnings: AnalysisWarning[] = [];
    const flatten = (message: string | ts.DiagnosticMessageChain): string =>
      relativize(ts.flattenDiagnosticMessageText(message, " "));

    let options: ts.CompilerOptions = DEFAULT_COMPILER_OPTIONS;
    let configFile: string | undefined;
    const configPath = CONFIG_NAMES.map((name) =>
      service.dir === "" ? name : `${service.dir}/${name}`,
    ).find((path) => present.has(path));

    if (configPath === undefined) {
      if (rootFiles.length > 0) {
        warnings.push(
          warn(
            "TSCONFIG_MISSING",
            service.dir,
            "no tsconfig.json or jsconfig.json; using default compiler options",
          ),
        );
      }
    } else {
      const absolute = toAbsolute(configPath);
      const parsedJson = ts.parseConfigFileTextToJson(absolute, readFile(absolute) ?? "");
      if (parsedJson.error) {
        warnings.push(
          warn(
            "TSCONFIG_INVALID",
            configPath,
            `${flatten(parsedJson.error.messageText)}; using default compiler options`,
          ),
        );
      } else {
        const parsed = ts.parseJsonConfigFileContent(
          parsedJson.config,
          configHost,
          parentDir(absolute),
          undefined,
          absolute,
        );
        for (const error of parsed.errors) {
          if (error.code === NO_INPUTS) continue;
          warnings.push(warn("TSCONFIG_INVALID", configPath, flatten(error.messageText)));
        }
        configFile = configPath;
        const merged: ts.CompilerOptions = { ...parsed.options };
        for (const [key, value] of Object.entries(DEFAULT_COMPILER_OPTIONS)) {
          if (merged[key] === undefined && key !== "module" && key !== "moduleResolution") {
            merged[key] = value as ts.CompilerOptionsValue;
          }
        }
        options = withResolution(merged);
      }
    }
    options = { ...options, ...FORCED_OPTIONS };

    const program = ts.createProgram({
      rootNames: rootFiles.map(toAbsolute),
      options,
      host,
    });

    for (const file of rootFiles) {
      const sourceFile = program.getSourceFile(toAbsolute(file));
      if (!sourceFile) continue;
      const diagnostics = program.getSyntacticDiagnostics(sourceFile);
      const first = diagnostics[0];
      if (!first) continue;
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(first.start ?? 0);
      const more = diagnostics.length > 1 ? ` (+${diagnostics.length - 1} more)` : "";
      warnings.push(
        warn(
          "SYNTAX_ERROR",
          file,
          `syntax error at ${line + 1}:${character + 1}: ${flatten(first.messageText)}${more}`,
        ),
      );
    }

    warnings.sort(
      (a, b) =>
        compareStrings(a.file ?? "", b.file ?? "") ||
        compareStrings(a.code, b.code) ||
        compareStrings(a.message, b.message),
    );
    return {
      service,
      program,
      host,
      ...(configFile === undefined ? {} : { configFile }),
      rootFiles,
      warnings,
      toRepoPath,
      toAbsolute,
    };
  });
}

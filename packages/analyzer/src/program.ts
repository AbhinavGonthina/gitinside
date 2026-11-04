import { resolve } from "node:path";
import ts from "typescript";
import { compareStrings, type AnalysisWarning } from "@gitinside/schema";
import {
  createInputLog,
  createRepoFiles,
  programRootFiles,
  type InputLog,
  type RepoFiles,
} from "./inputs.js";
import type { Inventory } from "./inventory.js";
import type { Workspace, WorkspacePackage } from "./workspace.js";

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

/**
 * Used only for {@link ts.DocumentRegistry.getKeyForCompilationSettings}: TypeScript's own
 * key of the options that change how a file is parsed or bound (target, module, JSX, module
 * detection, strictness, …), the one its language service shares source files by.
 */
const settingsKeys = ts.createDocumentRegistry();

/**
 * TypeScript's internal key of the options that change module resolution (`baseUrl`, `paths`
 * with their `pathsBasePath`, `moduleResolution`, conditions, suffixes, …), the one its own
 * resolution cache keys redirected options by. Not in its typings, so checked at first use.
 */
function resolutionKeyOf(options: ts.CompilerOptions): string {
  const internals = ts as unknown as {
    getKeyForCompilerOptions?: (options: ts.CompilerOptions, declarations: unknown) => string;
    moduleResolutionOptionDeclarations?: unknown;
  };
  const { getKeyForCompilerOptions, moduleResolutionOptionDeclarations } = internals;
  if (
    typeof getKeyForCompilerOptions !== "function" ||
    !Array.isArray(moduleResolutionOptionDeclarations)
  ) {
    throw new Error("this TypeScript version has no module-resolution options key");
  }
  return getKeyForCompilerOptions(options, moduleResolutionOptionDeclarations);
}

/** Where an {@link InputLog}'s answers go: the service's log, or a resolution's probe list. */
type InputSink = Pick<InputLog, "read" | "probeFile" | "probeDir">;

/** One repo read or probe made while resolving a module, replayed into each asking service. */
type Probe =
  | readonly ["read", path: string, hash: string]
  | readonly ["file", path: string, exists: boolean]
  | readonly ["dir", path: string, exists: boolean];

/** A shared module resolution and the repo reads and probes it made (ADR-0197 amendment). */
interface Resolution {
  readonly result: ts.ResolvedModuleWithFailedLookupLocations;
  readonly probes: readonly Probe[];
}

/**
 * A TypeScript program for one service. It is parsed on first use of {@link program},
 * {@link host}, {@link configFile}, or {@link warnings} (ADR-0177), so a run that reuses a
 * service's cached facts parses it only if another service's analysis needs it.
 */
export interface ServiceProgram {
  /** The service this program belongs to. */
  readonly service: WorkspacePackage;
  /** The program. Root files are the service's source files; imports may pull in others. */
  readonly program: ts.Program;
  /**
   * The inventory-backed host, for reading repo files in later passes (modules resolve through
   * {@link resolveModule}). Every repo path it reads or probes is recorded in {@link inputs},
   * so later passes must reach repo files through it.
   */
  readonly host: ts.CompilerHost;
  /**
   * Resolve `specifier` from `containingFile` (absolute) as this program does, through the
   * run's shared resolutions (ADR-0197 amendment): the reads and probes the resolution made
   * are recorded in {@link inputs} whether it was resolved now or for another service.
   */
  resolveModule(
    specifier: string,
    containingFile: string,
    mode?: ts.ResolutionMode,
  ): ts.ResolvedModuleWithFailedLookupLocations;
  /** What this service's program and host observed of the repo so far (ADR-0090). */
  readonly inputs: InputLog;
  /** Repo-relative path of the config used, or undefined when defaults were synthesized. */
  readonly configFile: string | undefined;
  /** Repo-relative source files owned by this service, sorted. */
  readonly rootFiles: string[];
  /** Config problems and syntax errors, sorted by file, code, message. */
  readonly warnings: AnalysisWarning[];
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
 * Build one TypeScript program per service, reading only files in the inventory, through
 * `files` (shared with the rest of the run, so programs that load one file share its text).
 * Each is parsed on first use (see {@link ServiceProgram}); reading every `program` builds
 * them all. Programs whose options parse and bind a file alike share its `SourceFile`
 * (ADR-0197), so a file several services reach is parsed once; each still records its read.
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
  files: RepoFiles = createRepoFiles(root),
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

  /**
   * Repo files parsed so far in this run, shared by every program that parses a file alike
   * (ADR-0197): keyed by the program's settings key, the parse options TypeScript hands the
   * host, the content hash, and the file name. TypeScript's language service shares source
   * files between projects by the same key, so their checkers can bind and query one copy.
   */
  const parsedFiles = new Map<string, ts.SourceFile>();

  /**
   * Module resolutions made so far in this run, shared by every program with the same
   * {@link resolutionKeyOf} key (ADR-0197 amendment): keyed by that key, the resolution mode,
   * the containing folder (TypeScript resolves from the folder, and caches per folder too),
   * and the specifier. Each keeps its reads and probes, which every asking service records.
   */
  const resolutions = new Map<string, Resolution>();

  /**
   * The inventory's answers to TypeScript's file questions (plus its own libs), each repo path
   * read or probed recorded in `sink`.
   */
  const repoAnswers = (sink: InputSink) => {
    const fileExists = (fileName: string): boolean => {
      const rel = toRepoPath(fileName);
      if (rel === undefined) return isLib(fileName) && ts.sys.fileExists(fileName);
      const exists = present.has(rel);
      sink.probeFile(rel, exists);
      return exists;
    };
    /** A repo file's text and hash, recorded as read, or undefined (recorded as absent). */
    const readRepoFile = (rel: string): { text: string; hash: string } | undefined => {
      if (!present.has(rel)) {
        sink.probeFile(rel, false);
        return undefined;
      }
      const read = files.read(rel);
      sink.read(rel, read.hash);
      return read;
    };
    const readFile = (fileName: string): string | undefined => {
      const rel = toRepoPath(fileName);
      if (rel === undefined) return isLib(fileName) ? ts.sys.readFile(fileName) : undefined;
      return readRepoFile(rel)?.text;
    };
    const directoryExists = (dirName: string): boolean => {
      const rel = toRepoPath(dirName);
      if (rel === undefined) return dirName.replaceAll("\\", "/") === libDir;
      const exists = dirs.has(rel);
      sink.probeDir(rel, exists);
      return exists;
    };
    return { fileExists, readRepoFile, readFile, directoryExists };
  };

  /**
   * `specifier` resolved from `containingFile` with `options` (whose {@link resolutionKeyOf}
   * key is `key`), from {@link resolutions} or resolved now, its probes recorded in `inputs`
   * unless `recorded` (the resolutions already in `inputs`) has it. A miss resolves without
   * TypeScript's cache, so its probe list is complete.
   */
  const resolveShared = (
    inputs: InputLog,
    recorded: Set<Resolution>,
    options: ts.CompilerOptions,
    key: string,
    specifier: string,
    containingFile: string,
    mode: ts.ResolutionMode,
  ): ts.ResolvedModuleWithFailedLookupLocations => {
    const cacheKey = `${key}\0${mode ?? ""}\0${parentDir(containingFile)}\0${specifier}`;
    let resolution = resolutions.get(cacheKey);
    if (!resolution) {
      const probes: Probe[] = [];
      const answers = repoAnswers({
        read: (path, hash) => probes.push(["read", path, hash]),
        probeFile: (path, exists) => probes.push(["file", path, exists]),
        probeDir: (path, exists) => probes.push(["dir", path, exists]),
      });
      const host: ts.ModuleResolutionHost = {
        fileExists: answers.fileExists,
        readFile: answers.readFile,
        directoryExists: answers.directoryExists,
        getDirectories: () => [],
        realpath: (path) => path,
        getCurrentDirectory: () => rootPath,
        useCaseSensitiveFileNames: true,
      };
      const result = ts.resolveModuleName(
        specifier,
        containingFile,
        options,
        host,
        undefined,
        undefined,
        mode,
      );
      resolution = { result, probes };
      resolutions.set(cacheKey, resolution);
    }
    if (recorded.has(resolution)) return resolution.result;
    recorded.add(resolution);
    for (const probe of resolution.probes) {
      if (probe[0] === "read") inputs.read(probe[1], probe[2]);
      else if (probe[0] === "file") inputs.probeFile(probe[1], probe[2]);
      else inputs.probeDir(probe[1], probe[2]);
    }
    return resolution.result;
  };

  /**
   * A host for one service. It answers from the inventory (plus TypeScript's own libs) and
   * records every repo path it reads or probes in `inputs`, the service's observed inputs.
   * `settingsKey` is the program's {@link settingsKeys} key, known once its options are, and
   * `resolve` its {@link ServiceProgram.resolveModule}, which its imports resolve through.
   */
  const createHost = (
    inputs: InputLog,
    settingsKey: () => string,
    resolve: ServiceProgram["resolveModule"],
  ): { host: ts.CompilerHost; configHost: ts.ParseConfigHost } => {
    const { fileExists, readRepoFile, readFile, directoryExists } = repoAnswers(inputs);

    const host: ts.CompilerHost = {
      fileExists,
      readFile,
      directoryExists,
      getDirectories: () => [],
      realpath: (path) => path,
      // As TypeScript's default loader does, minus its cache (no project references here).
      resolveModuleNameLiterals: (literals, containingFile, _redirect, options, sourceFile) =>
        literals.map((literal) =>
          resolve(
            literal.text,
            containingFile,
            ts.getModeForUsageLocation(sourceFile, literal, options),
          ),
        ),
      getSourceFile(fileName, languageVersionOrOptions) {
        const version =
          typeof languageVersionOrOptions === "object"
            ? languageVersionOrOptions.languageVersion
            : languageVersionOrOptions;
        const rel = toRepoPath(fileName);
        if (rel === undefined) {
          if (!isLib(fileName)) return undefined;
          const cacheKey = `${version}:${fileName}`;
          const cached = libCache.get(cacheKey);
          if (cached) return cached;
          const text = ts.sys.readFile(fileName);
          if (text === undefined) return undefined;
          const sourceFile = ts.createSourceFile(fileName, text, languageVersionOrOptions, true);
          libCache.set(cacheKey, sourceFile);
          return sourceFile;
        }
        // Read (and recorded) for every program, even when the parse is shared.
        const read = readRepoFile(rel);
        if (read === undefined) return undefined;
        const format =
          typeof languageVersionOrOptions === "object"
            ? `${languageVersionOrOptions.impliedNodeFormat ?? ""}:${languageVersionOrOptions.jsDocParsingMode ?? ""}`
            : "";
        const key = `${settingsKey()}\0${version}:${format}\0${read.hash}\0${fileName}`;
        const cached = parsedFiles.get(key);
        if (cached) return cached;
        const sourceFile = ts.createSourceFile(fileName, read.text, languageVersionOrOptions, true);
        parsedFiles.set(key, sourceFile);
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
    return { host, configHost };
  };

  const owned = programRootFiles(workspace, inventory.sourceFiles);

  /** Parse `service`'s program, recording what it reads in `inputs`. */
  const build = (
    service: WorkspacePackage,
    rootFiles: string[],
    inputs: InputLog,
  ): Pick<ServiceProgram, "program" | "host" | "resolveModule" | "configFile" | "warnings"> => {
    /** Set once the options are final, before the program parses or resolves anything. */
    const settings: { key?: string; options?: ts.CompilerOptions; resolutionKey?: string } = {};
    const recorded = new Set<Resolution>();
    const resolveModule: ServiceProgram["resolveModule"] = (specifier, containingFile, mode) => {
      if (settings.options === undefined || settings.resolutionKey === undefined)
        throw new Error("a module was resolved before its options");
      return resolveShared(
        inputs,
        recorded,
        settings.options,
        settings.resolutionKey,
        specifier,
        containingFile,
        mode,
      );
    };
    const { host, configHost } = createHost(
      inputs,
      () => {
        if (settings.key === undefined)
          throw new Error("a source file was parsed before its options");
        return settings.key;
      },
      resolveModule,
    );
    const warnings: AnalysisWarning[] = [];
    const flatten = (message: string | ts.DiagnosticMessageChain): string =>
      relativize(ts.flattenDiagnosticMessageText(message, " "));

    let options: ts.CompilerOptions = DEFAULT_COMPILER_OPTIONS;
    let configFile: string | undefined;
    // Probed through the host, so a config added later invalidates the service.
    const configPath = CONFIG_NAMES.map((name) =>
      service.dir === "" ? name : `${service.dir}/${name}`,
    ).find((path) => host.fileExists(toAbsolute(path)));

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
      const parsedJson = ts.parseConfigFileTextToJson(absolute, host.readFile(absolute) ?? "");
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
    // TypeScript's key ends with `pathsBasePath` (it also keys module resolution), which only
    // changes how `paths` resolve, never a parse; left in, each config with `paths` parsed alone.
    settings.key = settingsKeys.getKeyForCompilationSettings({
      ...options,
      pathsBasePath: undefined,
    });
    settings.options = options;
    settings.resolutionKey = resolutionKeyOf(options);

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
    return { program, host, resolveModule, configFile, warnings };
  };

  return workspace.packages.map((service): ServiceProgram => {
    const rootFiles = owned.get(service.key) ?? [];
    const inputs = createInputLog(service.key, rootFiles);
    let built: ReturnType<typeof build> | undefined;
    const parsed = () => (built ??= build(service, rootFiles, inputs));
    return {
      service,
      inputs,
      rootFiles,
      toRepoPath,
      toAbsolute,
      get program() {
        return parsed().program;
      },
      get host() {
        return parsed().host;
      },
      resolveModule(specifier, containingFile, mode) {
        return parsed().resolveModule(specifier, containingFile, mode);
      },
      get configFile() {
        return parsed().configFile;
      },
      get warnings() {
        return parsed().warnings;
      },
    };
  });
}

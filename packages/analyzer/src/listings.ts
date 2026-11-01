/**
 * Folder listings read from the repo instead of run (ADR-0162): what `fs.readdirSync(dir)` or
 * `glob.sync(pattern, { cwd })` would return, computed from a service's own root files, and
 * which of those files a `require` of a listed path loads.
 *
 * Paths here are repo-relative POSIX paths. An absolute path in the analyzed code can only
 * come from `__dirname`, which the evaluator writes as {@link REPO_ROOT} followed by the
 * folder (`\0/src/routes`), so a literal `/etc` never matches a repo file.
 *
 * Handled: `readdirSync` (the names directly in the folder, files and folders alike) and glob
 * patterns made of literal characters, `*`, `**`, `?`, and `{a,b}` alternatives (dot files
 * are skipped, as glob does by default). Not handled: character classes, extglobs (`!(…)`,
 * `+(…)`), negation, escapes, and glob options besides `cwd` (an `ignore` list is not
 * applied, so the listing may hold more files than the code's).
 */
import { posix } from "node:path";
import { compareStrings } from "@gitinside/schema";
import { PROGRAM_EXTENSIONS } from "./inputs.js";

/** The marker standing for the repo root in absolute paths (see the file comment). */
export const REPO_ROOT = "\0";

/** The absolute form of a repo folder (`""` is the root). */
export function absoluteFolder(folder: string): string {
  return folder === "" ? `${REPO_ROOT}/` : `${REPO_ROOT}/${folder}`;
}

/** The repo folder an absolute path names, or undefined when it isn't one (or leaves the repo). */
export function repoPathOf(absolute: string): string | undefined {
  // `path.join` drops the slash after the marker when it walks back to the root.
  if (absolute === REPO_ROOT) return "";
  if (!absolute.startsWith(`${REPO_ROOT}/`)) return undefined;
  const rest = absolute.slice(REPO_ROOT.length).replace(/^\/+/, "");
  const normalized = posix.normalize(rest === "" ? "." : rest).replace(/\/+$/, "");
  if (normalized === ".." || normalized.startsWith("../")) return undefined;
  return normalized === "." ? "" : normalized;
}

/** The names `readdirSync` would list in `folder`: the first segment of each file under it. */
export function readdirEntries(folder: string, files: readonly string[]): string[] {
  const prefix = folder === "" ? "" : `${folder}/`;
  const names = new Set<string>();
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    const name = file.slice(prefix.length).split("/")[0];
    if (name) names.add(name);
  }
  return [...names].sort(compareStrings);
}

/** A glob pattern as an anchored regular expression, or undefined when it uses unsupported syntax. */
export function globRegExp(pattern: string): RegExp | undefined {
  let source = "";
  let inBraces = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern.charAt(i);
    if (c === "*") {
      if (pattern.charAt(i + 1) === "*") {
        const slash = pattern.charAt(i + 2) === "/";
        // `**/` is any number of folders (none included); a bare `**` any text.
        source += slash ? "(?:[^/.][^/]*/)*" : ".*";
        i += slash ? 2 : 1;
      } else {
        source += "[^/]*";
      }
    } else if (c === "?") {
      source += "[^/]";
    } else if (c === "{" && !inBraces) {
      inBraces = true;
      source += "(?:";
    } else if (c === "}" && inBraces) {
      inBraces = false;
      source += ")";
    } else if (c === "," && inBraces) {
      source += "|";
    } else if ("[]()!+@\\{}".includes(c)) {
      return undefined;
    } else {
      source += c.replace(/[.^$|]/g, "\\$&");
    }
  }
  return inBraces ? undefined : new RegExp(`^${source}$`);
}

/**
 * The paths `glob.sync(pattern, { cwd: folder })` would return: files under `folder` whose
 * path from it matches, skipping dot files and folders. Undefined for unsupported patterns.
 */
export function globEntries(
  pattern: string,
  folder: string,
  files: readonly string[],
): string[] | undefined {
  const re = globRegExp(pattern.replace(/^\.\//, ""));
  if (!re) return undefined;
  const prefix = folder === "" ? "" : `${folder}/`;
  const found: string[] = [];
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    if (rest.split("/").some((segment) => segment.startsWith("."))) continue;
    if (re.test(rest)) found.push(rest);
  }
  return found.sort(compareStrings);
}

/**
 * The repo file a `require` of `specifier` from `fromFile` loads, among `files`: the path
 * itself, with a program extension, or its folder's `index` file. Relative (`./x`) and
 * absolute ({@link REPO_ROOT}) specifiers only; package names are never repo files here.
 */
export function resolveRequire(
  specifier: string,
  fromFile: string,
  files: ReadonlySet<string>,
): string | undefined {
  let target: string | undefined;
  if (specifier.startsWith(REPO_ROOT)) target = repoPathOf(specifier);
  else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    target = repoPathOf(posix.join(absoluteFolder(posix.dirname(fromFile)), specifier));
  }
  if (target === undefined || target === "") return undefined;
  const candidates = [
    target,
    ...PROGRAM_EXTENSIONS.map((ext) => target + ext),
    ...PROGRAM_EXTENSIONS.map((ext) => `${target}/index${ext}`),
  ];
  return candidates.find((c) => files.has(c));
}

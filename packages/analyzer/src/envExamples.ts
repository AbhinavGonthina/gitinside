/**
 * URL path prefixes from committed example env files (ADR-0202), for the route matcher only.
 *
 * `VITE_SERVER_BASE_URL=http://localhost:5000/api` in `client/.env.example` says requests on
 * that env base go under `/api`. The matcher tries that prefix first (`match.ts`); nothing read
 * here is ever written into the graph (SECURITY.md T5).
 *
 * Patterns handled:
 * - Files named `.env.example`, `.env.sample`, `.env.template`, or `.env.<name>.example` (and
 *   `.sample`, `.template`), in any folder, read with the env parser's line rules
 *   (`readEnvLines` in `infra.ts`).
 * - A value that is an `http://` or `https://` URL or a root-relative path: only its path is
 *   kept. The scheme, host, port, credentials, query, and fragment are dropped at parse time.
 * - The nearest folder above the calling file (its own included) whose example files define
 *   the key decides; a key defined there with no usable path means no prefix.
 *
 * Patterns not handled (no prefix, so the request matches as before):
 * - `.env`, `.env.local`, `.env.development`, `.env.production`, and every other env file:
 *   those hold real values, never read for paths.
 * - A path with more than {@link MAX_PREFIX_SEGMENTS} segments, or a segment that isn't 1–64
 *   characters of `A–Z a–z 0–9 . _ ~ -` (interpolation `${X}`, percent-encoding, a long
 *   token), or is `.` or `..`.
 * - Several different paths for one key in the deciding folder (two example files, or one
 *   key twice): which one the app uses is unknown.
 * - Protocol-relative values (`//host/api`), other schemes, and `KEY: value` lines.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readEnvLines } from "./infra.js";

/** Example env file names, matched against the base name. */
export const EXAMPLE_ENV_FILE = /^\.env(?:\.[\w-]+)?\.(?:example|sample|template)$/;

/** Longest prefix kept, in segments. */
export const MAX_PREFIX_SEGMENTS = 4;

/** A segment a prefix may hold. */
const SEGMENT = /^[A-Za-z0-9._~-]{1,64}$/;

/**
 * The path segments of an env value that is an `http(s)` URL or a root-relative path, `[]`
 * for one with no path, and `undefined` for anything else or a path outside the rules above.
 */
export function urlPathPrefix(value: string): string[] | undefined {
  const trimmed = value.trim();
  let path: string;
  const origin = /^https?:\/\/[^/?#]*/i.exec(trimmed);
  if (origin) path = trimmed.slice(origin[0].length);
  else if (trimmed.startsWith("/") && !trimmed.startsWith("//")) path = trimmed;
  else return undefined;
  const cut = path.search(/[?#]/);
  const segments = (cut < 0 ? path : path.slice(0, cut)).split("/").filter((s) => s !== "");
  if (segments.length > MAX_PREFIX_SEGMENTS) return undefined;
  const ok = segments.every((s) => SEGMENT.test(s) && s !== "." && s !== "..");
  return ok ? segments : undefined;
}

/**
 * The path prefix example env files give the env var `name` for a request in `file`
 * (repo-relative), or `undefined` when they give none.
 */
export type EnvPrefixes = (name: string, file: string) => readonly string[] | undefined;

const dirName = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};

/** Build {@link EnvPrefixes} from example env files' paths and contents. */
export function envPrefixes(files: readonly { file: string; text: string }[]): EnvPrefixes {
  /** Folder ⇒ key ⇒ the paths its example files give it (`""` for none). */
  const byDir = new Map<string, Map<string, Set<string>>>();
  for (const { file, text } of files) {
    const dir = dirName(file);
    const keys = byDir.get(dir) ?? new Map<string, Set<string>>();
    byDir.set(dir, keys);
    readEnvLines(text, (key, _line, _column, value) => {
      const paths = keys.get(key) ?? new Set<string>();
      paths.add(urlPathPrefix(value)?.join("/") ?? "");
      keys.set(key, paths);
    });
  }
  return (name, file) => {
    let dir = dirName(file);
    for (;;) {
      const paths = byDir.get(dir)?.get(name);
      if (paths) {
        const [only] = paths;
        return paths.size === 1 && only ? only.split("/") : undefined;
      }
      if (dir === "") return undefined;
      dir = dirName(dir);
    }
  };
}

/** Read every example env file in the inventory (`files`, repo-relative) under `root`. */
export async function readEnvPrefixes(
  root: string,
  files: readonly string[],
): Promise<EnvPrefixes> {
  const examples = files.filter((f) => EXAMPLE_ENV_FILE.test(f.slice(f.lastIndexOf("/") + 1)));
  const read = await Promise.all(
    examples.map(async (file) => ({ file, text: await readFile(join(root, file), "utf8") })),
  );
  return envPrefixes(read);
}

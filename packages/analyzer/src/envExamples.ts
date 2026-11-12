/**
 * What committed example env files say about an env base's value (ADR-0202, ADR-0265), for
 * the route matcher only.
 *
 * `VITE_SERVER_BASE_URL=http://localhost:5000/api` in `client/.env.example` says requests on
 * that env base go under `/api`. The matcher tries that prefix first (`match.ts`); the path is
 * never written into the graph (SECURITY.md T5). The value's origin (scheme, host, port) is
 * kept too: an SDK client whose env base's example names a host outside the repo
 * (`UPSTREAM_BASE_URL=https://api.openai.com/v1`) calls that host, which the matcher draws as
 * an external API, as the env detector reads hosts (ADR-0265).
 *
 * Patterns handled:
 * - Files named `.env.example`, `.env.sample`, `.env.template`, or `.env.<name>.example` (and
 *   `.sample`, `.template`), in any folder, read with the env parser's line rules
 *   (`readEnvLines` in `infra.ts`).
 * - A value that is an `http://` or `https://` URL or a root-relative path: its path is kept,
 *   `[]` when it has none (`http://localhost:5000`). An `http(s)` URL's origin is kept as the
 *   env detector reads one (`urlAuthority`: lowercased, credentials dropped, a host with a
 *   variable left out). The query and fragment are dropped at parse time.
 * - The nearest folder above the calling file (its own included) whose example files define
 *   the key decides; a key defined there with no usable path means no prefix, and one with no
 *   readable origin means no origin.
 *
 * Patterns not handled (no prefix, so the request matches as before):
 * - `.env`, `.env.local`, `.env.development`, `.env.production`, and every other env file:
 *   those hold real values, never read for paths.
 * - A path with more than {@link MAX_PREFIX_SEGMENTS} segments, or a segment that isn't 1–64
 *   characters of `A–Z a–z 0–9 . _ ~ -` (interpolation `${X}`, percent-encoding, a long
 *   token), or is `.` or `..`.
 * - Several different paths for one key in the deciding folder (two example files, or one
 *   key twice): which one the app uses is unknown. Likewise several different origins (no
 *   origin), each part decided on its own: `http://localhost:3000/api` and
 *   `http://localhost:5000/api` still give `/api`.
 * - Protocol-relative values (`//host/api`), other schemes, and `KEY: value` lines.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readEnvLines, urlAuthority } from "./infra.js";

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
 * The scheme and host (with its port, an IPv6 host in brackets) of an `http(s)` URL value,
 * as `urlAuthority` reads it, or `undefined` for anything else or a host it leaves out.
 */
export function urlOrigin(value: string): { scheme: string; host: string } | undefined {
  const authority = urlAuthority(value);
  if (!authority?.host || (authority.scheme !== "http" && authority.scheme !== "https")) {
    return undefined;
  }
  const { scheme, host, port } = authority;
  const name = host.includes(":") ? `[${host}]` : host;
  return { scheme, host: port === undefined ? name : `${name}:${port}` };
}

/** What example env files give an env var's value; at least one part is present. */
export interface EnvExample {
  /** The value's path segments, `[]` for a URL with no path. */
  path?: readonly string[];
  /** The value's scheme and host (with its port), for an `http(s)` URL. */
  origin?: { scheme: string; host: string };
}

/**
 * What example env files give the env var `name` for a request in `file` (repo-relative), or
 * `undefined` when they give nothing usable.
 */
export type EnvExamples = (name: string, file: string) => EnvExample | undefined;

const dirName = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};

/** Marks a value with no usable path, or no readable origin, in the sets below. */
const NONE = "\0";

/** The one value in `values`, or `undefined` when there are several or it is {@link NONE}. */
const single = (values: ReadonlySet<string>): string | undefined => {
  const [only] = values;
  return values.size === 1 && only !== NONE ? only : undefined;
};

/** Build {@link EnvExamples} from example env files' paths and contents. */
export function envExamples(files: readonly { file: string; text: string }[]): EnvExamples {
  /** Folder ⇒ key ⇒ the paths (`""` for none) and origins its example files give it. */
  const byDir = new Map<string, Map<string, { paths: Set<string>; origins: Set<string> }>>();
  for (const { file, text } of files) {
    const dir = dirName(file);
    const keys = byDir.get(dir) ?? new Map<string, { paths: Set<string>; origins: Set<string> }>();
    byDir.set(dir, keys);
    readEnvLines(text, (key, _line, _column, value) => {
      const seen = keys.get(key) ?? { paths: new Set<string>(), origins: new Set<string>() };
      seen.paths.add(urlPathPrefix(value)?.join("/") ?? NONE);
      const origin = urlOrigin(value);
      seen.origins.add(origin ? `${origin.scheme}://${origin.host}` : NONE);
      keys.set(key, seen);
    });
  }
  return (name, file) => {
    let dir = dirName(file);
    for (;;) {
      const seen = byDir.get(dir)?.get(name);
      if (seen) {
        const path = single(seen.paths);
        const origin = single(seen.origins);
        const out: EnvExample = {};
        if (path !== undefined) out.path = path === "" ? [] : path.split("/");
        if (origin !== undefined) {
          const [scheme = "", host = ""] = origin.split("://");
          out.origin = { scheme, host };
        }
        return out.path || out.origin ? out : undefined;
      }
      if (dir === "") return undefined;
      dir = dirName(dir);
    }
  };
}

/** Read every example env file in the inventory (`files`, repo-relative) under `root`. */
export async function readEnvExamples(
  root: string,
  files: readonly string[],
): Promise<EnvExamples> {
  const examples = files.filter((f) => EXAMPLE_ENV_FILE.test(f.slice(f.lastIndexOf("/") + 1)));
  const read = await Promise.all(
    examples.map(async (file) => ({ file, text: await readFile(join(root, file), "utf8") })),
  );
  return envExamples(read);
}

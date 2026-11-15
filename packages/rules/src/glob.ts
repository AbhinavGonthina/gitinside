/**
 * Path and name globs for `.gitinside.yml` (M11.3, ADR-0300), matched in time linear in the text
 * for a given pattern: the pattern is compiled to a small automaton and every possible position is
 * advanced together (a Thompson simulation), so nothing ever backtracks. A hostile pattern such as
 * `*a*a*a*a*b` costs `O(text × pattern)` steps, never exponential (docs/SECURITY.md, ADR-0295).
 *
 * Handles: literal characters, `?` (one character other than `/`), `*` (any run of characters
 * other than `/`), and `**` as a whole path segment: `**` alone matches everything, `**` + `/` (at
 * the start or after a `/`) matches zero or more whole segments, and a trailing `/**` matches
 * everything below the folder (not the folder itself). Doesn't handle, and rejects with a reason:
 * character classes (`[a-z]`), braces (`{a,b}`), negation (`!x`), escapes (`\*`), and `**` inside a
 * segment (`a**`). Matching is case-sensitive, as git's paths are.
 */

/** The longest pattern accepted, in characters. */
export const MAX_GLOB_LENGTH = 256;

type Token =
  | { kind: "char"; char: string }
  /** `?`: one character other than `/`. */
  | { kind: "one" }
  /** `*`: zero or more characters other than `/`. */
  | { kind: "star" }
  /** `**` + `/`: zero or more whole segments, each ending in `/`. */
  | { kind: "dirs" }
  /** `**` at the end: zero or more of any character. */
  | { kind: "rest" };

/** A compiled glob. */
export interface Glob {
  readonly source: string;
  readonly tokens: readonly Token[];
}

/** Thrown by {@link compileGlob} for a pattern it doesn't accept; the message says why. */
export class GlobError extends Error {
  constructor(
    readonly pattern: string,
    message: string,
  ) {
    super(message);
    this.name = "GlobError";
  }
}

/** Compiles a pattern, or throws {@link GlobError} saying what's wrong with it. */
export function compileGlob(pattern: string): Glob {
  const fail = (why: string): never => {
    throw new GlobError(pattern, why);
  };
  if (pattern.length === 0) fail("a glob can't be empty");
  if (pattern.length > MAX_GLOB_LENGTH)
    fail(`a glob can be at most ${MAX_GLOB_LENGTH} characters long`);
  if (pattern.startsWith("!")) fail("negated globs (`!`) aren't supported");
  const tokens: Token[] = [];
  let i = 0;
  while (i < pattern.length) {
    const c = pattern.charAt(i);
    if (c === "[" || c === "]") fail("character classes (`[...]`) aren't supported");
    if (c === "{" || c === "}") fail("braces (`{a,b}`) aren't supported");
    if (c === "\\") fail("escapes (`\\`) aren't supported; paths use `/`");
    if (c === "*" && pattern.charAt(i + 1) === "*") {
      const segmentStart = i === 0 || pattern.charAt(i - 1) === "/";
      const after = pattern.charAt(i + 2);
      if (!segmentStart || (after !== "" && after !== "/"))
        fail("`**` must be a whole path segment, like `src/**/x.ts` or `src/**`");
      if (after === "/") {
        tokens.push({ kind: "dirs" });
        i += 3;
      } else {
        tokens.push({ kind: "rest" });
        i += 2;
      }
      continue;
    }
    if (c === "*") tokens.push({ kind: "star" });
    else if (c === "?") tokens.push({ kind: "one" });
    else tokens.push({ kind: "char", char: c });
    i += 1;
  }
  return { source: pattern, tokens };
}

/**
 * Whether `text` matches the whole of `glob`. States are token positions, plus, for a `dirs`
 * token, "inside a segment it's skipping"; each character advances every live state at once.
 */
export function matchGlob(glob: Glob, text: string): boolean {
  const { tokens } = glob;
  const n = tokens.length;
  // at[i]: about to match token i (i = n: matched everything). inDirs[i]: inside a segment that
  // token i (a `dirs`) is skipping, waiting for its `/`.
  let at = new Uint8Array(n + 1);
  let inDirs = new Uint8Array(n + 1);
  let next = new Uint8Array(n + 1);
  let nextInDirs = new Uint8Array(n + 1);

  /** Marks token `i` live, and every later one reachable without a character. */
  const enter = (states: Uint8Array, i: number): void => {
    let j = i;
    while (j <= n && states[j] === 0) {
      states[j] = 1;
      const token = tokens[j];
      if (token === undefined || token.kind === "char" || token.kind === "one") break;
      j += 1;
    }
  };

  enter(at, 0);
  for (let p = 0; p < text.length; p += 1) {
    const c = text.charAt(p);
    next.fill(0);
    nextInDirs.fill(0);
    let live = false;
    for (let i = 0; i < n; i += 1) {
      const token = tokens[i] as Token;
      if (inDirs[i] === 1) {
        // Inside a skipped segment: keep skipping, and a `/` may end it.
        nextInDirs[i] = 1;
        live = true;
        if (c === "/") enter(next, i + 1);
      }
      if (at[i] === 0) continue;
      switch (token.kind) {
        case "char":
          if (token.char === c) {
            enter(next, i + 1);
            live = true;
          }
          break;
        case "one":
          if (c !== "/") {
            enter(next, i + 1);
            live = true;
          }
          break;
        case "star":
          if (c !== "/") {
            enter(next, i);
            live = true;
          }
          break;
        case "rest":
          enter(next, i);
          live = true;
          break;
        case "dirs":
          live = true;
          if (c === "/") enter(next, i + 1);
          nextInDirs[i] = 1;
          break;
      }
    }
    if (!live) return false;
    [at, next] = [next, at];
    [inDirs, nextInDirs] = [nextInDirs, inDirs];
  }
  return at[n] === 1;
}

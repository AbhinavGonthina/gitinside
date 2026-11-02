/**
 * Linear-time glob matching for patterns read from untrusted repos (workspace globs and
 * folder listings). A backtracking RegExp built from a glob is exponential on patterns like
 * `**a**a…**b`, so patterns are matched by dynamic programming instead, and a pattern beyond
 * {@link MAX_PATTERN_LENGTH} characters or {@link MAX_BRACE_ALTERNATIVES} brace alternatives
 * is refused rather than allowed to blow up time or memory.
 *
 * Handled: literal characters, `*` (within one segment), `**\/` (any number of whole
 * segments, including none), `**` elsewhere (any characters), `?` (one character other than
 * `/`), and `{a,b}` braces (nested braces expand innermost first). Every other character is
 * literal; callers refuse syntax they don't support before compiling.
 */
import { compareStrings } from "@gitinside/schema";

/** The longest pattern compiled. */
export const MAX_PATTERN_LENGTH = 1024;
/** The most alternatives a pattern's braces may expand to. */
export const MAX_BRACE_ALTERNATIVES = 256;

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
 * Compile a glob into a whole-path matcher, or undefined when it's over
 * {@link MAX_PATTERN_LENGTH} characters or expands to more than
 * {@link MAX_BRACE_ALTERNATIVES} alternatives. Matching is linear in the path length for
 * each alternative, so hostile patterns can't stall it.
 */
export function globMatcher(pattern: string): ((path: string) => boolean) | undefined {
  if (pattern.length > MAX_PATTERN_LENGTH) return undefined;
  const alternatives = expandBraces(pattern)?.map(tokenize);
  if (!alternatives) return undefined;
  return (path) => alternatives.some((tokens) => matchTokens(tokens, path));
}

/**
 * The route path grammar shared by the analyzer's route matcher (M2.4) and the diff's
 * re-resolution of broken calls (M6.4, ADR-0087): a route node's `path` parsed into
 * segments, and a call's path segments aligned against them. Pure, so it runs in browsers.
 */

/** A piece of a call's path segment: literal text, or a hole (`{}`, any runtime value). */
export type UrlSegmentPart = { kind: "text"; text: string } | { kind: "hole" };

/** One path segment of a call: never empty, never containing `/`. */
export type UrlSegment = UrlSegmentPart[];

/** One segment of a route path. */
export type RouteSegment =
  | { kind: "literal"; text: string }
  /** `:id`, `:id(\\d+)`; `optional` for `:id?`. */
  | { kind: "param"; optional: boolean }
  /** `*`, `*rest`, `:p*` (zero or more segments) and `:p+` (one or more). */
  | { kind: "wildcard"; min: 0 | 1 }
  /** Any other Express pattern syntax: matches one segment, as a possible match. */
  | { kind: "complex" };

/**
 * Levels {@link alignSegments} answers, strongest first; the numbers equal the
 * analyzer's confidence ranks (`exact` 0, `pattern` 1), and `FAIL` can't match.
 */
export const ALIGN = { EXACT: 0, PATTERN: 1, FAIL: Number.POSITIVE_INFINITY } as const;

const { EXACT, PATTERN, FAIL } = ALIGN;

const PARAM = /^:[A-Za-z_$][\w$]*(?:\([^()]*\))?(\?)?$/;
const PARAM_REPEAT = /^:[A-Za-z_$][\w$]*(?:\([^()]*\))?([*+])$/;
const WILDCARD = /^\*[\w$]*$/;
const PATTERN_SYNTAX = /[:*?+()[\]{}]/;

/** Parse a route path (`/api/users/:id`, `/files/*rest`) into segments. Empty segments are dropped. */
export function parseRoutePath(path: string): RouteSegment[] {
  return path
    .split("/")
    .filter((s) => s !== "")
    .map((s): RouteSegment => {
      const param = PARAM.exec(s);
      if (param) return { kind: "param", optional: param[1] === "?" };
      const repeat = PARAM_REPEAT.exec(s);
      if (repeat) return { kind: "wildcard", min: repeat[1] === "+" ? 1 : 0 };
      if (WILDCARD.test(s)) return { kind: "wildcard", min: 0 };
      return PATTERN_SYNTAX.test(s) ? { kind: "complex" } : { kind: "literal", text: s };
    });
}

/** True when a call segment is made only of holes. */
export const isHole = (segment: UrlSegment): boolean => segment.every((p) => p.kind === "hole");

/** True when a call segment is only literal text. */
export const isText = (segment: UrlSegment): boolean => segment.every((p) => p.kind === "text");

/** The text of an all-text call segment. */
export const segmentText = (segment: UrlSegment): string =>
  segment.map((p) => (p.kind === "text" ? p.text : "")).join("");

/**
 * True when a segment with holes can spell `literal`, each hole standing for any text
 * (possibly empty). Greedy leftmost matching of the literal pieces, so linear-ish and never
 * exponential.
 */
function spells(segment: UrlSegment, literal: string): boolean {
  let at = 0;
  let floating = false; // a hole came before the current text part
  for (let i = 0; i < segment.length; i++) {
    const part = segment[i];
    if (!part) continue;
    if (part.kind === "hole") {
      floating = true;
      continue;
    }
    const last = i === segment.length - 1;
    if (!floating) {
      if (!literal.startsWith(part.text, at)) return false;
      at += part.text.length;
    } else if (last) {
      if (literal.length - part.text.length < at || !literal.endsWith(part.text)) return false;
      at = literal.length;
    } else {
      const found = literal.indexOf(part.text, at);
      if (found === -1) return false;
      at = found + part.text.length;
    }
    floating = false;
  }
  return floating || at === literal.length;
}

/** The level at which one call segment matches one single-segment route segment. */
function segmentLevel(segment: UrlSegment, route: RouteSegment): number {
  switch (route.kind) {
    case "literal":
      if (isText(segment)) return segmentText(segment) === route.text ? EXACT : FAIL;
      if (isHole(segment)) return FAIL;
      return spells(segment, route.text) ? PATTERN : FAIL;
    case "param":
      return isHole(segment) ? EXACT : PATTERN;
    case "complex":
    case "wildcard":
      return PATTERN;
  }
}

/**
 * The best level ({@link ALIGN}) at which a call's path segments align with a route's.
 * Dynamic programming over (call segment, route segment), so optional params and
 * wildcards cost O(call × route) rather than backtracking.
 */
export function alignSegments(call: readonly UrlSegment[], route: readonly RouteSegment[]): number {
  const memo = new Map<number, number>();
  const width = route.length + 1;
  const go = (i: number, j: number): number => {
    if (j === route.length) return i === call.length ? EXACT : FAIL;
    const key = i * width + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const r = route[j];
    let best: number = FAIL;
    if (r?.kind === "wildcard") {
      for (let k = r.min; i + k <= call.length; k++) {
        best = Math.min(best, Math.max(PATTERN, go(i + k, j + 1)));
      }
    } else if (r) {
      if (r.kind === "param" && r.optional) best = go(i, j + 1);
      const segment = call[i];
      if (segment) {
        const level = segmentLevel(segment, r);
        if (level !== FAIL) best = Math.min(best, Math.max(level, go(i + 1, j + 1)));
      }
    }
    memo.set(key, best);
    return best;
  };
  return go(0, 0);
}

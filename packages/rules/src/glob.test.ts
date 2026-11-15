import { describe, expect, it } from "vitest";
import { compileGlob, GlobError, matchGlob, MAX_GLOB_LENGTH } from "./glob.js";

const matches = (pattern: string, text: string): boolean => matchGlob(compileGlob(pattern), text);

describe("matchGlob", () => {
  it.each<[string, string, boolean]>([
    ["apps/web/lib/a.ts", "apps/web/lib/a.ts", true],
    ["apps/web/lib/a.ts", "apps/web/lib/b.ts", false],
    ["apps/web/lib/a.ts", "apps/web/lib/a.tsx", false],
    ["apps/*/lib/a.ts", "apps/web/lib/a.ts", true],
    ["apps/*/lib/a.ts", "apps/web/x/lib/a.ts", false],
    ["apps/*", "apps/", true],
    ["*.ts", "a.ts", true],
    ["*.ts", "src/a.ts", false],
    ["?.ts", "a.ts", true],
    ["?.ts", "ab.ts", false],
    ["a?b", "a/b", false],
    ["**", "", true],
    ["**", "any/thing/at/all.ts", true],
    ["**/a.ts", "a.ts", true],
    ["**/a.ts", "x/y/a.ts", true],
    ["**/a.ts", "x/ya.ts", false],
    ["src/**/a.ts", "src/a.ts", true],
    ["src/**/a.ts", "src/x/y/a.ts", true],
    ["src/**/a.ts", "srcx/a.ts", false],
    ["src/**", "src/a/b.ts", true],
    ["src/**", "src", false],
    ["src/**", "other/a.ts", false],
    ["@shop/*", "@shop/web", true],
    ["*.stripe.com", "api.stripe.com", true],
    ["*.stripe.com", "a.b.stripe.com", true],
    ["*.stripe.com", "stripe.com", false],
    ["*a*b", "xaxxb", true],
    ["*a*b", "xaxxbc", false],
  ])("%s on %s is %s", (pattern, text, expected) => {
    expect(matches(pattern, text)).toBe(expected);
  });

  it("agrees with an equivalent regular expression on 3,000 seeded random cases", () => {
    // A small LCG, so the cases are the same on every run.
    let seed = 20261115;
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const pieces = ["a", "b", "/", "*", "?", "**/", "a/", "b/"];
    const letters = ["a", "b", "/"];
    let checked = 0;
    for (let i = 0; i < 3000; i += 1) {
      let pattern = "";
      for (let k = 1 + next(6); k > 0; k -= 1) pattern += pieces[next(pieces.length)];
      if (next(4) === 0) pattern += pattern.endsWith("/") || pattern === "" ? "**" : "/**";
      let glob;
      try {
        glob = compileGlob(pattern);
      } catch {
        continue; // e.g. `***`: not a glob, so nothing to compare
      }
      let text = "";
      for (let k = next(9); k > 0; k -= 1) text += letters[next(letters.length)];
      expect(matchGlob(glob, text), `${pattern} on ${text}`).toBe(reference(pattern).test(text));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(2000);
  });

  it("takes linear time on a pattern that makes a backtracking matcher exponential", () => {
    // A backtracking matcher tries every way of splitting 20,000 `a`s among 12 stars before
    // failing on the missing `b` (about C(20000, 12) ways); this one makes one pass.
    const pattern = `${"*a".repeat(12)}*b`;
    const text = "a".repeat(20_000);
    expect(matches(pattern, text)).toBe(false);
    expect(matches(pattern, `${text}b`)).toBe(true);
  });
});

/** The glob as a JavaScript regex, built independently of `compileGlob`'s automaton. */
function reference(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; ) {
    if (pattern.startsWith("**/", i)) {
      source += "(?:.*/)?";
      i += 3;
    } else if (pattern.startsWith("**", i)) {
      source += ".*";
      i += 2;
    } else {
      const c = pattern.charAt(i);
      source += c === "*" ? "[^/]*" : c === "?" ? "[^/]" : c;
      i += 1;
    }
  }
  return new RegExp(`^${source}$`, "s");
}

describe("compileGlob", () => {
  it.each<[string, RegExp]>([
    ["", /empty/],
    ["!src/**", /negated/],
    ["src/[ab].ts", /character classes/],
    ["src/{a,b}.ts", /braces/],
    ["src\\a.ts", /escapes/],
    ["src/a**", /whole path segment/],
    ["**a", /whole path segment/],
    ["src/***", /whole path segment/],
    ["x".repeat(MAX_GLOB_LENGTH + 1), /at most 256/],
  ])("rejects %j", (pattern, why) => {
    expect(() => compileGlob(pattern)).toThrow(GlobError);
    expect(() => compileGlob(pattern)).toThrow(why);
  });

  it("accepts a pattern of exactly the longest length", () => {
    expect(() => compileGlob("x".repeat(MAX_GLOB_LENGTH))).not.toThrow();
  });
});
